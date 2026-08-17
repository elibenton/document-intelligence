/**
 * Rename pass — the recordings-only path.
 *
 * Uploads arrive named whatever the scanner or download folder called them
 * ("SKM_C224e24081215120.pdf"), so a real title has to be written from what the
 * document turns out to be. For documents that is now a field on the Analyze
 * response itself (`display_title` — see TITLE_RULE in analyzePrompt.ts), which
 * removed a second Interfaze call over an excerpt Analyze already had in full.
 *
 * **Recordings skip the metadata pass entirely** (`processingNode.ts`), so there
 * is no Analyze response to carry a title for them. This standalone call is
 * their only route to one, and is scheduled after `transcribe`. Deleting it
 * would leave every recording showing its raw filename.
 *
 * The Interfaze call lives here under "use node" (the SDK needs the Node
 * runtime); `normalizeTitle` and the persistence helper stay in rename.ts on
 * the default runtime, because metadata.ts needs them too and cannot import a
 * value from a "use node" module.
 */

import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { chatCompletion } from "./interfaze";
import { usageLogger } from "./apiLogs";
import { normalizeTitle } from "./rename";
import type { Id } from "./_generated/dataModel";

/**
 * Hard cap so a runaway title can't push the layout around. The prompt asks
 * for under 60; this is the backstop, not the target — a title that hits it
 * has already ignored the instruction.
 */

/** How much page/transcript text to hand the model as extra grounding. */
const MAX_CONTEXT_CHARS = 4000;

/** Pages read for that excerpt — a title is decided by the opening, not p.400. */
const EXCERPT_PAGES = 3;

const RENAME_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description:
        "Unique identifier first, document type second. Under 60 characters. No date, no year. Title Case, no file extension, no quotes, no trailing period.",
    },
  },
  required: ["title"],
};

/**
 * The naming rule: unique element first, type second, nothing else.
 *
 * These titles are read in a dense list, one line each, next to a type pill
 * and a date column. That layout decides the rule. Anything the neighbouring
 * columns already say is wasted width — which is why the date is banned
 * outright rather than merely discouraged, and why the type goes last: the
 * reader is scanning the left edge for the thing they are looking for, and
 * every title that opens with "Complaint" pushes that thing further right.
 */
const SYSTEM_PROMPT = [
  "You name documents for an investigative research library.",
  "Every title has exactly two parts, in this order: the unique thing the document concerns, then what the document is.",
  "Lead with the specific identifier a reader would recognize and search for — the case name, the parties, the address, the person, the organization, the event. Follow it with the document's type: the specific type when it has one, the general type otherwise.",
  'Examples: "Roe v. SFB Management Complaint", "1240 Mission St Conditional Use Permit", "Hernandez Deposition Transcript", "SFMTA Board Minutes".',
  "Keep it short. Under 60 characters, and shorter whenever the document allows. No subtitle, no second clause after a comma or colon, no summary of what is inside.",
  "Never put a date or a year in a title, in any form. The library shows the document's date in its own column, so a date in the title is duplicated noise.",
  "Prefer a case or matter name over a docket or file number. Use a number only when there is no name to use.",
  "Use only the facts given to you. Never invent parties, places, or identifiers. When the unique element is genuinely not established, name the document by its type alone rather than guessing at one.",
  "Title Case. No file extension, no quotes, no trailing period. Do not describe the file format, and do not restate the original filename when it is meaningless (scanner codes, hashes, IMG_1234).",
].join(" ");

interface DocumentMetadata {
  title?: string;
  summary?: string;
  date?: string;
  author?: string;
  language?: string;
  additional?: Array<{ key?: string; value?: string }>;
}

/**
 * Write `displayName` for one document. Shared by the pipeline's internal
 * action and the public manual re-run so neither has to call the other
 * (an action calling an action would burn a second action slot for nothing).
 */
async function renamePass(ctx: ActionCtx, documentId: Id<"documents">) {
  const document = await ctx.runQuery(internal.documents.getInternal, { id: documentId });
  if (!document) return;

  const apiKey = process.env.INTERFAZE_API_KEY;
  if (!apiKey) return;

  let meta: DocumentMetadata = {};
  if (document.metadata) {
    try {
      meta = JSON.parse(document.metadata) as DocumentMetadata;
    } catch {
      // Unparseable metadata — fall back to the page text below.
    }
  }

  // Extra grounding: the opening text (a PDF's first pages, or the start of a
  // recording's transcript). Absent while parse is still in flight, which is
  // fine — the metadata context is what carries this call.
  const pages = await ctx.runQuery(internal.pages.openingTextByDocument, {
    documentId,
    pageCount: EXCERPT_PAGES,
  });
  const excerpt = pages
    .map((p) => p.text)
    .join("\n\n")
    .slice(0, MAX_CONTEXT_CHARS)
    .trim();

  const facts: string[] = [`Original filename: ${document.name}`];
  if (document.primaryKind) facts.push(`Document kind: ${document.primaryKind}`);
  if (meta.title) facts.push(`Title as written in the document: ${meta.title}`);
  // The date is deliberately withheld. Titles must not carry one, and the
  // surest way to keep a date out of the output is to keep it out of the
  // input — an instruction not to use a fact competes with the fact itself.
  if (meta.author && meta.author !== "Unknown") {
    facts.push(`Author: ${meta.author}`);
  }
  if (meta.summary) facts.push(`Summary: ${meta.summary}`);
  for (const item of meta.additional ?? []) {
    if (item.key?.trim() && item.value?.trim()) {
      facts.push(`${item.key.trim()}: ${item.value.trim()}`);
    }
  }
  if (document.tags?.length) facts.push(`Tags: ${document.tags.join(", ")}`);
  if (document.sourceUrl) facts.push(`Source URL: ${document.sourceUrl}`);

  // Nothing but a filename to go on — the metadata pass hasn't produced any
  // context yet, and renaming off the filename alone is the thing this avoids.
  if (facts.length === 1 && !excerpt) return;

  try {
    const { content } = await chatCompletion(apiKey, {
      usage: {
        log: usageLogger(ctx, { documentId }),
        operation: "rename",
      },
      systemPrompt: SYSTEM_PROMPT,
      content: [
        {
          type: "text",
          text: `What is known about this document:\n\n${facts.join("\n")}${
            excerpt ? `\n\nOpening text:\n"""\n${excerpt}\n"""` : ""
          }\n\nWrite the title.`,
        },
      ],
      responseSchema: { name: "document_title", schema: RENAME_SCHEMA },
      maxTokens: 256,
    });

    let title: string;
    try {
      title = normalizeTitle(
        (JSON.parse(content) as { title?: string }).title ?? ""
      );
    } catch {
      return; // non-JSON response — keep the filename
    }
    if (!title) return;

    await ctx.runMutation(internal.rename.saveDisplayName, {
      documentId,
      displayName: title,
    });
  } catch (e) {
    // A missing nicer title is cosmetic — never fail a document over it.
    console.error(
      `Rename pass failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/** Pipeline hook: scheduled once the metadata (or transcribe) pass lands. */
export const runRenamePass = internalAction({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    await renamePass(ctx, args.documentId);
  },
});

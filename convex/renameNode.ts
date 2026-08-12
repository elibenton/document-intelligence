"use node";

/**
 * Rename pass — Node-runtime half.
 *
 * Uploads arrive named whatever the scanner or download folder called them
 * ("SKM_C224e24081215120.pdf"). Once the metadata pass has established what the
 * document IS, that context is enough to write a real title, so this runs
 * immediately after it. The result lands in `documents.displayName`; the
 * uploaded `name` is never touched.
 *
 * The Interfaze call lives here under "use node" (the SDK needs the Node
 * runtime); the mutation that persists the title (saveDisplayName) stays in
 * rename.ts on the default runtime.
 */

import { internalAction, action } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { chatCompletion } from "./interfaze";
import { usageLogger } from "./apiLogs";
import type { Id } from "./_generated/dataModel";

/** Hard cap so a runaway title can't push the layout around. */
const MAX_TITLE_CHARS = 90;

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
        "A short, specific, human-readable title for this document (under 80 characters). Title Case, no file extension, no quotes, no trailing period.",
    },
  },
  required: ["title"],
};

const SYSTEM_PROMPT = [
  "You name documents for an investigative research library.",
  "A good title says what the document is and who or what it concerns, so a reader scanning a list knows whether to open it.",
  "Lead with the document type or the specific matter, add the distinguishing detail (party, case number, date, subject), and stop.",
  "Use only facts given to you. Never invent names, dates, or case numbers.",
  "Do not describe the file format, do not include a file extension, and do not restate the original filename when it is meaningless (scanner codes, hashes, IMG_1234).",
].join(" ");

interface DocumentMetadata {
  title?: string;
  summary?: string;
  date?: string;
  author?: string;
  language?: string;
  additional?: Array<{ key?: string; value?: string }>;
}

/** Clean up the model's answer into something safe to render as a title. */
function normalizeTitle(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, " ")
    .replace(/^["'\s]+|["'\s.]+$/g, "")
    .trim();
  return cleaned.length > MAX_TITLE_CHARS
    ? `${cleaned.slice(0, MAX_TITLE_CHARS).trimEnd()}…`
    : cleaned;
}

/**
 * Write `displayName` for one document. Shared by the pipeline's internal
 * action and the public manual re-run so neither has to call the other
 * (an action calling an action would burn a second action slot for nothing).
 */
async function renamePass(ctx: ActionCtx, documentId: Id<"documents">) {
  const document = await ctx.runQuery(api.documents.get, { id: documentId });
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
  if (meta.date && meta.date !== "Unknown") facts.push(`Date: ${meta.date}`);
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

/** Manual re-run — also the way documents uploaded before this pass get a title. */
export const runRename = action({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    await renamePass(ctx, args.documentId);
  },
});

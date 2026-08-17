/**
 * Rename pass — default-runtime half.
 *
 * `display_title` now comes back from the Analyze call itself
 * (see TITLE_RULE in convex/analyzePrompt.ts), so the title arrives on the same
 * response as the kind it is built from. Recordings still take the standalone
 * Interfaze path in renameNode.ts: they skip the metadata pass entirely, so
 * there is no Analyze response to carry a title for them.
 *
 * `normalizeTitle` lives here rather than in renameNode.ts because both callers
 * need it and metadata.ts runs on the default runtime — importing a *value*
 * from a "use node" module would break at deploy.
 *
 * The result lands in `documents.displayName`. The uploaded `name` is never
 * touched: it's provenance, it's what the user recognizes in their own
 * filesystem, and the UI keeps showing it underneath the new title.
 */

import { internalMutation, internalAction } from "./_generated/server";
import type { MutationCtx, ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { chatCompletion } from "./interfaze";
import { usageLogger } from "./apiLogs";

const MAX_TITLE_CHARS = 70;

const MONTH_WORD =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

/**
 * Date-shaped fragments, removed from a title wherever they appear.
 *
 * The prompt forbids dates; this is the enforcement. Both are needed — the
 * instruction because a title built around a date reads badly even before it
 * is stripped, and the strip because a single leaked date in a column of
 * dateless titles is exactly the ragged edge the rule exists to prevent.
 *
 * Deliberately narrow. A bare four-digit number is left alone: "1240 Mission
 * St" and "Fund 2000" are not dates, and there is no way to tell a stray year
 * from a street number without understanding the title. Only years wearing
 * date clothing — bracketed, or attached to a month or a separator — go.
 */
const DATE_FRAGMENTS: RegExp[] = [
  // Bracketed or parenthesized: "(2019)", "[03/14/2019]"
  /[([][^)\]]*\b(?:19|20)\d{2}\b[^)\]]*[)\]]/gi,
  // Numeric: "03/14/2019", "3-14-19", "2019-03-14"
  /\b\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}\b/g,
  // Written, with or without a day: "March 14, 2019", "14 March 2019", "Mar 2019"
  new RegExp(
    `\\b(?:\\d{1,2}\\s+)?${MONTH_WORD}\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?(?:19|20)\\d{2}\\b`,
    "gi"
  ),
  // A month name qualifying nothing else: "Minutes of March 14"
  new RegExp(`\\b${MONTH_WORD}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"),
  // A year hanging off a separator: "Complaint - 2019", "Minutes, 2019"
  /\s*[-–—,:]\s*(?:19|20)\d{2}\b/g,
];

/** Separators and empty brackets left behind once a date is cut out. */
function tidyPunctuation(value: string): string {
  return value
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s*([-–—,:])\s*(?=[-–—,:])/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—,:.]+|[\s\-–—,:.]+$/g, "")
    .trim();
}

/** Clean up the model's answer into something safe to render as a title. */
export function normalizeTitle(raw: string): string {
  let cleaned = raw.replace(/\s+/g, " ").replace(/^["'\s]+|["'\s.]+$/g, "").trim();
  for (const fragment of DATE_FRAGMENTS) cleaned = cleaned.replace(fragment, " ");
  cleaned = tidyPunctuation(cleaned);
  return cleaned.length > MAX_TITLE_CHARS
    ? `${cleaned.slice(0, MAX_TITLE_CHARS).trimEnd()}…`
    : cleaned;
}

/**
 * Persist a title, subject to the two rules that outrank it. Shared as a plain
 * helper so metadata.ts can apply the title inline from the Analyze response
 * rather than opening a subtransaction with ctx.runMutation.
 */
export async function applyDisplayName(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  displayName: string
): Promise<void> {
  const document = await ctx.db.get(documentId);
  if (!document) return;
  // A title identical to the filename is noise: the UI would render the same
  // string twice, once as the AI title and once as the original beneath it.
  if (displayName === document.name) return;
  // A title the user typed outranks anything this pass comes up with.
  if (document.displayNameSource === "human") return;
  await ctx.db.patch(documentId, {
    displayName,
    displayNameSource: "ai",
  });
}

/** Used by the recordings rename path, which runs in an action. */
export const saveDisplayName = internalMutation({
  args: {
    documentId: v.id("documents"),
    displayName: v.string(),
  },
  handler: async (ctx, args) => {
    await applyDisplayName(ctx, args.documentId, args.displayName);
  },
});

/**
 * Rename pass — the recordings-only path.
 *
 * Uploads arrive named whatever the scanner or download folder called them
 * ("SKM_C224e24081215120.pdf"), so a real title has to be written from what the
 * document turns out to be. For documents that is now a field on the Analyze
 * response itself (`display_title` — see TITLE_RULE in analyzePrompt.ts), which
 * removed a second Interfaze call over an excerpt Analyze already had in full.
 *
 * **Recordings skip the metadata pass entirely** (`processingStages.ts`), so there
 * is no Analyze response to carry a title for them. This standalone call is
 * their only route to one, and is scheduled after `transcribe`. Deleting it
 * would leave every recording showing its raw filename.
 *
 * The Interfaze call lives here under "use node" (the SDK needs the Node
 * runtime); `normalizeTitle` and the persistence helper stay in rename.ts on
 * the default runtime, because metadata.ts needs them too and cannot import a
 * value from a "use node" module.
 */

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

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

import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";

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

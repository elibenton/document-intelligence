import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * The Analyze instruction, in one place.
 *
 * Analyze is user-retryable with an edited prompt, so the exact string the
 * pipeline would use has to be showable in the UI before it runs. Building it
 * here — on the default runtime, not inside the "use node" pipeline module —
 * lets a plain query hand the client the same text `runAnalyze` will send when
 * no override is given.
 */

/** The shape `buildAnalyzePrompt`/`buildDocumentUnderstandingSchema` need —
 *  matches a `documentCategories` row without importing its Doc type here. */
export interface CategoryDef {
  key: string;
  label: string;
  description: string;
}

/** Off-taxonomy fallback: the honest bucket for a category the model
 *  invented. Never a `documentCategories` row — see convex/documentCategories.ts. */
export const OTHER_CATEGORY = "other";

export type PrimaryCategory = string;

/**
 * How to pick one category, including what to do when several plausibly fit.
 * Built from the live `documentCategories` rows so the enum, the instruction
 * that explains it, and the client's color map can never drift apart.
 */
export function buildCategoryRule(categories: CategoryDef[]): string {
  if (categories.length === 0) {
    return `No categories are configured yet — assign primary_category "${OTHER_CATEGORY}".`;
  }
  const clauses = categories.map((c) => `"${c.key}": ${c.description}`).join(" ");
  const order = categories.map((c) => c.key).join(", then ");
  return (
    "Assign exactly one primary_category — the single broad bucket the specific type you named in " +
    `primary_kind belongs to. ${clauses} ` +
    `When more than one bucket plausibly fits, take the first that applies in this order: ${order}. ` +
    `Use "${OTHER_CATEGORY}" only when none of the configured categories genuinely describes the document.`
  );
}

/**
 * Forces the reasoning order the pill depends on: find where the document
 * names its own type, quote it, name the precise type from that quote, and
 * only then classify which broad bucket it belongs to — never the reverse.
 *
 * Grounded in the document's own text the same way DATE_RULE grounds dates:
 * kind_evidence has to be a real quote, so a confident-sounding guess with
 * nothing to point at is visibly unsupported rather than silently accepted.
 * This is what stops two documents that share a caption, case number, and
 * most of their boilerplate — a judgment, the order before it, the motion
 * that requested it — from being tagged as the same thing just because
 * they read alike; each states its own type somewhere, and the type has to
 * come from that document's own statement, not from what its neighbors are.
 */
export const TYPE_RULE =
  "Before anything else, decide the precise, specific type of document this is, for primary_kind — not a generic bucket, and not a guess from the subject matter. " +
  "Most documents state their own type somewhere in their own text: a case caption or title block (\"JUDGMENT\", \"ORDER GRANTING FINAL APPROVAL OF CLASS ACTION SETTLEMENT\"), a form's printed name or number (\"Form 211\"), a document heading, or a certification/signature line (\"IT IS SO ORDERED\", \"NOTICE OF ENTRY OF JUDGMENT IS HEREBY GIVEN\"). Find that stated name, quote the exact text it appears in as kind_evidence, and base primary_kind on that quote. " +
  "Two documents in the same matter are routinely different types even when they share a caption, case number, and most of their language — a judgment, the order that preceded it, and the motion that requested it are three separate documents. Never infer a document's type from how similar it reads to another document; read this document's own statement of what it is. " +
  "Only when the document genuinely never states its own type should you infer one, and infer conservatively — a broader description you can support beats a specific one you can't — and leave kind_evidence empty when you do. " +
  "If it is a named or numbered form, a statute- or rule-named legal instrument, or a standard document type with an established name, use that exact name " +
  '(e.g. "irs form 211", "writ of mandate", "certificate of incorporation", "motion for summary judgment", "phase i environmental site assessment"). ' +
  'Only fall back to a generic description ("letter", "report", "memo") when the document genuinely has no more specific classification. ' +
  "Only after primary_kind is settled, assign primary_category as the broad bucket that specific type belongs to.";

/**
 * The date rule.
 *
 * This date is what the library sorts and displays, so a confident wrong
 * answer is worse than no answer — it silently misfiles the document. The
 * instruction is written to make "unknown" the comfortable choice, and
 * metadata.ts drops anything that doesn't come back as a clean ISO prefix.
 */
const DATE_RULE =
  "Date the document only from a date the document states about itself: a dateline, filing or received stamp, signature block, letterhead date, or revision line. " +
  "Do not infer a date from events the document describes, from a copyright notice, from the date of a document it cites, or from period or style. " +
  "Truncate to what the text actually establishes — a document that gives only a month is a month, not the first of that month. " +
  'If the document does not state its own date, or you would be choosing between candidates, return precision "unknown" with an empty value. Returning unknown is correct and expected; guessing is not.';

/**
 * The library title rule.
 *
 * This was its own Interfaze call (convex/renameNode.ts) working from derived
 * facts plus a 4,000-character excerpt. Analyze already holds the full document
 * text and has just committed to `primary_kind` from quoted evidence, so the
 * excerpt was strictly redundant and the kind arrived as an opaque fact rather
 * than something the model had reasoned to.
 *
 * The one thing the standalone call had that this does not: it withheld the
 * document's date from its own input. That property is preserved structurally —
 * `display_title` is declared before every date field, so no date exists in
 * context when the title is written. `normalizeTitle` still strips dates as a
 * backstop, because a date can also be read straight out of the document text.
 */
const TITLE_RULE =
  "Write display_title: the name this document carries in the library. " +
  "Exactly two parts, in this order: the unique thing the document concerns, then what the document is. " +
  "Lead with the specific identifier a reader would recognize and search for — the case name, the parties, the address, the person, the organization, the event. Follow it with the document's type: use the primary_kind you just assigned when it is specific, a general type otherwise. " +
  'Examples: "Roe v. SFB Management Complaint", "1240 Mission St Conditional Use Permit", "Hernandez Deposition Transcript", "SFMTA Board Minutes". ' +
  "Under 60 characters, and shorter whenever the document allows. No subtitle, no second clause after a comma or colon, no summary of what is inside. " +
  "Never put a date or a year in display_title, in any form. The library shows the document's date in its own column, so a date in the title is duplicated noise. " +
  "Prefer a case or matter name over a docket or file number. Use a number only when there is no name to use. " +
  "Never invent parties, places, or identifiers. When the unique element is genuinely not established, name the document by its type alone rather than guessing at one. " +
  "Title Case. No file extension, no quotes, no trailing period. Do not describe the file format, and do not restate the original filename when it is meaningless (a scanner code, a hash, IMG_1234).";

export function buildAnalyzePrompt(options: {
  csv: boolean;
  kindNames: string[];
  categories: CategoryDef[];
  /** Original upload filename — sometimes the best identifier in the document,
   *  often meaningless. TITLE_RULE says which is which. */
  fileName?: string;
}): string {
  const categoryRule = buildCategoryRule(options.categories);
  const typeRule = `${TYPE_RULE} ${buildKindReuseClause(options.kindNames)}`.trim();
  const fileNameFact = options.fileName
    ? ` Original filename: "${options.fileName}".`
    : "";
  return options.csv
    ? `Analyze this CSV dataset: its columns, row semantics, subject, and notable structure.${fileNameFact} ${typeRule} ${categoryRule} ${TITLE_RULE} ${DATE_RULE}`
    : `Analyze this document and return the requested metadata. The text is the document's OCR output, page by page, with each page preceded by a '--- Page N ---' marker. Build the table of contents from headings that actually appear in the text, and take each entry's page number from the marker it falls under. Flag any page ranges that look like a separate document stapled into the same file, and suggest the extractions this particular document would reward.${fileNameFact} ${typeRule} ${categoryRule} ${TITLE_RULE} ${DATE_RULE}`;
}

/**
 * Deliberately placed right after TYPE_RULE, not trailing at the end of the
 * prompt: a reuse instruction read last tends to override everything said
 * about specificity before it (recency bias), which is exactly how "cal abc
 * doc" — a bucket, not a form name — kept getting reused for documents whose
 * own kind_evidence named something far more specific. Subordinated
 * explicitly to kind_evidence so reuse can normalize a name, never flatten one.
 */
export function buildKindReuseClause(kindNames: string[]): string {
  // Sorted and deduped, because this string is part of the semantic cache key.
  // The kind list arrives in table order, so two documents holding the same set
  // of kinds could still produce two different prompts — and a re-run that
  // should have been a free cache hit gets billed as a fresh call. Ordering
  // carries no meaning to the model, so normalizing it costs nothing.
  const kinds = [...new Set(kindNames)].sort();
  if (kinds.length === 0) return "";
  return (
    `Existing document kinds in this system: ${kinds.join(", ")}. ` +
    "Reuse one only if it is already exactly as specific as kind_evidence supports for this document — never reuse a broader existing kind in place of a more specific name this document's own text supports, even when the broader kind is technically accurate. " +
    "Propose a concise new, more specific lowercase kind instead whenever none of the existing ones are that precise."
  );
}

export function analyzeSystemPrompt(csv: boolean): string {
  return csv
    ? "You are a meticulous data-understanding system. Summarize what this dataset contains and use Unknown when metadata is uncertain."
    : "You are a meticulous document-understanding system. Work only from the text provided. Be factual, never invent detail, and use Unknown when metadata is uncertain.";
}

function isCsv(name: string, mimeType: string, mediaType?: string): boolean {
  const mime = mimeType.toLowerCase();
  return (
    mediaType === "csv" ||
    mime === "text/csv" ||
    mime === "application/csv" ||
    name.toLowerCase().endsWith(".csv")
  );
}

/** The prompt the next Analyze run would use, for the retry dialog to pre-fill. */
export const forDocument = query({
  args: { documentId: v.id("documents") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (!document) return null;
    const kinds = await ctx.db.query("documentKinds").collect();
    const categories = await ctx.db.query("documentCategories").collect();
    return buildAnalyzePrompt({
      csv: isCsv(document.name, document.mimeType, document.mediaType),
      fileName: document.name,
      kindNames: kinds.map((kind) => kind.name),
      categories: categories
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ key: c.key, label: c.label, description: c.description })),
    });
  },
});

// Analysis only — no page text, and no graphic objects.
//
// Page text used to be a required field here, against a max_tokens of 8192, so
// any document past ~15 pages ran out of output mid-JSON and failed to parse.
// Text now comes from the OCR task, which also carries word-level geometry.
//
// Graphic objects (signatures, stamps, redactions) are gone from this schema
// because this call is text-in: it cannot see the page, and asking anyway just
// invites it to infer a seal from the word "seal". They need their own vision
// pass — tracked in docs/scan-precontext-plan.md.
//
// It lives here beside the prompt rather than in the "use node" pipeline
// module so the schema and the instruction that describes it stay in one file,
// and so plain-runtime callers (and scripts) can read it.
//
// A function, not a static object, because `primary_category`'s enum is the
// live `documentCategories` key set. `primary_kind` is declared *before*
// `primary_category` — structured-output generation follows property
// declaration order, and the pill depends on the model committing to the
// specific type before it picks a bucket for it (see TYPE_RULE above).
export function buildDocumentUnderstandingSchema(categoryKeys: string[]) {
  return {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Document title as written, or a concise descriptive title",
      },
      summary: {
        type: "string",
        description: "A factual 2-3 sentence summary of the complete document",
      },
      // Declared before primary_kind so the model locates its evidence before
      // committing to an answer — see TYPE_RULE. Grounds primary_kind the
      // same way document_date.evidence grounds document_date: a quote that
      // can be checked, not a description that sounds right.
      kind_evidence: {
        type: "string",
        description:
          "The exact text — a caption, title block, form name, heading, or certification/signature line — where the document states its own type. Quoted verbatim from the document. Empty string only if the document never states its own type and primary_kind had to be inferred.",
      },
      // Decided from kind_evidence — see TYPE_RULE. The specific secondary
      // type, not a generic bucket. primary_category (below) is derived from
      // this, not the other way around.
      primary_kind: {
        type: "string",
        description:
          'The precise, specific name of this document type, read from kind_evidence — the exact named or numbered form, statute-named instrument, or standard document type when the document has one ("irs form 211", "writ of mandate", "certificate of incorporation"), matching the last element of the first document_types path. Only a generic term ("letter", "report") when nothing more specific applies. Lowercase.',
      },
      primary_category: {
        type: "string",
        enum: [...categoryKeys, OTHER_CATEGORY],
        description:
          "The single broad bucket primary_kind belongs to. See the category rule in the instruction for precedence when several fit.",
      },
      // Written *after* primary_kind so it can name the document by the type
      // the model just derived from a quote, and *before* any date field so the
      // date does not exist in context yet. The standalone rename call kept
      // dates out of titles by withholding the date from its input entirely
      // ("an instruction not to use a fact competes with the fact itself");
      // property order is how that withholding survives the merge.
      display_title: {
        type: "string",
        description:
          "The name this document carries in the library. See the title rule in the instruction.",
      },
      date: {
        type: "string",
        description: "Primary date of the document (ISO if possible), or Unknown",
      },
      // The date the document was *made*, as opposed to `date` above (any date
      // the document is about) and `uploadedAt` (when it reached us). This is
      // the one the library sorts and shows, so it is deliberately structured:
      // a precision the renderer can format against, and the evidence string,
      // which exists to make guessing feel expensive.
      document_date: {
        type: "object",
        description:
          "When the document itself says it was created. See the dating rule in the instruction — unknown is a correct answer.",
        properties: {
          value: {
            type: "string",
            description:
              'ISO 8601, truncated to what the document establishes: "2026-08-08", "2026-08", or "2026". Empty string when unknown.',
          },
          precision: {
            type: "string",
            enum: ["day", "month", "year", "unknown"],
            description:
              "How precisely the document fixes its own creation date. Must agree with the shape of value.",
          },
          evidence: {
            type: "string",
            description:
              "The exact text the date was read from, quoted from the document. Empty when unknown.",
          },
        },
        required: ["value", "precision", "evidence"],
      },
      author: {
        type: "string",
        description: "Author or creator if identifiable, or Unknown",
      },
      language: { type: "string", description: "Primary document language" },
      source_language_code: {
        type: "string",
        description: "Primary document language as a lowercase ISO 639 code",
      },
      is_multilingual: {
        type: "boolean",
        description: "True when meaningful passages use more than one language",
      },
      // A document type is a path, not a word: "Writ of Mandate" is a kind of
      // "Legal Document", and both are true of the same file. Multi-level and
      // multi-select, so the type filter can be broad or exact.
      document_types: {
        type: "array",
        description:
          "Document types, most specific first. Each is a broad-to-specific path, e.g. [\"legal document\", \"writ of mandate\"] or [\"government form\", \"abc form 211\"]. Include a second entry only when the document genuinely is two things at once.",
        items: {
          type: "object",
          properties: {
            path: {
              type: "array",
              items: { type: "string" },
              description:
                "1-3 lowercase levels, broadest first, most specific last",
            },
            confidence: {
              type: "number",
              description: "0-1 confidence in this classification",
            },
          },
          required: ["path", "confidence"],
        },
      },
      // Scanned batches routinely staple unrelated documents together. Analyze
      // reads the whole text, so it is the only pass positioned to say where one
      // document ends. These are *suggestions*: nothing splits without the user.
      suggested_splits: {
        type: "array",
        description:
          "Page ranges where this file appears to contain more than one distinct document. Return an empty array when the file is a single document — which is the common case, so do not invent boundaries from topic changes alone. Ranges must be contiguous, non-overlapping, and cover the whole file when present.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of this sub-document" },
            start_page: { type: "integer", description: "1-based first page" },
            end_page: { type: "integer", description: "1-based last page, inclusive" },
            document_type: {
              type: "string",
              description: "Lowercase kind of this sub-document",
            },
            reason: {
              type: "string",
              description:
                "The evidence in the text for the boundary (new caption page, new letterhead, restarted numbering, signature block)",
            },
            confidence: { type: "number", description: "0-1" },
          },
          required: [
            "title",
            "start_page",
            "end_page",
            "document_type",
            "reason",
            "confidence",
          ],
        },
      },
      // The pills in the extraction review queue. `suggested_roles` above is the
      // per-entity-role version this generalizes: these are whole extraction
      // prompts the user can run, edit, or discard.
      suggested_extractions: {
        type: "array",
        description:
          "3-6 extractions worth running on this specific document, most valuable first. Base them on what this document actually contains, not on what its kind usually contains.",
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "Short pill label, 1-3 words, e.g. 'Parties' or 'Dates'",
            },
            prompt: {
              type: "string",
              description:
                "The full extraction prompt to run, written so the user can edit it directly",
            },
            rationale: {
              type: "string",
              description: "One sentence on why this document warrants it",
            },
          },
          required: ["label", "prompt", "rationale"],
        },
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "3-6 concise lowercase topical tags",
      },
      suggested_roles: {
        type: "array",
        description: "Entity roles worth extracting from this document kind",
        items: {
          type: "object",
          properties: {
            role: { type: "string" },
            question: { type: "string" },
            entity_type: {
              type: "string",
              enum: ["person", "organization", "place", "other"],
            },
          },
          required: ["role", "question", "entity_type"],
        },
      },
      // Flat-with-level rather than nested children: JSON Schema can't express a
      // recursive tree without $ref, and a depth number rebuilds the same shape
      // on the client. Page numbers come from the "--- Page N ---" markers the
      // text is fed in with (interfaze.ts:analyzeDocumentText), so the model is
      // reporting a number it was shown rather than counting.
      table_of_contents: {
        type: "array",
        description:
          "Table of contents for the document, in reading order. One entry per heading or section that a reader would navigate by. level is 1 for top-level sections and increases for subsections (max 4). page is the 1-based page number from the '--- Page N ---' marker the section starts under. Return an empty array when the document has no navigable section structure. Never invent headings that are not in the text.",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Heading text as written in the document",
            },
            level: { type: "integer", description: "Depth, 1-4" },
            page: { type: "integer", description: "1-based page the section starts on" },
          },
          required: ["title", "level", "page"],
        },
      },
      additional: {
        type: "array",
        description: "Other notable metadata as key/value pairs",
        items: {
          type: "object",
          properties: { key: { type: "string" }, value: { type: "string" } },
          required: ["key", "value"],
        },
      },
    },
    required: [
      "title",
      "summary",
      "date",
      "author",
      "language",
      "source_language_code",
      "is_multilingual",
      "kind_evidence",
      "primary_kind",
      "document_date",
      "primary_category",
      "document_types",
      "tags",
      "suggested_roles",
      "suggested_extractions",
      "suggested_splits",
      "table_of_contents",
      "additional",
    ],
  };
}

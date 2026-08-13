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
export function buildAnalyzePrompt(options: {
  csv: boolean;
  kindNames: string[];
}): string {
  const base = options.csv
    ? "Analyze this CSV dataset: its columns, row semantics, subject, and notable structure."
    : "Analyze this document and return the requested metadata. The text is the document's OCR output, page by page, with each page preceded by a '--- Page N ---' marker. Build the table of contents from headings that actually appear in the text, and take each entry's page number from the marker it falls under. Classify the document type broad-to-specific, flag any page ranges that look like a separate document stapled into the same file, and suggest the extractions this particular document would reward.";
  return options.kindNames.length > 0
    ? `${base} Existing document kinds: ${options.kindNames.join(", ")}. Use one when it fits; otherwise propose a concise new lowercase kind.`
    : base;
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
    return buildAnalyzePrompt({
      csv: isCsv(document.name, document.mimeType, document.mediaType),
      kindNames: kinds.map((kind) => kind.name),
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
export const DOCUMENT_UNDERSTANDING_SCHEMA = {
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
    date: {
      type: "string",
      description: "Primary date of the document (ISO if possible), or Unknown",
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
    primary_kind: {
      type: "string",
      description:
        "Concise lowercase semantic document kind — the most specific one, matching the last element of the first document_types path",
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
    "primary_kind",
    "document_types",
    "tags",
    "suggested_roles",
    "suggested_extractions",
    "suggested_splits",
    "table_of_contents",
    "additional",
  ],
};

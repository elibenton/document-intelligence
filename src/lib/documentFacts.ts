/**
 * One shape for "what does this document say about itself, and who said it" —
 * feeds the viewer bar and the Info panel's editors. Computed client-side
 * from fields the document row already carries (live columns + the two
 * candidate stores, sourceMetadata and aiMetadata): no extra query, no
 * subscription beyond the one the page already holds.
 */

import type { Doc } from "../../convex/_generated/dataModel";
import type {
  EditableCandidate,
  EditableProvenance,
} from "@/components/ui/editable";
import { formatDated, type DatedTo } from "./documentDate";

export interface MetadataFact {
  /** Current value, or null when absent (including a human tombstone). */
  value: string | null;
  precision?: "day" | "month" | "year";
  /** Provenance of the current value; null when absent. */
  source: EditableProvenance["source"] | null;
  /** True when a person deleted the value — absent AND stamped human. */
  cleared: boolean;
  /** Retained other answers (native/AI), ready for the editable rows. */
  candidates: EditableCandidate[];
  provenance: EditableProvenance | undefined;
}

export interface DocumentFacts {
  title: MetadataFact;
  author: MetadataFact;
  createdDate: MetadataFact;
  documentDate: MetadataFact;
  documentPlace: MetadataFact;
  language: MetadataFact;
}

type FactsDoc = Pick<
  Doc<"documents">,
  | "displayName"
  | "displayNameSource"
  | "author"
  | "authorSource"
  | "createdDate"
  | "createdDatePrecision"
  | "createdDateSource"
  | "documentDate"
  | "documentDatePrecision"
  | "documentDateSource"
  | "documentPlace"
  | "documentPlaceSource"
  | "sourceLanguageCode"
  | "sourceLanguageSource"
  | "sourceMetadata"
  | "aiMetadata"
  | "metadata"
>;

function narrowSource(
  raw: string | undefined
): EditableProvenance["source"] | undefined {
  return raw === "native" || raw === "ai" || raw === "human" ? raw : undefined;
}

function narrowPrecision(
  raw: string | undefined
): "day" | "month" | "year" | undefined {
  return raw === "day" || raw === "month" || raw === "year" ? raw : undefined;
}

function fact(
  value: string | undefined,
  rawSource: string | undefined,
  candidates: Array<EditableCandidate | null>,
  precision?: string
): MetadataFact {
  const source = narrowSource(rawSource);
  const present = value?.trim() ? value : null;
  const kept = candidates.filter(
    (candidate): candidate is EditableCandidate =>
      candidate !== null && !!candidate.value && candidate.value !== present
  );
  return {
    value: present,
    precision: narrowPrecision(precision),
    source: present ? (source ?? "ai") : null,
    cleared: !present && source === "human",
    candidates: kept,
    provenance: present ? { source: source ?? "ai" } : undefined,
  };
}

function dateCandidate(
  dated: { value: string; precision: string } | undefined,
  source: EditableCandidate["source"]
): EditableCandidate | null {
  if (!dated?.value) return null;
  const precision = narrowPrecision(dated.precision) ?? "day";
  return {
    value: dated.value,
    source,
    label: formatDated({ value: dated.value, precision } satisfies DatedTo),
  };
}

function textCandidate(
  value: string | undefined,
  source: EditableCandidate["source"]
): EditableCandidate | null {
  return value?.trim() ? { value: value.trim(), source } : null;
}

/** The prose author documents analyzed before the column existed carry. */
function blobAuthor(doc: FactsDoc): string | undefined {
  if (!doc.metadata) return undefined;
  try {
    const parsed = JSON.parse(doc.metadata) as { author?: unknown };
    const author = typeof parsed.author === "string" ? parsed.author.trim() : "";
    return author && author.toLowerCase() !== "unknown" ? author : undefined;
  } catch {
    return undefined;
  }
}

export function buildDocumentFacts(doc: FactsDoc): DocumentFacts {
  const native = doc.sourceMetadata;
  const ai = doc.aiMetadata;
  // Author fell back to the metadata blob before the column existed; a blob
  // value renders (and edits) as an AI value until something re-stamps it.
  const author = doc.author ?? (doc.authorSource ? undefined : blobAuthor(doc));
  return {
    title: fact(doc.displayName, doc.displayNameSource, [
      textCandidate(native?.title, "native"),
      textCandidate(ai?.displayTitle, "ai"),
    ]),
    author: fact(author, doc.authorSource, [
      textCandidate(native?.author, "native"),
      textCandidate(ai?.author, "ai"),
    ]),
    createdDate: fact(
      doc.createdDate,
      doc.createdDateSource,
      [
        dateCandidate(native?.createdDate, "native"),
        dateCandidate(ai?.createdDate, "ai"),
      ],
      doc.createdDatePrecision
    ),
    documentDate: fact(
      doc.documentDate,
      doc.documentDateSource,
      [dateCandidate(ai?.documentDate, "ai")],
      doc.documentDatePrecision
    ),
    documentPlace: fact(doc.documentPlace, doc.documentPlaceSource, [
      textCandidate(ai?.documentPlace, "ai"),
    ]),
    language: fact(doc.sourceLanguageCode, doc.sourceLanguageSource, [
      textCandidate(ai?.sourceLanguageCode, "ai"),
    ]),
  };
}

/** What the createdDate is called per media type, in headers and labels. */
export function createdDateLabel(mediaType: string | undefined): string {
  switch (mediaType) {
    case "webScrape":
      return "Published";
    case "audio":
    case "video":
      return "Recorded";
    case "image":
      return "Taken";
    default:
      return "Created";
  }
}

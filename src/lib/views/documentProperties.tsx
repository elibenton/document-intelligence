import type { Doc } from "../../../convex/_generated/dataModel";
import { DocTypePills } from "@/components/documents/DocTypePills";
import { DocStatusIndicator } from "@/components/documents/DocStatusIndicator";
import { libraryStatus } from "@/components/documents/docStatus";
import {
  documentDateSortKey,
  formatDocumentDate,
  hasDocumentDate,
} from "@/lib/documentDate";
import { documentTitles } from "@/lib/documentTitle";
import { languageName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import type { PropertyDef, PropertyOption } from "./types";

/**
 * Everything the Library can show, group, filter, or sort by.
 *
 * Adding an attribute to the Library is adding one entry here — the properties
 * menu, the group menu, the filter operators, and the sort menu are all
 * generated from this list.
 */

/** A row as `documents.list` returns it: the document plus its analyze job state. */
export type LibraryDoc = Doc<"documents"> & { analyzeStatus?: string | null };

const CHIP = "text-[10px] font-medium leading-none px-1.5 py-0.5 truncate";

interface DocumentMetadata {
  author?: string;
  summary?: string;
}

function metadataOf(doc: LibraryDoc): DocumentMetadata {
  if (!doc.metadata) return {};
  try {
    return JSON.parse(doc.metadata) as DocumentMetadata;
  } catch {
    return {};
  }
}

/** "Unknown" is Analyze declining to answer, which is not a value to filter on. */
function definite(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "unknown") return null;
  return trimmed;
}

export function fileTypeOf(doc: LibraryDoc): string {
  if (doc.mediaType) return doc.mediaType;
  if (doc.mimeType === "application/pdf") return "pdf";
  if (doc.mimeType.includes("wordprocessingml")) return "docx";
  if (doc.mimeType.includes("csv")) return "csv";
  if (doc.mimeType.startsWith("image/")) return "image";
  if (doc.mimeType.startsWith("audio/")) return "audio";
  if (doc.mimeType.startsWith("video/")) return "video";
  return "other";
}

export const FILE_TYPE_LABELS: Record<string, string> = {
  pdf: "PDF",
  docx: "Word",
  csv: "CSV",
  image: "Image",
  audio: "Audio",
  video: "Video",
  webScrape: "Web clip",
  other: "Other",
};

function domainOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

const sentenceCase = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

/** The distinct values actually present, for filter menus on open vocabularies. */
function observedOptions(
  rows: LibraryDoc[],
  read: (doc: LibraryDoc) => string | string[] | null | undefined,
  label: (value: string) => string = sentenceCase
): PropertyOption[] {
  const seen = new Set<string>();
  for (const doc of rows) {
    const value = read(doc);
    if (!value) continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      if (one) seen.add(one);
    }
  }
  return [...seen]
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value, label: label(value) }));
}

export const DOCUMENT_PROPERTIES: PropertyDef<LibraryDoc>[] = [
  {
    id: "title",
    label: "Title",
    kind: "text",
    pinned: true,
    searchable: true,
    sortable: true,
    filterable: true,
    value: (doc) => documentTitles(doc).primary,
  },
  {
    id: "filename",
    label: "File name",
    kind: "text",
    searchable: true,
    sortable: true,
    filterable: true,
    // Not shown by default — the title replaced it on the row — but still how
    // people look for a file they remember by its name on disk.
    value: (doc) => doc.name,
    format: (doc) => doc.name,
  },
  {
    id: "status",
    label: "Status",
    kind: "select",
    filterable: true,
    groupable: true,
    // Null once the document is done, so "Status is empty" reads as "finished"
    // and the row shows nothing — the library is not a progress board.
    value: (doc) => libraryStatus(doc),
    format: (doc) => libraryStatus(doc),
    options: () =>
      ["Scanning", "Analyzing", "Extracting", "Failed"].map((value) => ({
        value,
        label: value,
      })),
    render: (doc) => (
      <DocStatusIndicator
        status={doc.status}
        mediaType={doc.mediaType}
        mimeType={doc.mimeType}
        metadata={doc.metadata}
        analyzeStatus={doc.analyzeStatus}
      />
    ),
  },
  {
    id: "category",
    label: "Category",
    kind: "select",
    filterable: true,
    groupable: true,
    sortable: true,
    value: (doc) => doc.primaryCategory ?? null,
    format: (doc) => (doc.primaryCategory ? sentenceCase(doc.primaryCategory) : null),
    // Derived from what's actually on the rows, not a live Settings read:
    // options() runs outside a component. The pill itself (render, below)
    // always shows the true live label — this is only the filter/group menu.
    options: (rows) => observedOptions(rows, (doc) => doc.primaryCategory),
    // Renders the whole two-tone pill — category and kind together — so the
    // Library shows the exact same DocTypePills object as the document page.
    render: (doc) => (
      <DocTypePills primaryCategory={doc.primaryCategory} primaryKind={doc.primaryKind} />
    ),
  },
  {
    id: "kind",
    label: "Kind",
    kind: "select",
    filterable: true,
    groupable: true,
    sortable: true,
    searchable: true,
    value: (doc) => doc.primaryKind ?? null,
    format: (doc) => (doc.primaryKind ? sentenceCase(doc.primaryKind) : null),
    options: (rows) => observedOptions(rows, (doc) => doc.primaryKind),
    // No chip of its own — its value already shows inside the category
    // pill above. Filtering, grouping, and sorting by kind still work.
    render: () => null,
  },
  {
    id: "tags",
    label: "Tags",
    kind: "multiSelect",
    filterable: true,
    groupable: true,
    searchable: true,
    value: (doc) => doc.tags ?? [],
    format: (doc) => (doc.tags?.length ? doc.tags.join(", ") : null),
    options: (rows) => observedOptions(rows, (doc) => doc.tags),
    render: (doc) =>
      doc.tags?.length ? (
        <span className={cn(CHIP, "rounded-full bg-muted text-muted-foreground px-2")}>
          {doc.tags.join(" · ")}
        </span>
      ) : null,
  },
  {
    id: "documentDate",
    label: "Date",
    kind: "date",
    filterable: true,
    sortable: true,
    groupable: true,
    value: (doc) => documentDateSortKey(doc),
    format: (doc) => formatDocumentDate(doc),
    // Grouped by year — a bucket per day would be one row per group.
    options: (rows) =>
      [...new Set(rows.map((doc) => documentDateSortKey(doc)?.slice(0, 4)).filter(Boolean))]
        .sort()
        .reverse()
        .map((year) => ({ value: year as string, label: year as string })),
    render: (doc) => (
      <span
        className={cn(
          "text-xs tabular-nums w-[6.5rem] text-right shrink-0",
          hasDocumentDate(doc)
            ? "text-muted-foreground"
            : "text-muted-foreground/50 italic"
        )}
      >
        {formatDocumentDate(doc)}
      </span>
    ),
  },
  {
    id: "uploadedAt",
    label: "Added",
    kind: "date",
    filterable: true,
    sortable: true,
    value: (doc) => new Date(doc.uploadedAt).toISOString().slice(0, 10),
    format: (doc) => new Date(doc.uploadedAt).toLocaleDateString(),
    render: (doc) => (
      <span className="text-xs tabular-nums text-muted-foreground shrink-0">
        {new Date(doc.uploadedAt).toLocaleDateString()}
      </span>
    ),
  },
  {
    id: "fileType",
    label: "File type",
    kind: "select",
    filterable: true,
    groupable: true,
    value: (doc) => fileTypeOf(doc),
    format: (doc) => FILE_TYPE_LABELS[fileTypeOf(doc)] ?? fileTypeOf(doc),
    options: (rows) => {
      const present = new Set(rows.map(fileTypeOf));
      return Object.entries(FILE_TYPE_LABELS)
        .filter(([value]) => present.has(value))
        .map(([value, label]) => ({ value, label }));
    },
  },
  {
    id: "pageCount",
    label: "Pages",
    kind: "number",
    filterable: true,
    sortable: true,
    value: (doc) => doc.pageCount ?? null,
    format: (doc) => (doc.pageCount ? `${doc.pageCount}` : null),
  },
  {
    id: "language",
    label: "Language",
    kind: "select",
    filterable: true,
    groupable: true,
    value: (doc) => doc.sourceLanguageCode ?? null,
    format: (doc) =>
      doc.sourceLanguageCode ? languageName(doc.sourceLanguageCode) : null,
    options: (rows) =>
      observedOptions(rows, (doc) => doc.sourceLanguageCode, languageName),
  },
  {
    id: "author",
    label: "Author",
    kind: "text",
    filterable: true,
    sortable: true,
    groupable: true,
    searchable: true,
    value: (doc) => definite(metadataOf(doc).author),
    format: (doc) => definite(metadataOf(doc).author),
    options: (rows) => observedOptions(rows, (doc) => definite(metadataOf(doc).author), (v) => v),
  },
  {
    id: "domain",
    label: "Source",
    kind: "text",
    filterable: true,
    groupable: true,
    searchable: true,
    value: (doc) => domainOf(doc.sourceUrl),
    format: (doc) => domainOf(doc.sourceUrl),
    options: (rows) => observedOptions(rows, (doc) => domainOf(doc.sourceUrl), (v) => v),
  },
];

/**
 * Reproduces the Library exactly as it looked before it became configurable,
 * so an untouched project sees no change.
 */
export const DEFAULT_LIBRARY_VIEW = {
  visibleProperties: ["status", "category", "kind", "documentDate"],
  filters: [],
  sorts: [{ property: "documentDate", direction: "desc" as const }],
};

import { Link } from "react-router";
import { CircleAlert } from "lucide-react";
import type { Id } from "../../../convex/_generated/dataModel";
import { DocTypeIcon } from "./DocTypeIcon";
import { DocumentIdentityMenu } from "./DocumentIdentityMenu";
import { libraryStatus } from "./docStatus";
import { PropertyChips } from "@/components/views/PropertyChips";
import {
  DOCUMENT_PROPERTIES,
  type LibraryDoc,
} from "@/lib/views/documentProperties";
import { documentTitles } from "@/lib/documentTitle";
import { cn } from "@/lib/utils";

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * One row of the Library.
 *
 * The row is a link, but the checkbox and identity menu inside it are
 * controls — so the link is the title with a stretched hit area (::after) and
 * the controls sit above it on z-10, rather than buttons nested in an anchor.
 *
 * Which chips appear on the right, and in what order, is entirely the view
 * config's business; this component just hands the row to PropertyChips.
 */
export function LibraryRow({
  doc,
  index,
  checked,
  anySelected,
  visibleProperties,
  onCheckedChange,
  onShiftClick,
}: {
  doc: LibraryDoc;
  index: number;
  checked: boolean;
  anySelected: boolean;
  visibleProperties: string[];
  onCheckedChange: (checked: boolean, index: number) => void;
  onShiftClick: (index: number) => boolean;
}) {
  const { primary } = documentTitles(doc);
  const failed = libraryStatus(doc) === "Failed";

  const iconVisibility = cn(
    "col-start-1 row-start-1 transition-opacity",
    anySelected ? "opacity-0" : "group-hover/check:opacity-0"
  );

  return (
    <div
      className={cn(
        "group/row relative flex items-center justify-between gap-3 rounded px-1 -mx-1 py-1.5 transition-colors hover:bg-accent/50",
        checked && "bg-accent/50"
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {/* The media-type icon doubles as the selection checkbox: it swaps
            when you hover the icon itself, and stays a checkbox for every row
            once a selection exists. A failed document says so here rather than
            with a badge on the right — the icon is already the eye's first
            stop, and a column of red marks is scannable in a way trailing text
            is not. */}
        <span className="group/check relative z-10 grid size-4 shrink-0 place-items-center">
          {failed ? (
            // The wrapper carries the tooltip because lucide icons don't take
            // a `title` prop, and the error message is the point of the mark.
            <span
              role="img"
              aria-label={`Failed: ${doc.errorMessage ?? "processing failed"}`}
              title={doc.errorMessage ?? "Processing failed"}
              className={iconVisibility}
            >
              <CircleAlert className="size-4 text-destructive" />
            </span>
          ) : (
            <DocTypeIcon
              mediaType={doc.mediaType}
              mimeType={doc.mimeType}
              className={cn(iconVisibility, "pointer-events-none")}
            />
          )}
          <input
            type="checkbox"
            checked={checked}
            aria-label={`Select ${primary}`}
            // Shift-click extends from the last row checked on its own, the
            // way a file list does. Handled on click, not change: only the
            // click event carries the modifier keys.
            onClick={(event) => {
              if (!event.shiftKey) return;
              if (onShiftClick(index)) event.preventDefault();
            }}
            onChange={(event) => onCheckedChange(event.target.checked, index)}
            className={cn(
              "col-start-1 row-start-1 size-3.5 cursor-pointer accent-primary transition-opacity",
              !anySelected &&
                "opacity-0 group-hover/check:opacity-100 focus-visible:opacity-100"
            )}
          />
        </span>

        <Link
          to={`/documents/${doc._id}`}
          className="truncate text-sm after:absolute after:inset-0 after:content-['']"
        >
          {primary}
        </Link>
        {doc.mediaType === "webScrape" && doc.sourceUrl && (
          <span className="shrink-0 truncate text-xs text-muted-foreground">
            {domainOf(doc.sourceUrl)}
          </span>
        )}
      </span>

      <span className="flex shrink-0 items-center gap-2">
        <DocumentIdentityMenu
          document={doc}
          className="relative z-10 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
        />
        <PropertyChips
          row={doc}
          defs={DOCUMENT_PROPERTIES}
          visible={visibleProperties}
        />
      </span>
    </div>
  );
}

export type { Id };

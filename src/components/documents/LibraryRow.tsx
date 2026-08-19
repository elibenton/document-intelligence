import { useRef } from "react";
import { Link } from "react-router";
import { CircleAlert } from "lucide-react";
import type { Id } from "../../../convex/_generated/dataModel";
import { DocTypeIcon } from "./DocTypeIcon";
import { libraryStatus } from "./docStatus";
import { PropertyChips, type ChipCommit } from "@/components/views/PropertyChips";
import type { PropertyOption } from "@/lib/views/types";
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
  onChipEdit,
  chipOptions,
}: {
  doc: LibraryDoc;
  index: number;
  checked: boolean;
  anySelected: boolean;
  visibleProperties: string[];
  onCheckedChange: (checked: boolean, index: number) => void;
  onShiftClick: (index: number) => boolean;
  onChipEdit?: (doc: LibraryDoc, commit: ChipCommit) => Promise<unknown>;
  chipOptions?: Record<string, PropertyOption[]>;
}) {
  const { primary } = documentTitles(doc);
  const failed = libraryStatus(doc) === "Failed";

  const iconVisibility = cn(
    "col-start-1 row-start-1 transition-opacity",
    anySelected ? "opacity-0" : "group-hover/check:opacity-0"
  );

  // Set by a shift-click so the change handler that follows it stands aside.
  const shiftHandled = useRef(false);

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
        {/* The title sits on this container rather than on the icon inside it.
            On a failed row the icon covers the whole slot, and a title needs
            pointer events to show — so putting it on the icon made the icon
            swallow every click meant for the checkbox underneath. The container
            is the checkbox's own parent, so hovering anywhere in the slot still
            surfaces the message and nothing intercepts the click. */}
        <span
          className="group/check relative z-10 grid size-5 shrink-0 place-items-center"
          title={failed ? (doc.errorMessage ?? "Processing failed") : undefined}
        >
          {failed ? (
            <span
              role="img"
              aria-label={`Failed: ${doc.errorMessage ?? "processing failed"}`}
              className={cn(iconVisibility, "pointer-events-none")}
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
            //
            // It deliberately does *not* preventDefault. Doing so reverted the
            // browser's own toggle on the row you clicked, and because that row
            // is the range's endpoint it was already in the new selection — so
            // its box rendered unchecked while being counted as selected. The
            // flag instead tells onChange to stand aside, which leaves the
            // anchor where it was without fighting the DOM.
            onClick={(event) => {
              if (!event.shiftKey) return;
              if (onShiftClick(index)) shiftHandled.current = true;
            }}
            onChange={(event) => {
              if (shiftHandled.current) {
                shiftHandled.current = false;
                return;
              }
              onCheckedChange(event.target.checked, index);
            }}
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

      {/* The ⋮ identity menu is retired: renaming is inline on the document
          page, kinds edit there and via the category chip below. */}
      <span className="flex shrink-0 items-center gap-2">
        <PropertyChips
          row={doc}
          defs={DOCUMENT_PROPERTIES}
          visible={visibleProperties}
          onEdit={onChipEdit}
          liveOptions={chipOptions}
        />
      </span>
    </div>
  );
}

export type { Id };

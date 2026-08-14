import { Building2, Users, X } from "lucide-react";
import {
  CITATION_STYLES,
  CITATION_STYLE_LABELS,
  type CitationStyle,
} from "../../../convex/projectTemplates";
import { styleForColor } from "@/components/documents/docTypeCategories";
import { cn } from "@/lib/utils";

/**
 * The three vocabularies a project owns, drawn the way the project draws them.
 *
 * Shared by the new-project carousel and the project settings page, which show
 * the same three things at two different moments — before the project exists
 * and after. Two copies of a colour rule and a chip class is exactly how the
 * settings page and the library ended up describing the same pill differently
 * once before.
 */

export const SECTION_LABEL =
  "flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground";

/**
 * A document type, as the dark half of the pill `DocTypePills` draws in the
 * library. The light half is the specific kind, which nothing has supplied
 * until a document is analyzed, so it is absent here rather than faked.
 */
export function DocumentTypePill({
  label,
  color,
  description,
  onRemove,
}: {
  label: string;
  color: string;
  description?: string;
  onRemove?: () => void;
}) {
  return (
    <span
      title={description}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border py-0.5 text-2xs font-medium leading-none",
        onRemove ? "pl-2 pr-1" : "px-2",
        styleForColor(color).dark
      )}
    >
      {label}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          className="grid size-3.5 place-items-center rounded-full hover:bg-black/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <X className="size-2.5" />
        </button>
      )}
    </span>
  );
}

/** The muted rounded chip the Entities list uses for a type. */
export function EntityTypeChip({
  label,
  description,
  icon,
  muted,
  onRemove,
}: {
  label: string;
  description?: string;
  icon?: React.ReactNode;
  /** For the two the code owns — present, but not the user's to change. */
  muted?: boolean;
  onRemove?: () => void;
}) {
  return (
    <span
      title={description}
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-muted py-0.5 text-2xs font-medium leading-none text-muted-foreground",
        onRemove ? "pl-2 pr-1" : "px-2",
        muted && "opacity-70"
      )}
    >
      {icon}
      {label}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          className="grid size-3.5 place-items-center rounded-full hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-2.5" />
        </button>
      )}
    </span>
  );
}

/**
 * People and organizations, which the graph pass hard-codes
 * (relationshipsNode.ts BASE_ENTITY_TYPES). Shown wherever project entity types
 * are shown, because a list that omits them reads as a list of everything
 * extracted — and they are always extracted.
 */
export function BaseEntityTypeChips() {
  return (
    <>
      <EntityTypeChip muted label="People" icon={<Users className="size-2.5" />} />
      <EntityTypeChip
        muted
        label="Organizations"
        icon={<Building2 className="size-2.5" />}
      />
    </>
  );
}

/** The four citation styles as pills, the chosen one inverted. */
export function CitationStylePicker({
  value,
  onChange,
  disabled,
}: {
  value: CitationStyle;
  onChange: (style: CitationStyle) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {CITATION_STYLES.map((style) => (
        <button
          key={style}
          type="button"
          disabled={disabled}
          aria-pressed={value === style}
          onClick={() => onChange(style)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-2xs font-medium leading-none transition-colors",
            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-60",
            value === style
              ? "border-foreground bg-foreground text-background"
              : "hover:bg-accent"
          )}
        >
          {CITATION_STYLE_LABELS[style]}
        </button>
      ))}
    </div>
  );
}

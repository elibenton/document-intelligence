import { cn } from "@/lib/utils";
import { CATEGORY_STYLES } from "./docTypeCategories";

/** Neutral tint for the kind when Analyze landed on "other" — or on nothing yet. */
const NEUTRAL_LIGHT = "bg-muted text-muted-foreground";

const PILL = "px-1.5 py-0.5 text-[10px] font-medium leading-none truncate";

/** "writ of mandate" → "Writ of mandate". Sentence case, not title case: these
 *  are open-vocabulary phrases and title-casing them reads as a proper noun. */
function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * A document's type, as a joined pair of pills: the broad category on the left
 * in its full colour, the specific kind on the right in a tint of the same
 * hue. Reading left to right gives you the breadcrumb — Legal › writ of
 * mandate — without spending a separator or a second line on it.
 */
export function DocTypePills({
  primaryCategory,
  primaryKind,
  className,
}: {
  primaryCategory?: string;
  primaryKind?: string;
  className?: string;
}) {
  const style = primaryCategory ? CATEGORY_STYLES[primaryCategory] : undefined;
  const kind = primaryKind?.trim();

  // Nothing to say yet — the document hasn't been analyzed, or Analyze
  // declined to place it and never learned a kind for it either.
  if (!style && !kind) return null;

  return (
    <span
      className={cn("inline-flex max-w-[14rem] items-stretch shrink-0", className)}
    >
      {style && (
        <span
          className={cn(
            PILL,
            style.dark,
            kind ? "rounded-l-full pl-2" : "rounded-full px-2"
          )}
        >
          {style.label}
        </span>
      )}
      {kind && (
        <span
          className={cn(
            PILL,
            style ? style.light : NEUTRAL_LIGHT,
            style ? "rounded-r-full pr-2" : "rounded-full px-2"
          )}
          title={kind}
        >
          {sentenceCase(kind)}
        </span>
      )}
    </span>
  );
}

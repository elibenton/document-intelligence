import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { styleForColor } from "./docTypeCategories";

/** Neutral tint for the kind when there's no matching category — "other",
 *  a deleted category, or nothing yet. */
const NEUTRAL_LIGHT = "bg-muted text-muted-foreground";

const PILL = "px-1.5 py-0.5 text-2xs font-medium leading-none truncate";

/** "writ of mandate" → "Writ of mandate". Sentence case, not title case: these
 *  are open-vocabulary phrases and title-casing them reads as a proper noun. */
function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * A document's type, as one bordered pill in two tones: the broad category on
 * the left in its full color, the specific kind on the right in a tint of the
 * same hue. Reading left to right gives you the breadcrumb — Legal › writ of
 * mandate — as a single object, not two chips sitting next to each other.
 *
 * The category list is fetched here (not passed in) so every caller —
 * document rows, the document page header — renders from the same live
 * taxonomy without threading it through props. Only the project has to be
 * passed, because the taxonomy belongs to one: the same key means different
 * things, and carries a different color, in two different projects.
 *
 * A document outside any project has no taxonomy to resolve against and shows
 * its kind alone.
 */
export function DocTypePills({
  projectId,
  primaryCategory,
  primaryKind,
  className,
}: {
  projectId?: Id<"projects">;
  primaryCategory?: string;
  primaryKind?: string;
  className?: string;
}) {
  const categories = useQuery(
    api.documentCategories.list,
    projectId ? { projectId } : "skip"
  );
  const category = primaryCategory
    ? categories?.find((c) => c.key === primaryCategory)
    : undefined;
  const style = category ? styleForColor(category.color) : undefined;
  const kind = primaryKind?.trim();

  // Nothing to say yet — the document hasn't been analyzed, or landed on a
  // category this workspace no longer has (deleted, or "other") with no kind
  // to fall back on either.
  if (!category && !kind) return null;

  return (
    <span
      className={cn(
        "inline-flex max-w-[14rem] items-stretch shrink-0 overflow-hidden rounded-full border",
        className
      )}
    >
      {category && (
        <span className={cn(PILL, style!.dark, "pl-2", !kind && "pr-2")}>
          {category.label}
        </span>
      )}
      {kind && (
        <span
          className={cn(
            PILL,
            style ? style.light : NEUTRAL_LIGHT,
            "pr-2",
            !category && "pl-2"
          )}
          title={kind}
        >
          {sentenceCase(kind)}
        </span>
      )}
    </span>
  );
}

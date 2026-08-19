import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { styleForColor, titleCase } from "./docTypeCategories";

/** Neutral tint for the kind when there's no matching category — "other",
 *  a deleted category, or nothing yet. */
const NEUTRAL_LIGHT = "bg-muted text-muted-foreground";

/**
 * A document's type as a pill within a pill: the outer capsule carries the
 * category's full color and its name (the user's nickname when one is set —
 * "Gov" for "Government"), seamlessly wrapping an inner capsule holding the
 * specific kind in a tint of the same hue. Reading outside-in gives you the
 * breadcrumb — Gov › Writ Of Mandate — as one object.
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

  const categoryName = titleCase(category?.nickname || category?.label || "");

  // Kind alone: one neutral capsule, no outer shell to wrap it.
  if (!category) {
    return (
      <span
        className={cn(
          "inline-flex max-w-[14rem] shrink-0 items-center rounded-full border px-2 py-0.5 text-2xs font-medium leading-none",
          NEUTRAL_LIGHT,
          className
        )}
        title={kind}
      >
        <span className="truncate">{titleCase(kind!)}</span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex max-w-[14rem] shrink-0 items-center gap-1 rounded-full border p-px pl-2 text-2xs font-medium leading-none",
        style!.dark,
        !kind && "pr-2 py-0.5",
        className
      )}
      title={kind ? `${category.label} · ${kind}` : category.label}
    >
      <span className="shrink-0 py-0.5">{categoryName}</span>
      {kind && (
        <span
          className={cn(
            "min-w-0 truncate rounded-full px-1.5 py-0.5",
            style!.light
          )}
        >
          {titleCase(kind)}
        </span>
      )}
    </span>
  );
}

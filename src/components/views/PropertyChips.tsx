import { Fragment, type ReactNode } from "react";
import type { PropertyDef } from "@/lib/views/types";
import { cn } from "@/lib/utils";

/**
 * A row's visible properties, rendered in the order the user arranged them.
 *
 * Properties with a `render` supply their own chip; everything else falls back
 * to plain muted text from `format`. A property with nothing to say renders
 * nothing at all rather than an empty chip — a column of blank pills would be
 * worse than the absence it represents.
 */
export function PropertyChips<T>({
  row,
  defs,
  visible,
  className,
}: {
  row: T;
  defs: PropertyDef<T>[];
  visible: string[];
  className?: string;
}) {
  const byId = new Map(defs.map((def) => [def.id, def]));

  const chips: Array<{ def: PropertyDef<T>; content: ReactNode }> = [];
  for (const id of visible) {
    const def = byId.get(id);
    if (!def) continue;
    const content = def.render
      ? def.render(row)
      : (def.format?.(row) ?? formatFallback(def.value(row)));
    if (content === null || content === undefined || content === "") continue;
    chips.push({ def, content });
  }

  if (chips.length === 0) return null;

  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {chips.map((chip, index) => {
        // A joined chip sits flush against the one before it, so the category
        // and kind pills read as a single breadcrumb when both are shown and
        // adjacent — and as ordinary separate chips when they aren't.
        const joined =
          chip.def.joinWith !== undefined &&
          index > 0 &&
          chips[index - 1].def.id === chip.def.joinWith;
        return (
          <Fragment key={chip.def.id}>
            <span
              className={cn(
                "flex min-w-0 shrink-0 items-center",
                joined && "-ml-1.5"
              )}
            >
              {typeof chip.content === "string" ? (
                <span className="truncate text-xs text-muted-foreground">
                  {chip.content}
                </span>
              ) : (
                chip.content
              )}
            </span>
          </Fragment>
        );
      })}
    </span>
  );
}

function formatFallback(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length ? value.join(" · ") : null;
  if (typeof value === "boolean") return value ? "Yes" : null;
  return String(value);
}

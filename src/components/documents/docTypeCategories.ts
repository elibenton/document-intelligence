/**
 * The fixed color palette a `documentCategories` row's `color` field indexes
 * into. Kept out of DocTypePills.tsx so that file exports only its component
 * — mixing component and value exports breaks React Fast Refresh for the
 * module, the same reason docStatus.ts exists.
 *
 * Categories themselves are user-managed (Settings → Document categories),
 * not a closed set — but Tailwind's JIT compiler only picks up class names it
 * can see as literal strings, so the *colors* a category can pick from stay a
 * fixed, named palette rather than an arbitrary hex stored in the row.
 *
 * `dark` is the primary pill segment, `light` the tint the specific kind
 * sits in beside it.
 */
export type CategoryColor =
  | "violet"
  | "blue"
  | "amber"
  | "teal"
  | "rose"
  | "emerald"
  | "sky"
  | "slate"
  | "orange"
  | "fuchsia";

export const CATEGORY_COLOR_PALETTE: Record<
  CategoryColor,
  { dark: string; light: string }
> = {
  violet: {
    dark: "bg-violet-600 text-white",
    light: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  },
  blue: {
    dark: "bg-blue-600 text-white",
    light: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200",
  },
  amber: {
    dark: "bg-amber-600 text-white",
    light: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  },
  teal: {
    dark: "bg-teal-600 text-white",
    light: "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200",
  },
  rose: {
    dark: "bg-rose-600 text-white",
    light: "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  },
  emerald: {
    dark: "bg-emerald-600 text-white",
    light: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  },
  sky: {
    dark: "bg-sky-600 text-white",
    light: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  },
  slate: {
    dark: "bg-slate-600 text-white",
    light: "bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-200",
  },
  orange: {
    dark: "bg-orange-600 text-white",
    light: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
  },
  fuchsia: {
    dark: "bg-fuchsia-600 text-white",
    light: "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200",
  },
};

export const CATEGORY_COLOR_KEYS = Object.keys(
  CATEGORY_COLOR_PALETTE
) as CategoryColor[];

/** Falls back to `slate` for a color that isn't in the palette (a value
 *  written before a palette change, say) rather than rendering unstyled. */
export function styleForColor(color: string | undefined): {
  dark: string;
  light: string;
} {
  return (
    CATEGORY_COLOR_PALETTE[color as CategoryColor] ?? CATEGORY_COLOR_PALETTE.slate
  );
}

/** A colour for a category the user just invented, cycling the palette so two
 *  additions never land on the same one back to back. Shared by the new-project
 *  template editor and the project settings add form — the picker itself was
 *  deleted, so this is the only assignment path. */
export function nextColor(taken: { color: string }[]): string {
  const used = new Set(taken.map((c) => c.color));
  return (
    CATEGORY_COLOR_KEYS.find((color) => !used.has(color)) ??
    CATEGORY_COLOR_KEYS[taken.length % CATEGORY_COLOR_KEYS.length]
  );
}

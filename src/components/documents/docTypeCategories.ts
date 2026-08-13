/**
 * The four broad buckets Analyze sorts documents into, and the colours the
 * library shows them in. Kept out of DocTypePills.tsx so that file exports
 * only its component — mixing component and value exports breaks React Fast
 * Refresh for the module, the same reason docStatus.ts exists.
 *
 * The set is closed, and matches PRIMARY_CATEGORIES in
 * convex/analyzePrompt.ts. That is what makes colour-coding possible at all:
 * an open vocabulary would need a hash-to-hue scheme, and two unrelated kinds
 * would keep landing on the same colour.
 *
 * `dark` is the primary pill, `light` the tint the specific kind sits in
 * beside it.
 */
export const CATEGORY_STYLES: Record<
  string,
  { label: string; dark: string; light: string }
> = {
  legal: {
    label: "Legal",
    dark: "bg-violet-600 text-white",
    light: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  },
  government: {
    label: "Government",
    dark: "bg-blue-600 text-white",
    light: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200",
  },
  business: {
    label: "Business",
    dark: "bg-amber-600 text-white",
    light: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  },
  published: {
    label: "Published",
    dark: "bg-teal-600 text-white",
    light: "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200",
  },
};

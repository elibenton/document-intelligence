/**
 * `n !== 1 && "s"` was written out at seven call sites, twice in one sentence
 * at one of them. Not a big saving in lines — it's here so the irregular cases
 * have somewhere to live when they turn up.
 */
export function plural(count: number, singular: string, pluralForm?: string) {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/** `3 documents` / `1 document`. Digits are tabular wherever this is rendered. */
export function counted(count: number, singular: string, pluralForm?: string) {
  return `${count} ${plural(count, singular, pluralForm)}`;
}

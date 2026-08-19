/**
 * The merge that stops Analyze from destroying a clip's ingest metadata.
 *
 * saveMetadataResult used to rewrite the metadata JSON blob wholesale, which
 * silently deleted every `additional` entry the web clipper wrote (site name,
 * excerpt, og image, notes). This overlays only the keys the model actually
 * answered and unions `additional` by key with the existing entry winning —
 * ingest facts outrank a re-statement of them.
 *
 * Pure JSON work, no Convex imports, so the merge semantics are pinned by
 * vitest without a runtime.
 */

export interface MetadataBlobUpdate {
  title?: string;
  summary?: string;
  date?: string;
  author?: string;
  language?: string;
  additional?: Array<{ key?: string; value?: string }>;
}

export function mergeMetadataBlob(
  existing: string | undefined,
  next: MetadataBlobUpdate
): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // A garbage blob is replaced, not preserved.
    }
  }

  const merged: Record<string, unknown> = { ...base };
  for (const key of ["title", "summary", "date", "author", "language"] as const) {
    const value = next[key];
    if (typeof value === "string" && value.trim()) merged[key] = value;
  }

  // Union by normalized key; the existing entry wins a collision because the
  // ingest wrote it from the source itself.
  const existingAdditional = Array.isArray(base.additional)
    ? (base.additional as Array<{ key?: unknown; value?: unknown }>).filter(
        (entry) =>
          typeof entry?.key === "string" && typeof entry?.value === "string"
      )
    : [];
  const seen = new Set(
    existingAdditional.map((entry) => (entry.key as string).trim().toLowerCase())
  );
  const additional = [...existingAdditional];
  for (const entry of next.additional ?? []) {
    const key = (entry?.key ?? "").trim();
    const value = (entry?.value ?? "").trim();
    if (!key || !value) continue;
    if (seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    additional.push({ key, value });
  }
  merged.additional = additional;

  return JSON.stringify(merged);
}

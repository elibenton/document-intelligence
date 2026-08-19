/**
 * The type an entity displays and groups under, preferring the stable
 * vocabulary — one rule, shared by the server queries (entities.ts) and the
 * client's list registry (entityProperties.tsx), so the project page and the
 * document sidebar cannot disagree about what kind of thing an entity is.
 *
 * An entity carries both a legacy `type` and a stable `types[]`. Only the
 * latter is maintained, so the first current type in it wins ("addresses",
 * not the legacy "other" a project-declared type is stored under); the legacy
 * value is the fallback for rows written before `types[]` existed.
 *
 * Pure module, no Convex imports, so the client can import it directly.
 */
export function displayEntityType(entity: {
  type: string;
  types?: string[];
}): string {
  const current = entity.types?.find(
    (t) => t === "person" || t === "organization"
  );
  return current ?? entity.types?.[0] ?? entity.type;
}

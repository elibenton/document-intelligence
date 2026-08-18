import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { slugify } from "./slug";
import { bumpDedupeCounter } from "./dedupeStats";

/**
 * Shared entity resolver — the single path every extraction stage uses to turn
 * a name found in a document into an entity in the graph.
 *
 * Policy (per the app's mental model):
 *  - exact-name and known-alias matches auto-link;
 *  - fuzzy resemblance ("E. Cohen" ~ "Eli Cohen") creates the entity anyway
 *    and files a pending mergeSuggestion for a human to confirm or reject;
 *  - confirming a merge teaches the alias, rejecting remembers the non-match.
 *
 * Stable types here are the global ones (person/organization/place/other).
 * Contextual roles (witness, author, ...) are stored in entityRoles by callers.
 */

// Stable type → legacy `type` value still used by the UI's grouping
export const STABLE_TO_LEGACY: Record<string, string> = {
  person: "people",
  organization: "organization",
  place: "places",
  other: "other",
};

export const LEGACY_TO_STABLE: Record<string, string> = {
  people: "person",
  organization: "organization",
  places: "place",
};

const normalize = (s: string) => s.trim().replace(/\s+/g, " ");
const lower = (s: string) => normalize(s).toLowerCase();

/** Find an entity by exact name or known alias (case-insensitive), scoped to
 * a project. Entities in other projects never match — each project has its own
 * extraction layer. */
export async function findByNameOrAlias(
  ctx: MutationCtx,
  name: string,
  projectId?: Id<"projects">
): Promise<Doc<"entities"> | null> {
  const clean = normalize(name);

  const exactMatches = await ctx.db
    .query("entities")
    .withIndex("by_name", (q) => q.eq("name", clean))
    .take(10);
  const exact = exactMatches.find((e) => e.projectId === projectId);
  if (exact) return exact;

  const candidates = await ctx.db
    .query("entities")
    .withSearchIndex("search_name", (q) =>
      q.search("name", clean).eq("projectId", projectId)
    )
    .take(10);

  const target = lower(clean);
  return (
    candidates.find(
      (e) =>
        lower(e.name) === target ||
        e.aliases.some((a) => lower(a) === target)
    ) ?? null
  );
}

/**
 * Cheap fuzzy heuristic for "probably the same person/org, needs a human":
 * matching last token plus compatible first token (full match, initial, or
 * one name containing the other).
 */
function looksLikeSameEntity(a: string, b: string): boolean {
  const ta = lower(a).split(" ");
  const tb = lower(b).split(" ");
  if (ta.length === 0 || tb.length === 0) return false;

  const la = ta[ta.length - 1];
  const lb = tb[tb.length - 1];
  if (la !== lb) {
    // Also treat full containment as a candidate ("Acme" ~ "Acme Corporation")
    return lower(a).includes(lower(b)) || lower(b).includes(lower(a));
  }
  if (ta.length === 1 || tb.length === 1) return true; // "Cohen" ~ "Eli Cohen"

  const fa = ta[0].replace(/\./g, "");
  const fb = tb[0].replace(/\./g, "");
  return (
    fa === fb ||
    fa[0] === fb[0] // "E" ~ "Eli", "E." ~ "Eli"
  );
}

async function suggestionExists(
  ctx: MutationCtx,
  a: Id<"entities">,
  b: Id<"entities">
): Promise<boolean> {
  const oneWay = await ctx.db
    .query("mergeSuggestions")
    .withIndex("by_source_and_target", (q) =>
      q.eq("sourceEntityId", a).eq("targetEntityId", b)
    )
    .first();
  if (oneWay) return true;
  const otherWay = await ctx.db
    .query("mergeSuggestions")
    .withIndex("by_source_and_target", (q) =>
      q.eq("sourceEntityId", b).eq("targetEntityId", a)
    )
    .first();
  return otherWay !== null;
}

export interface ResolveResult {
  entityId: Id<"entities">;
  created: boolean;
}

/**
 * Resolve a found name to an entity: auto-link exact/alias matches, otherwise
 * create the entity and queue merge suggestions for fuzzy lookalikes.
 */
export async function resolveEntity(
  ctx: MutationCtx,
  args: {
    name: string;
    stableType: string; // person | organization | place | other
    documentId?: Id<"documents">;
  }
): Promise<ResolveResult> {
  const clean = normalize(args.name);

  // Everything this resolver touches is scoped to the document's project
  const projectId = args.documentId
    ? (await ctx.db.get(args.documentId))?.projectId
    : undefined;

  const existing = await findByNameOrAlias(ctx, clean, projectId);
  if (existing) {
    // Accumulate the stable type if it's new for this entity — unless a
    // human has pinned the type list, which outranks anything a pass infers.
    const types = existing.types ?? [];
    if (
      !types.includes(args.stableType) &&
      existing.typesSource !== "human"
    ) {
      await ctx.db.patch(existing._id, { types: [...types, args.stableType] });
    }
    if (projectId) await bumpDedupeCounter(ctx, projectId, "resolvedExisting");
    return { entityId: existing._id, created: false };
  }

  const entityId = await ctx.db.insert("entities", {
    projectId,
    name: clean,
    slug: slugify(clean),
    type: STABLE_TO_LEGACY[args.stableType] ?? "other",
    types: [args.stableType],
    mentionCount: 0,
    documentCount: 0,
    avgConfidence: 1.0,
    aliases: [],
    isCustom: args.stableType !== "person",
  });

  // Fuzzy pass: search the graph for lookalikes and queue merge suggestions.
  const seen = new Set<string>([entityId]);
  const tokens = clean.split(" ");
  const probes = [clean, tokens[tokens.length - 1]].filter(
    (p, i, arr) => p.length > 1 && arr.indexOf(p) === i
  );
  for (const probe of probes) {
    const candidates = await ctx.db
      .query("entities")
      .withSearchIndex("search_name", (q) =>
        q.search("name", probe).eq("projectId", projectId)
      )
      .take(8);
    for (const candidate of candidates) {
      if (seen.has(candidate._id)) continue;
      seen.add(candidate._id);
      if (lower(candidate.name) === lower(clean)) continue; // handled above
      if (!looksLikeSameEntity(clean, candidate.name)) continue;
      if (await suggestionExists(ctx, entityId, candidate._id)) continue;
      await ctx.db.insert("mergeSuggestions", {
        sourceEntityId: entityId,
        targetEntityId: candidate._id,
        projectId,
        documentId: args.documentId,
        reason: `"${clean}" resembles existing entity "${candidate.name}"`,
        status: "pending",
      });
      if (projectId) await bumpDedupeCounter(ctx, projectId, "suggested");
    }
  }

  if (projectId) await bumpDedupeCounter(ctx, projectId, "createdNew");
  return { entityId, created: true };
}

/** Recompute an entity's mention/document counts and average OCR confidence
 * from its mention rows. */
export async function recountEntity(
  ctx: MutationCtx,
  entityId: Id<"entities">
): Promise<void> {
  const mentions = await ctx.db
    .query("mentions")
    .withIndex("by_entity", (q) => q.eq("entityId", entityId))
    .collect();
  const docs = new Set(mentions.map((m) => m.documentId));
  const avgConfidence =
    mentions.length > 0
      ? mentions.reduce((sum, m) => sum + m.confidence, 0) / mentions.length
      : 1.0;
  await ctx.db.patch(entityId, {
    mentionCount: mentions.length,
    documentCount: docs.size,
    avgConfidence: Math.round(avgConfidence * 100) / 100,
  });
}

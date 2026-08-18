import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { recountEntity } from "./entityResolution";

// Above this many moved rows per array the log row risks the 1MB document
// ceiling; the merge still happens, but the log marks itself partial and
// refuses to unmerge rather than silently restoring half an entity.
const LOG_ID_CAP = 5_000;

/**
 * The default survivor when neither the human nor the caller picks one:
 * the entity with more evidence, then the fuller name. Fixes the old
 * asymmetry where the newest duplicate was always the source, so "Eli
 * Cohen" arriving after "E. Cohen" got folded into the abbreviation.
 */
export function pickSurvivor(
  a: { mentionCount: number; name: string },
  b: { mentionCount: number; name: string }
): "a" | "b" {
  if (a.mentionCount !== b.mentionCount)
    return a.mentionCount > b.mentionCount ? "a" : "b";
  return a.name.length >= b.name.length ? "a" : "b";
}

/**
 * Fold `source` into `target`: move mentions, roles, and relationships;
 * teach the source's name and aliases as target aliases; merge types; keep
 * the star; retire other pending suggestions touching the source; delete
 * the source — recording everything moved into a mergeLog row so the merge
 * can be undone for 30 days.
 *
 * Shared by suggestion-accept and manual merge; the caller owns suggestion
 * status, counters, and direction (which of the pair is the source).
 */
export async function mergeEntities(
  ctx: MutationCtx,
  args: {
    source: Doc<"entities">;
    target: Doc<"entities">;
    suggestionId?: Id<"mergeSuggestions">;
  }
): Promise<Id<"mergeLog"> | null> {
  const { source, target } = args;

  // Move mentions
  const mentions = await ctx.db
    .query("mentions")
    .withIndex("by_entity", (q) => q.eq("entityId", source._id))
    .collect();
  for (const m of mentions) {
    await ctx.db.patch(m._id, { entityId: target._id });
  }

  // Move roles, skipping duplicates already on the target. Dropped dup
  // roles are not logged for restore: on unmerge the surviving copy on the
  // target still asserts the same fact.
  const roles = await ctx.db
    .query("entityRoles")
    .withIndex("by_entity", (q) => q.eq("entityId", source._id))
    .collect();
  const movedRoleIds: Id<"entityRoles">[] = [];
  for (const r of roles) {
    const dup = await ctx.db
      .query("entityRoles")
      .withIndex("by_entity_and_document", (q) =>
        q.eq("entityId", target._id).eq("documentId", r.documentId)
      )
      .collect();
    if (dup.some((d) => d.role === r.role)) {
      await ctx.db.delete(r._id);
    } else {
      await ctx.db.patch(r._id, { entityId: target._id });
      movedRoleIds.push(r._id);
    }
  }

  // Move relationships (both directions). Edges between the pair would
  // become self-loops, so they are deleted — and snapshotted, because on
  // unmerge that edge between the two entities is real again.
  const deletedRelationships: {
    outgoing: boolean;
    relationType: string;
    confidence: number;
    projectId?: Id<"projects">;
    documentId?: Id<"documents">;
    quote?: string;
    pageNumber?: number;
    eventDate?: string;
    place?: string;
  }[] = [];
  const snapshotRel = (rel: Doc<"relationships">, outgoing: boolean) => ({
    outgoing,
    relationType: rel.relationType,
    confidence: rel.confidence,
    projectId: rel.projectId,
    documentId: rel.documentId,
    quote: rel.quote,
    pageNumber: rel.pageNumber,
    eventDate: rel.eventDate,
    place: rel.place,
  });
  const movedRelSourceIds: Id<"relationships">[] = [];
  const asSource = await ctx.db
    .query("relationships")
    .withIndex("by_source", (q) => q.eq("sourceEntityId", source._id))
    .collect();
  for (const rel of asSource) {
    if (rel.targetEntityId === target._id) {
      deletedRelationships.push(snapshotRel(rel, true));
      await ctx.db.delete(rel._id);
    } else {
      await ctx.db.patch(rel._id, { sourceEntityId: target._id });
      movedRelSourceIds.push(rel._id);
    }
  }
  const movedRelTargetIds: Id<"relationships">[] = [];
  const asTarget = await ctx.db
    .query("relationships")
    .withIndex("by_target", (q) => q.eq("targetEntityId", source._id))
    .collect();
  for (const rel of asTarget) {
    if (rel.sourceEntityId === target._id) {
      deletedRelationships.push(snapshotRel(rel, false));
      await ctx.db.delete(rel._id);
    } else {
      await ctx.db.patch(rel._id, { targetEntityId: target._id });
      movedRelTargetIds.push(rel._id);
    }
  }

  // Teach aliases + merge stable types
  const aliasSet = new Set(target.aliases.map((a) => a.toLowerCase()));
  aliasSet.add(target.name.toLowerCase());
  const newAliases = [...target.aliases];
  const aliasesAdded: string[] = [];
  for (const candidate of [source.name, ...source.aliases]) {
    if (!aliasSet.has(candidate.toLowerCase())) {
      aliasSet.add(candidate.toLowerCase());
      newAliases.push(candidate);
      aliasesAdded.push(candidate);
    }
  }
  const targetTypes = target.types ?? [];
  const typesAdded = (source.types ?? []).filter(
    (t) => !targetTypes.includes(t)
  );
  const typeSet = [...targetTypes, ...typesAdded];
  const starredWasSetByMerge = source.starred === true && target.starred !== true;
  await ctx.db.patch(target._id, {
    aliases: newAliases,
    ...(typeSet.length > 0 ? { types: typeSet } : {}),
    // A user's pin belongs to the real-world entity, not whichever duplicate
    // record happens to survive the merge.
    ...(starredWasSetByMerge ? { starred: true } : {}),
  });

  // Retire any other pending suggestions touching the source entity —
  // superseded rather than deleted, so accept/reject rates stay measurable.
  const touching = [
    ...(await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_source_and_target", (q) =>
        q.eq("sourceEntityId", source._id)
      )
      .collect()),
    ...(await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_target", (q) => q.eq("targetEntityId", source._id))
      .collect()),
  ];
  for (const s of touching) {
    if (s._id === args.suggestionId || s.status !== "pending") continue;
    await ctx.db.patch(s._id, { status: "superseded", resolvedAt: Date.now() });
  }

  // The log, then the deletion it makes reversible.
  const partial =
    mentions.length > LOG_ID_CAP ||
    movedRoleIds.length > LOG_ID_CAP ||
    movedRelSourceIds.length > LOG_ID_CAP ||
    movedRelTargetIds.length > LOG_ID_CAP;
  let logId: Id<"mergeLog"> | null = null;
  if (target.projectId) {
    logId = await ctx.db.insert("mergeLog", {
      projectId: target.projectId,
      targetEntityId: target._id,
      sourceSnapshot: {
        projectId: source.projectId,
        name: source.name,
        type: source.type,
        types: source.types,
        mentionCount: source.mentionCount,
        documentCount: source.documentCount,
        avgConfidence: source.avgConfidence,
        aliases: source.aliases,
        isCustom: source.isCustom,
        nameSource: source.nameSource,
        typesSource: source.typesSource,
        starred: source.starred,
        slug: source.slug,
      },
      movedMentionIds: mentions.slice(0, LOG_ID_CAP).map((m) => m._id),
      movedRoleIds: movedRoleIds.slice(0, LOG_ID_CAP),
      movedRelSourceIds: movedRelSourceIds.slice(0, LOG_ID_CAP),
      movedRelTargetIds: movedRelTargetIds.slice(0, LOG_ID_CAP),
      deletedRelationships,
      aliasesAdded,
      typesAdded,
      starredWasSetByMerge,
      suggestionId: args.suggestionId,
      ...(partial ? { partial: true } : {}),
    });
  }

  await ctx.db.delete(source._id);
  await recountEntity(ctx, target._id);
  return logId;
}

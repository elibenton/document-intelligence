import { ConvexError } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * The ownership walk: does the signed-in user own the row they just named?
 *
 * `projects.ownerId` is the only ownership field in the schema, so every
 * question here reduces to "which project is this row in, and is it mine?".
 * A leaf row reaches its project in at most two `ctx.db.get` calls — see
 * docs/auth-plan.md §7.2 for why that beats denormalising `ownerId` onto
 * twenty-odd tables.
 *
 * ## Why these are explicit calls and not a wrapper
 *
 * The tempting version is a `projectQuery` built with `customQuery`, which
 * takes `projectId` at the wire level and hands the handler a pre-checked
 * `ctx.project`. It is genuinely nicer — the check cannot be forgotten because
 * the argument does not exist without it. It was not built because the
 * argument names are not uniform: `documents.get` takes `id`, its neighbours
 * take `documentId`, and normalising them would rewrite every `useQuery` call
 * site in `src/` to buy a property the test below already guarantees.
 *
 * So the check is a call you have to write, and the thing that stops you
 * forgetting it is `convex/ownership.test.ts`, which parses this directory and
 * fails if any authed endpoint accepts an id argument without reaching one of
 * these helpers. Adding an endpoint that takes a `v.id(...)` and skips the walk
 * breaks the build.
 *
 * ## Why every failure is the same error
 *
 * "Not found" for a row that exists but belongs to someone else, and for a row
 * that does not exist. Distinguishing them would turn any of these endpoints
 * into an oracle for whether a given document id exists in the deployment.
 *
 * ## Actions
 *
 * An action has no `ctx.db`, so it cannot call these directly. The five authed
 * actions go through `ownership.assertOwns*` internal queries instead, which
 * run this same code. Note that ownership does *not* travel into the
 * scheduler: Convex drops identity there, so everything downstream of an
 * enqueue is internal and trusts the `projectId` it was handed as data.
 */

const DENIED = "Not found";

/** Structural: satisfied by both QueryCtx and MutationCtx once authed. */
type OwnedCtx = { db: QueryCtx["db"]; user: { _id: string } };

export async function requireProject(
  ctx: OwnedCtx,
  projectId: Id<"projects">
): Promise<Doc<"projects">> {
  const project = await ctx.db.get(projectId);
  // `ownerId === undefined` is an unowned pre-auth project, and lands here
  // rather than in a special case on purpose: until backfillProjectOwners has
  // run it is owned by nobody, and nobody is who should be able to read it.
  if (!project || project.ownerId !== ctx.user._id) {
    throw new ConvexError(DENIED);
  }
  return project;
}

export async function requireDocument(
  ctx: OwnedCtx,
  documentId: Id<"documents">
): Promise<Doc<"documents">> {
  const document = await ctx.db.get(documentId);
  if (!document?.projectId) throw new ConvexError(DENIED);
  await requireProject(ctx, document.projectId);
  return document;
}

export async function requireEntity(
  ctx: OwnedCtx,
  entityId: Id<"entities">
): Promise<Doc<"entities">> {
  const entity = await ctx.db.get(entityId);
  if (!entity?.projectId) throw new ConvexError(DENIED);
  await requireProject(ctx, entity.projectId);
  return entity;
}

export async function requireAnnotation(
  ctx: OwnedCtx,
  annotationId: Id<"annotations">
): Promise<Doc<"annotations">> {
  const annotation = await ctx.db.get(annotationId);
  if (!annotation) throw new ConvexError(DENIED);
  // Walk through the document rather than trusting the denormalised
  // `annotations.projectId`: that copy exists to save a read on project-wide
  // note views, and a stale one must not be able to widen access.
  await requireDocument(ctx, annotation.documentId);
  return annotation;
}

export async function requireSearch(
  ctx: OwnedCtx,
  searchId: Id<"searches">
): Promise<Doc<"searches">> {
  const search = await ctx.db.get(searchId);
  if (!search?.projectId) throw new ConvexError(DENIED);
  await requireProject(ctx, search.projectId);
  return search;
}

export async function requireBlock(
  ctx: OwnedCtx,
  blockId: Id<"blocks">
): Promise<Doc<"blocks">> {
  const block = await ctx.db.get(blockId);
  if (!block) throw new ConvexError(DENIED);
  await requireDocument(ctx, block.documentId);
  return block;
}

export async function requireDocumentCategory(
  ctx: OwnedCtx,
  categoryId: Id<"documentCategories">
): Promise<Doc<"documentCategories">> {
  const category = await ctx.db.get(categoryId);
  if (!category) throw new ConvexError(DENIED);
  await requireProject(ctx, category.projectId);
  return category;
}

export async function requireProjectEntityType(
  ctx: OwnedCtx,
  typeId: Id<"projectEntityTypes">
): Promise<Doc<"projectEntityTypes">> {
  const row = await ctx.db.get(typeId);
  if (!row) throw new ConvexError(DENIED);
  await requireProject(ctx, row.projectId);
  return row;
}

export async function requireMergeSuggestion(
  ctx: OwnedCtx,
  suggestionId: Id<"mergeSuggestions">
): Promise<Doc<"mergeSuggestions">> {
  const suggestion = await ctx.db.get(suggestionId);
  if (!suggestion) throw new ConvexError(DENIED);
  // Both sides, not just one: accepting a merge deletes one entity into the
  // other, so a suggestion that straddles two projects must not be actionable
  // by an owner of only one of them.
  await requireEntity(ctx, suggestion.sourceEntityId);
  await requireEntity(ctx, suggestion.targetEntityId);
  return suggestion;
}

/**
 * Every project the caller owns. The list endpoints read this instead of
 * `ctx.db.query("projects")`, which is why `by_owner` exists.
 */
export async function ownedProjects(ctx: OwnedCtx): Promise<Doc<"projects">[]> {
  return await ctx.db
    .query("projects")
    .withIndex("by_owner", (q) => q.eq("ownerId", ctx.user._id))
    .collect();
}

/**
 * Ownership for a *batch* of document ids, as a filter rather than a throw.
 *
 * The endpoints that take `v.array(v.id("documents"))` are rendering a list —
 * the citation bibliography, the upload overlay's status cards — where one
 * missing or foreign id must not blank the whole view. Silently dropping is the
 * right failure here, and it is not a weaker check: a dropped row is a row the
 * caller never receives.
 *
 * One indexed read for the project set, then one read per document, rather than
 * a project read per document.
 */
export async function ownedProjectIds(
  ctx: OwnedCtx
): Promise<Set<Id<"projects">>> {
  return new Set((await ownedProjects(ctx)).map((p) => p._id));
}

/**
 * Narrow a set of rows already read by some *other* index — `by_status`, a
 * search hit — to the ones inside the caller's projects.
 *
 * These are the endpoints the coverage test cannot see, because they take no
 * id at all: they ask a question about "everything" and, before ownership
 * existed, answered it about the whole deployment.
 */
export async function keepOwned<T extends { projectId?: Id<"projects"> }>(
  ctx: OwnedCtx,
  rows: T[]
): Promise<T[]> {
  const mine = await ownedProjectIds(ctx);
  return rows.filter((r) => r.projectId !== undefined && mine.has(r.projectId));
}

export async function filterOwnedDocuments(
  ctx: OwnedCtx,
  ids: Id<"documents">[]
): Promise<Doc<"documents">[]> {
  const mine = await ownedProjectIds(ctx);
  const rows = await Promise.all(ids.map((id) => ctx.db.get(id)));
  return rows.filter(
    (doc): doc is Doc<"documents"> =>
      doc !== null && doc.projectId !== undefined && mine.has(doc.projectId)
  );
}

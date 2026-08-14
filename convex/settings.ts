import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { authedMutation, authedQuery } from "./authz";
import { ownedProjects } from "./ownership";
import { requireBudget } from "./budget";

const DEFAULT_LANGUAGE_CODE = "en";
const BACKFILL_BATCH_SIZE = 12;

const settingsResultValidator = v.object({
  defaultLanguageCode: v.string(),
  translationVersion: v.number(),
});

/** The shape every resolver below returns. */
export type LanguagePreference = {
  defaultLanguageCode: string;
  translationVersion: number;
};

const DEFAULTS: LanguagePreference = {
  defaultLanguageCode: DEFAULT_LANGUAGE_CODE,
  translationVersion: 1,
};

function normalizeLanguageCode(value: string): string {
  const code = value.trim().toLowerCase().replaceAll("_", "-");
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(code)) {
    throw new Error("Language must be a valid ISO language code");
  }
  return code;
}

// ---------------------------------------------------------------------------
// Resolvers
//
// Which language should this document be translated into? The answer belongs
// to whoever owns it, so it is reached by the same walk authorization uses —
// document → project → owner — and every existing call site already holds a
// document or a project id. That is why none of this had to be threaded
// through the workpool: Convex drops identity at the scheduler, but ownership
// travels as data, and the language hangs off the owner.
//
// An account with no row gets DEFAULTS rather than an error. A missing
// preference is not a failure, and translating into English is what every
// document did before this table existed.
// ---------------------------------------------------------------------------

export async function languageForOwner(
  ctx: QueryCtx,
  ownerId: string | undefined
): Promise<LanguagePreference> {
  if (!ownerId) return DEFAULTS;
  const row = await ctx.db
    .query("userSettings")
    .withIndex("by_user", (q) => q.eq("userId", ownerId))
    .unique();
  return row
    ? {
        defaultLanguageCode: row.defaultLanguageCode,
        translationVersion: row.translationVersion,
      }
    : DEFAULTS;
}

export async function languageForProject(
  ctx: QueryCtx,
  projectId: Id<"projects"> | undefined
): Promise<LanguagePreference> {
  if (!projectId) return DEFAULTS;
  const project = await ctx.db.get(projectId);
  return await languageForOwner(ctx, project?.ownerId);
}

export async function languageForDocument(
  ctx: QueryCtx,
  documentId: Id<"documents">
): Promise<LanguagePreference> {
  const document = await ctx.db.get(documentId);
  return await languageForProject(ctx, document?.projectId);
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const get = authedQuery({
  args: {},
  returns: settingsResultValidator,
  handler: async (ctx) => await languageForOwner(ctx, ctx.user._id),
});

/** The pipeline's read, resolved from the document rather than the caller. */
export const forDocumentInternal = internalQuery({
  args: { documentId: v.id("documents") },
  returns: settingsResultValidator,
  handler: async (ctx, args) => await languageForDocument(ctx, args.documentId),
});

export const updateDefaultLanguage = authedMutation({
  args: { languageCode: v.string() },
  returns: settingsResultValidator,
  handler: async (ctx, args) => {
    await requireBudget(ctx, ctx.user._id);
    const languageCode = normalizeLanguageCode(args.languageCode);
    const existing = await ctx.db
      .query("userSettings")
      .withIndex("by_user", (q) => q.eq("userId", ctx.user._id))
      .unique();
    if (existing?.defaultLanguageCode === languageCode) {
      return {
        defaultLanguageCode: languageCode,
        translationVersion: existing.translationVersion,
      };
    }

    const translationVersion = (existing?.translationVersion ?? 1) + 1;
    const value = {
      userId: ctx.user._id,
      defaultLanguageCode: languageCode,
      translationVersion,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("userSettings", value);

    // Only this user's projects. The previous version paginated the whole
    // `documents` table, so one person changing their reading language queued
    // a paid translation for every document in the deployment — other
    // accounts' included.
    const projectIds = (await ownedProjects(ctx)).map((p) => p._id);
    await ctx.scheduler.runAfter(0, internal.settings.backfillTranslations, {
      projectIds,
      cursor: null,
      languageCode,
      translationVersion,
      userId: ctx.user._id,
    });
    return { defaultLanguageCode: languageCode, translationVersion };
  },
});

/**
 * Queue a re-translation of everything this user owns, a page of rows at a
 * time, walking their projects one after another.
 *
 * Two levels of iteration rather than one: documents are only reachable per
 * project through `by_project`, and scanning the whole table to filter would
 * put every other account's rows back in the loop, which is the bug this
 * replaces.
 *
 * Re-reads the user's current preference each batch and stops if it has moved
 * on, so changing language twice in a row abandons the first sweep instead of
 * racing it.
 */
export const backfillTranslations = internalMutation({
  args: {
    projectIds: v.array(v.id("projects")),
    cursor: v.union(v.string(), v.null()),
    languageCode: v.string(),
    translationVersion: v.number(),
    userId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const current = await languageForOwner(ctx, args.userId);
    if (
      current.defaultLanguageCode !== args.languageCode ||
      current.translationVersion !== args.translationVersion
    ) {
      return null;
    }

    const [projectId, ...rest] = args.projectIds;
    if (projectId === undefined) return null;

    const page = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .paginate({ numItems: BACKFILL_BATCH_SIZE, cursor: args.cursor });

    for (const document of page.page) {
      await ctx.runMutation(internal.translations.queueTranslation, {
        documentId: document._id,
        languageCode: args.languageCode,
        translationVersion: args.translationVersion,
      });
    }

    // Same project until its documents run out, then the next one.
    const next = page.isDone
      ? { projectIds: rest, cursor: null }
      : { projectIds: args.projectIds, cursor: page.continueCursor };
    if (next.projectIds.length === 0) return null;
    await ctx.scheduler.runAfter(0, internal.settings.backfillTranslations, {
      ...next,
      languageCode: args.languageCode,
      translationVersion: args.translationVersion,
      userId: args.userId,
    });
    return null;
  },
});


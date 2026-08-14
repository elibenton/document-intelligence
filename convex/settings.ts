import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { authedMutation, authedQuery } from "./authz";

const SETTINGS_KEY = "global";
const DEFAULT_LANGUAGE_CODE = "en";
const BACKFILL_BATCH_SIZE = 12;

const settingsResultValidator = v.object({
  defaultLanguageCode: v.string(),
  translationVersion: v.number(),
});

function normalizeLanguageCode(value: string): string {
  const code = value.trim().toLowerCase().replaceAll("_", "-");
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(code)) {
    throw new Error("Language must be a valid ISO language code");
  }
  return code;
}

export const get = authedQuery({
  args: {},
  returns: settingsResultValidator,
  handler: async (ctx) => {
    const settings = await ctx.db
      .query("appSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .unique();
    return {
      defaultLanguageCode:
        settings?.defaultLanguageCode ?? DEFAULT_LANGUAGE_CODE,
      translationVersion: settings?.translationVersion ?? 1,
    };
  },
});

export const getInternal = internalQuery({
  args: {},
  returns: settingsResultValidator,
  handler: async (ctx) => {
    const settings = await ctx.db
      .query("appSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .unique();
    return {
      defaultLanguageCode:
        settings?.defaultLanguageCode ?? DEFAULT_LANGUAGE_CODE,
      translationVersion: settings?.translationVersion ?? 1,
    };
  },
});

export const updateDefaultLanguage = authedMutation({
  args: { languageCode: v.string() },
  returns: settingsResultValidator,
  handler: async (ctx, args) => {
    const languageCode = normalizeLanguageCode(args.languageCode);
    const existing = await ctx.db
      .query("appSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .unique();
    if (existing?.defaultLanguageCode === languageCode) {
      return {
        defaultLanguageCode: languageCode,
        translationVersion: existing.translationVersion,
      };
    }

    const translationVersion = (existing?.translationVersion ?? 1) + 1;
    const value = {
      key: SETTINGS_KEY,
      defaultLanguageCode: languageCode,
      translationVersion,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("appSettings", value);

    await ctx.scheduler.runAfter(0, internal.settings.backfillTranslations, {
      cursor: null,
      languageCode,
      translationVersion,
    });
    return { defaultLanguageCode: languageCode, translationVersion };
  },
});

/** Bounded, resumable scan: each transaction schedules only a small page. */
export const backfillTranslations = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    languageCode: v.string(),
    translationVersion: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("appSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .unique();
    if (
      current?.defaultLanguageCode !== args.languageCode ||
      current.translationVersion !== args.translationVersion
    ) {
      return null;
    }

    const page = await ctx.db.query("documents").paginate({
      numItems: BACKFILL_BATCH_SIZE,
      cursor: args.cursor,
    });
    for (const document of page.page) {
      await ctx.runMutation(internal.translations.queueTranslation, {
        documentId: document._id,
        languageCode: args.languageCode,
        translationVersion: args.translationVersion,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.settings.backfillTranslations, {
        cursor: page.continueCursor,
        languageCode: args.languageCode,
        translationVersion: args.translationVersion,
      });
    }
    return null;
  },
});

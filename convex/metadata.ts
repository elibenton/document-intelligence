import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// ---------------------------------------------------------------------------
// Metadata pass — default-runtime half.
//
// The Interfaze call (runMetadataPass) lives in metadataNode.ts under
// "use node" because the Interfaze SDK needs the Node runtime; this file keeps
// the mutations that persist and edit its output.
// ---------------------------------------------------------------------------

export const saveMetadataResult = internalMutation({
  args: {
    documentId: v.id("documents"),
    raw: v.string(),
  },
  handler: async (ctx, args) => {
    let parsed: {
      title?: string;
      summary?: string;
      date?: string;
      author?: string;
      language?: string;
      source_language_code?: string;
      is_multilingual?: boolean;
      primary_kind?: string;
      tags?: string[];
      suggested_roles?: Array<{ role?: string; question?: string; entity_type?: string }>;
      additional?: Array<{ key?: string; value?: string }>;
    };
    try {
      parsed = JSON.parse(args.raw);
    } catch {
      return;
    }

    const document = await ctx.db.get(args.documentId);
    if (!document) return;

    const kindName = (parsed.primary_kind ?? "").trim().toLowerCase();
    const roles = (parsed.suggested_roles ?? [])
      .filter((r) => r.role?.trim() && r.question?.trim())
      .map((r) => ({
        role: r.role!.trim().toLowerCase(),
        question: r.question!.trim(),
        entityType: ["person", "organization", "place", "other"].includes(r.entity_type ?? "")
          ? r.entity_type!
          : "person",
      }));

    // Register the kind (never overwrite an existing template)
    if (kindName) {
      await ctx.runMutation(internal.kinds.upsert, {
        name: kindName,
        source: "ai",
        templateRoles: roles,
      });
    }

    // Human-set kind wins over the AI guess; tags merge
    const tagSet = new Set(document.tags ?? []);
    for (const t of parsed.tags ?? []) {
      if (typeof t === "string" && t.trim()) tagSet.add(t.trim().toLowerCase());
    }

    await ctx.db.patch(args.documentId, {
      ...(document.kindSource === "human" || !kindName
        ? {}
        : { kinds: [kindName], primaryKind: kindName, kindSource: "ai" }),
      tags: [...tagSet],
      suggestedRoles: roles,
      metadata: JSON.stringify({
        title: parsed.title,
        summary: parsed.summary,
        date: parsed.date,
        author: parsed.author,
        language: parsed.language,
        additional: parsed.additional ?? [],
      }),
      ...(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(
        (parsed.source_language_code ?? "").trim().toLowerCase().replaceAll("_", "-")
      )
        ? {
            sourceLanguageCode: parsed.source_language_code!
              .trim()
              .toLowerCase()
              .replaceAll("_", "-"),
          }
        : {}),
      ...(typeof parsed.is_multilingual === "boolean"
        ? { sourceLanguageIsMixed: parsed.is_multilingual }
        : {}),
    });

    // The document is now understood well enough to be named — hand that
    // context to the rename pass (convex/rename.ts).
    await ctx.scheduler.runAfter(0, internal.renameNode.runRenamePass, {
      documentId: args.documentId,
    });
  },
});

// ---------------------------------------------------------------------------
// Human edits to kind / tags / metadata
// ---------------------------------------------------------------------------

export const updateDocumentMeta = mutation({
  args: {
    documentId: v.id("documents"),
    primaryKind: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    metadata: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (!document) return;
    // The Info tab still edits a single kind; write the array alongside it so
    // the two never drift (documents.updateIdentity writes both as well).
    const kind = args.primaryKind?.trim().toLowerCase();
    await ctx.db.patch(args.documentId, {
      ...(args.primaryKind !== undefined
        ? {
            kinds: kind ? [kind] : [],
            primaryKind: kind || undefined,
            kindSource: "human",
          }
        : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
    });
  },
});

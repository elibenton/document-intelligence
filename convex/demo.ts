import { ConvexError, v } from "convex/values";
import {
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { RENDERER_VERSION } from "./rendererConfig";
import { requireBudget } from "./budget";
import { clientReportArgs, recordIssue } from "./issues";
import { requireDocument, requireProject } from "./ownership";
import { seedCategories } from "./documentCategories";
import { seedEntityTypes } from "./projectEntityTypes";
import { templateByKey, DEFAULT_TEMPLATE_KEY } from "./projectTemplates";
import { PROJECT_PHASE } from "./projects";
import { detectMediaType } from "./upload";
import {
  DEMO_ALREADY_USED,
  DEMO_MAX_BYTES,
  DEMO_MAX_PAGES,
  DEMO_TOO_LARGE,
  DEMO_UNAVAILABLE,
  DEMO_WRONG_TYPE,
} from "./demoLimits";

/**
 * The anonymous try-it-out path behind the landing page's dropzone.
 *
 * ## The one idea
 *
 * A demo session is an *owner id*. `projects.ownerId` is a `v.string()`, and
 * everything that asks "may this caller touch this row?" reduces to comparing
 * it (convex/ownership.ts). So a session that owns `demo:<token>` needs no
 * parallel access-control system, no second document table, and no bypass of
 * the ownership walk — it walks the same one, and the walk cannot tell the
 * difference. `userUsage` is keyed by the same string, so the spend cap in
 * convex/budget.ts already bills and already stops a demo session, unchanged.
 *
 * What this module adds is exactly one thing the rest of the backend does not
 * have: a way to arrive at an owner id without a Better Auth session.
 *
 * ## Why the limits are here and not in the browser
 *
 * Every Convex export is a public endpoint. The browser's checks — page count,
 * file type, size — exist to refuse a visitor *kindly and instantly*, before a
 * byte is uploaded. They are not the enforcement, because `curl` does not run
 * them. Each one is therefore restated below against something the server can
 * see for itself:
 *
 *   one file      `demoSessions.documentId` is already set → refuse.
 *   size          `_storage`'s own byte count, not the client's claim.
 *   file type     `_storage`'s sniffed contentType, not the client's MIME.
 *   spend         the existing `userUsage` ledger, at a demo-sized ceiling.
 *   page count    checked at `ingestParseResults`, the point where the real
 *                 count first exists (see `enforceDemoPageLimit`).
 *
 * ## The one limit that is not pre-spend, stated plainly
 *
 * Page count is not knowable before the parse call that costs money — pdf.js
 * does not run in a Convex mutation, and the byte count of a PDF says very
 * little about its page count. So a caller who skips the browser and posts a
 * 500-page, 2 MB text PDF does get one Scan+Analyze spent on it before
 * `enforceDemoPageLimit` fails the document. That overshoot is bounded by
 * DEMO_SESSION_LIMIT_USD per session and by DEMO_SESSIONS_PER_DAY sessions, so
 * the worst case is a bill, not an unbounded one, and it is a number that can
 * be read off the two constants below.
 *
 * The thing that would remove the overshoot is a per-IP gate, which needs an
 * httpAction to see `x-forwarded-for`. Not built: it is meaningfully more
 * machinery, and the daily cap already bounds the same money.
 */

// ---------------------------------------------------------------------------
// Limits. All of these are enforced below; the browser's copies are a courtesy.
//
// The two the browser also checks live in convex/demoLimits.ts, which imports
// nothing, so the landing page can read them without pulling this module — and
// so the number a visitor is shown is the number enforced here.
// ---------------------------------------------------------------------------

/**
 * What one demo session may spend before work stops, in USD. The measured cost
 * of a 12-page document is $0.066 (see CLAUDE.md), so this is roughly "one
 * document, with room for a retry" and not "one document exactly" — a session
 * that trips this has already had its answer.
 */
export const DEMO_SESSION_LIMIT_USD = 0.5;

/**
 * Sessions issued per rolling day, deployment-wide. This is the backstop that
 * turns "anyone may spend my money" into a number: at most
 * DEMO_SESSIONS_PER_DAY × DEMO_SESSION_LIMIT_USD, and in practice far less
 * because most sessions upload nothing.
 */
export const DEMO_SESSIONS_PER_DAY = 200;

/** How long a session's token, project and document survive before the sweep. */
export const DEMO_TTL_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export {
  DEMO_MAX_PAGES,
  DEMO_MAX_BYTES,
  DEMO_UNAVAILABLE,
  DEMO_ALREADY_USED,
  DEMO_TOO_LARGE,
  DEMO_WRONG_TYPE,
} from "./demoLimits";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The prefix that keeps demo owners and real owners disjoint. Better Auth ids
 * are base32-ish and contain no colon, so no crafted token can ever produce a
 * string that names a real account's project.
 */
const DEMO_OWNER_PREFIX = "demo:";

export function demoOwnerId(token: string): string {
  return DEMO_OWNER_PREFIX + token;
}

export function isDemoOwner(ownerId: string | undefined): boolean {
  return ownerId !== undefined && ownerId.startsWith(DEMO_OWNER_PREFIX);
}

/** 32 random bytes, hex. Unguessable, and the only credential a session has. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Same opaque failure for a malformed token, an unknown one and an expired
 * one, for the reason convex/ownership.ts gives: distinguishing them would
 * make this endpoint an oracle for which tokens exist.
 */
const DENIED = "Not found";

async function requireDemoSession(
  ctx: QueryCtx,
  token: string
): Promise<Doc<"demoSessions">> {
  if (!TOKEN_PATTERN.test(token)) throw new ConvexError(DENIED);
  const session = await ctx.db
    .query("demoSessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!session) throw new ConvexError(DENIED);
  if (Date.now() - session.createdAt > DEMO_TTL_MS) throw new ConvexError(DENIED);
  return session;
}

/**
 * The demo function builders, the mirror of `authedQuery`/`authedMutation` in
 * convex/authz.ts. They consume a `sessionToken` argument and hand the handler
 * the same `ctx.user` shape the authed builders do, which is what lets the
 * ownership helpers be called here verbatim rather than reimplemented.
 *
 * Trusting an identity that arrived in an argument is normally the bug — it is
 * how impersonation gets written. It is sound here for one reason, and only
 * this reason: the argument is an unguessable secret this server minted, and
 * the identity it names can own nothing but what that same secret created.
 * `convex/demo.test.ts` pins both halves.
 */
export const demoQuery = customQuery(query, {
  args: { sessionToken: v.string() },
  input: async (ctx, args) => {
    const session = await requireDemoSession(ctx, args.sessionToken);
    return {
      ctx: { session, user: { _id: demoOwnerId(session.token) } },
      args: {},
    };
  },
});

export const demoMutation = customMutation(mutation, {
  args: { sessionToken: v.string() },
  input: async (ctx, args) => {
    const session = await requireDemoSession(ctx, args.sessionToken);
    return {
      ctx: { session, user: { _id: demoOwnerId(session.token) } },
      args: {},
    };
  },
});

// ---------------------------------------------------------------------------
// Starting a session
// ---------------------------------------------------------------------------

/**
 * Mint a session, its project, and its budget row.
 *
 * The one endpoint here that cannot take a token, because it is what issues
 * one — so it is a bare `mutation`, the exception named in convex/authz.ts.
 *
 * The project is created rather than shared because ownership is per-project:
 * a shared "demo project" would make every visitor's document readable by
 * every other visitor, which is the same bug as an unowned project.
 */
export const startSession = mutation({
  args: {},
  returns: v.object({ sessionToken: v.string() }),
  handler: async (ctx) => {
    // Deployment-wide issuance cap. `take(cap + 1)` over the time range rather
    // than a count: the answer is a yes/no, so reading past the ceiling buys
    // nothing and a full scan would grow without bound.
    const since = Date.now() - DAY_MS;
    const recent = await ctx.db
      .query("demoSessions")
      .withIndex("by_createdAt", (q) => q.gt("createdAt", since))
      .take(DEMO_SESSIONS_PER_DAY + 1);
    if (recent.length > DEMO_SESSIONS_PER_DAY) {
      throw new ConvexError({
        code: DEMO_UNAVAILABLE,
        message:
          "The demo has hit its limit for today. Sign up for a free account to keep going.",
      });
    }

    const token = mintToken();
    const ownerId = demoOwnerId(token);

    const template = templateByKey(DEFAULT_TEMPLATE_KEY);
    if (!template) throw new Error("Default project template is missing");

    // No allocateSlug: nothing navigates to /p/:slug for a demo project, and
    // the allocator's collision loop would run once per demo session against a
    // name that is deliberately identical every time.
    const projectId = await ctx.db.insert("projects", {
      name: "Demo",
      slug: `demo-${token.slice(0, 12)}`,
      citationStyle: template.citationStyle,
      ownerId,
      createdAt: Date.now(),
    });
    await seedCategories(ctx, projectId, template.categories);
    await seedEntityTypes(ctx, projectId, template.entityTypes);

    await ctx.db.insert("demoSessions", {
      token,
      projectId,
      createdAt: Date.now(),
    });

    // The ceiling is written now rather than on first spend, because
    // `budgetFor` falls back to DEFAULT_LIMIT_USD ($10) for a missing row —
    // which is 150x what a demo session should ever be able to spend.
    await ctx.db.insert("userUsage", {
      userId: ownerId,
      spentUsd: 0,
      limitUsd: DEMO_SESSION_LIMIT_USD,
      updatedAt: Date.now(),
    });

    return { sessionToken: token };
  },
});

// ---------------------------------------------------------------------------
// Uploading the one file
// ---------------------------------------------------------------------------

export const generateUploadUrl = demoMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    // Refuse the URL, not just the document: a session that has already used
    // its file has no business holding a writable storage URL either.
    if (ctx.session.documentId) {
      throw new ConvexError({
        code: DEMO_ALREADY_USED,
        message: "The demo takes one file. Sign up to add more.",
      });
    }
    await requireBudget(ctx, ctx.user._id);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Create the demo document and start the same pipeline a real upload starts.
 *
 * Deliberately a near-copy of `upload.createDocument` rather than a shared
 * helper: that function's shape is "whatever the account is allowed to do",
 * and this one's is "one PDF, this small, once". Factoring them together would
 * mean a single function carrying both policies and a flag to pick between
 * them, which is how a demo limit gets bypassed by a caller who sets the flag.
 * The duplication is the enqueue block, and it is small enough to see.
 */
/**
 * The demo's failure reporter, gated by the session token the same way every
 * other demo endpoint is.
 *
 * Covers only what happens *after* a session exists — the upload, the finalize,
 * and the pipeline behind them. The demo's four earlier rejections (not a PDF,
 * over the byte cap, preflight failed, over the page cap) all run before
 * `startSession` on purpose, so that a file the demo was never going to accept
 * does not consume one of the day's DEMO_SESSIONS_PER_DAY. Reporting them would
 * mean minting a session to describe a file we just refused, which spends the
 * scarce thing to record the cheap one. They remain the known blind spot; the
 * fix is an anonymous rate-limited endpoint, not a session burned per rejection.
 */
export const reportIssue = demoMutation({
  args: clientReportArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordIssue(ctx, {
      ...args,
      // Demo visitors are anonymous, but each has a distinct synthetic owner —
      // so "how many people hit this" stays a real count here too.
      ownerId: ctx.user._id,
      documentId: ctx.session.documentId,
    });
    return null;
  },
});

export const createDocument = demoMutation({
  args: {
    name: v.string(),
    storageId: v.id("_storage"),
  },
  returns: v.object({ documentId: v.id("documents") }),
  handler: async (ctx, args) => {
    if (ctx.session.documentId) {
      throw new ConvexError({
        code: DEMO_ALREADY_USED,
        message: "The demo takes one file. Sign up to add more.",
      });
    }
    await requireBudget(ctx, ctx.user._id);
    const project = await requireProject(ctx, ctx.session.projectId);

    const storedFile = await ctx.db.system.get("_storage", args.storageId);
    if (!storedFile) throw new Error("Uploaded file not found in storage");

    // Both checks read `_storage`, never the arguments: the size and the
    // content type the client claimed are exactly the two things a caller
    // skipping the browser would lie about.
    if (storedFile.size > DEMO_MAX_BYTES) {
      await ctx.storage.delete(args.storageId);
      throw new ConvexError({
        code: DEMO_TOO_LARGE,
        message: `The demo takes files up to ${Math.round(
          DEMO_MAX_BYTES / 1_000_000
        )} MB. Sign up to upload larger ones.`,
      });
    }

    const mimeType = storedFile.contentType || "";
    if (detectMediaType(mimeType, args.name) !== "pdf") {
      await ctx.storage.delete(args.storageId);
      throw new ConvexError({
        code: DEMO_WRONG_TYPE,
        message:
          "The demo reads PDFs. Sign up to throw in spreadsheets, images and recordings too.",
      });
    }

    const documentId = await ctx.db.insert("documents", {
      projectId: project._id,
      name: args.name,
      storageId: args.storageId,
      mimeType,
      sizeBytes: storedFile.size,
      mediaType: "pdf",
      status: "uploaded",
      uploadedAt: Date.now(),
    });

    // Claim the session's one slot in the same transaction that creates the
    // document, so two tabs racing cannot both pass the check above.
    await ctx.db.patch(ctx.session._id, { documentId });

    const workId = await ctx.scheduler.runAfter(
      0,
      internal.processingNode.runDocumentUnderstanding,
      { documentId }
    );
    await ctx.db.insert("processingJobs", {
      documentId,
      stage: "parse",
      status: "pending",
      queuedAt: Date.now(),
      workId,
    });

    // Page images are rendered for the same reason they are on a real upload:
    // nothing here depends on them (the landing page draws pages from the
    // visitor's own local file with pdf.js), but leaving the document without
    // them would make it the odd one out if a visitor later signs up and the
    // document is carried across.
    await ctx.db.patch(documentId, {
      renderStatus: "queued",
      renderedPageCount: 0,
      rendererVersion: RENDERER_VERSION,
      renderAttempts: 0,
      renderScheduledAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.renderPages.renderBatch, {
      documentId,
      startPage: 0,
    });

    return { documentId };
  },
});

// ---------------------------------------------------------------------------
// The page limit, checked where the real page count first exists
// ---------------------------------------------------------------------------

/**
 * Fail a demo document that turned out to be longer than the demo allows.
 *
 * Called from `ingest.ingestParseResults`, which is where `pageCount` is first
 * written and therefore the earliest moment the true count is known. A no-op
 * for every non-demo document, at the cost of one `ctx.db.get` on a mutation
 * that has already read the document row.
 *
 * Returns whether it failed the document, so the caller can skip committing
 * pages for one that is not going to be shown.
 */
export async function enforceDemoPageLimit(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  pageCount: number
): Promise<boolean> {
  if (pageCount <= DEMO_MAX_PAGES) return false;
  const doc = await ctx.db.get(documentId);
  if (!doc?.projectId) return false;
  const project = await ctx.db.get(doc.projectId);
  if (!isDemoOwner(project?.ownerId)) return false;

  await ctx.db.patch(documentId, {
    status: "failed",
    errorMessage:
      `This is a ${pageCount}-page document, and the demo reads up to ` +
      `${DEMO_MAX_PAGES}. Sign up for a free account to read the whole thing.`,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Reading the result
// ---------------------------------------------------------------------------

/**
 * Everything the landing page's result panel shows, in one subscription.
 *
 * One endpoint rather than the six a signed-in document page uses, because the
 * demo shows a fixed, small set of facts and each additional demo endpoint is
 * another public surface to get the ownership walk right on. The pages
 * themselves are not here at all — the visitor's browser already has the file
 * it just dropped, and draws from that.
 */
export const result = demoQuery({
  args: {},
  handler: async (ctx) => {
    if (!ctx.session.documentId) return null;
    const doc = await requireDocument(ctx, ctx.session.documentId);

    const entities = await ctx.db
      .query("entities")
      .withIndex("by_project", (q) => q.eq("projectId", ctx.session.projectId))
      .take(60);

    return {
      documentId: doc._id,
      name: doc.name,
      displayName: doc.displayName ?? null,
      status: doc.status,
      errorMessage: doc.errorMessage ?? null,
      pageCount: doc.pageCount ?? null,
      kinds: doc.kinds ?? [],
      primaryCategory: doc.primaryCategory ?? null,
      documentDate: doc.documentDate ?? null,
      documentPlace: doc.documentPlace ?? null,
      // Capped rather than sent whole: the panel shows the shape of the
      // document, and a 300-entry contents list is not that.
      tableOfContents: (doc.tableOfContents ?? []).slice(0, 20),
      entities: entities
        .sort((a, b) => b.mentionCount - a.mentionCount)
        .map((e) => ({
          _id: e._id,
          name: e.name,
          type: e.type,
          mentionCount: e.mentionCount,
        })),
    };
  },
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/**
 * Drop expired sessions and everything they created.
 *
 * Anonymous uploads accumulate with nobody to delete them, so this is not
 * housekeeping — without it the demo is an unbounded storage lease handed to
 * the public. Reuses the project cascade rather than deleting rows here: that
 * cascade already knows how to cancel queued work and delete stored files, and
 * a second, demo-only teardown would be the copy that drifts.
 */
export const sweepExpired = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - DEMO_TTL_MS;
    const expired = await ctx.db
      .query("demoSessions")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(50);

    for (const session of expired) {
      const usage = await ctx.db
        .query("userUsage")
        .withIndex("by_user", (q) => q.eq("userId", demoOwnerId(session.token)))
        .unique();
      if (usage) await ctx.db.delete(usage._id);

      await ctx.db.delete(session._id);
      // Deleting the project row first is what makes the session unreachable
      // immediately; the cascade then drains its documents, entities and files.
      if (await ctx.db.get(session.projectId)) {
        await ctx.db.delete(session.projectId);
        await ctx.scheduler.runAfter(0, internal.projects.drainProjectDeletion, {
          projectId: session.projectId,
          phase: PROJECT_PHASE.documents,
        });
      }
    }
    return null;
  },
});

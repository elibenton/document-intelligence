/**
 * The failure ledger: one row per distinct kind of failure, counted.
 *
 * Every failure in the app funnels through `recordIssue`, for the reason
 * `chatCompletion` is the single Interfaze chokepoint — a chokepoint is the only
 * design where a call site added next month cannot forget to report. What comes
 * out is a list of problems ordered by how many people hit them, which is the
 * question "what should I fix first" in the only form that can be answered
 * automatically.
 *
 * Two rules hold everywhere below:
 *
 *  - **Recording never breaks the thing it describes.** Same contract as
 *    `usageLogger` in convex/apiLogs.ts: a failure in the failure reporter is a
 *    console line, never an exception thrown into a pipeline that was already
 *    having a bad time.
 *  - **Nothing user-written is stored raw.** Prose passes through
 *    convex/issueFingerprint.ts on the way in, and there is no path around it.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { adminQuery, authedMutation } from "./authz";
import {
  issueFingerprint,
  normalizeMessage,
  sampleText,
} from "./issueFingerprint";
import { OWNER_CAP, reopening, SAMPLE_CAP } from "./issueState";

/**
 * Which layer noticed the failure. Not a free string: the whole value of the
 * ledger is that two reports of the same defect land on the same row, and a
 * surface invented at one call site would split its group away from the others.
 */
export const SURFACES = [
  /** The browser, before or during upload — the pipeline never saw it. */
  "client",
  /** A processing stage (parse, analyze, extract, transcribe, relationships). */
  "pipeline",
  /** Page-derivative rendering. */
  "render",
  /** An Interfaze or embeddings call that returned an error. */
  "provider",
  /** An unhandled throw or a React render error. */
  "crash",
] as const;

export type IssueSurface = (typeof SURFACES)[number];

export const vSurface = v.union(
  v.literal("client"),
  v.literal("pipeline"),
  v.literal("render"),
  v.literal("provider"),
  v.literal("crash")
);

export interface IssueInput {
  surface: IssueSurface;
  stage: string;
  message: string;
  errorCode?: string;
  fileKind?: string;
  documentId?: Id<"documents">;
  ownerId?: string;
  buildSha?: string;
  sizeBytes?: number;
  pageCount?: number;
  mimeType?: string;
}

/**
 * Record one occurrence, creating or updating its group.
 *
 * Callable from any mutation. Actions reach it through `record` below, since
 * they have no `ctx.db`.
 */
export async function recordIssue(
  ctx: MutationCtx,
  input: IssueInput
): Promise<void> {
  try {
    await recordIssueUnguarded(ctx, input);
  } catch (e) {
    // See the file header: a broken reporter must not become the error the
    // user sees instead of the real one.
    console.error("Failed to record issue:", e);
  }
}

async function recordIssueUnguarded(ctx: MutationCtx, input: IssueInput) {
  const title = normalizeMessage(input.message);
  const fingerprint = issueFingerprint({
    surface: input.surface,
    stage: input.stage,
    errorCode: input.errorCode,
    fileKind: input.fileKind,
    normalized: title,
  });
  const now = Date.now();
  // A client report carries the build the *browser* is running, which is the
  // one that matters for a crash and may lag the backend's by a deploy.
  const buildSha = input.buildSha ?? process.env.BUILD_SHA?.slice(0, 7);
  const sample = {
    at: now,
    raw: sampleText(input.message),
    documentId: input.documentId,
    sizeBytes: input.sizeBytes,
    pageCount: input.pageCount,
    mimeType: input.mimeType,
  };

  const existing = await ctx.db
    .query("issues")
    .withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint))
    .unique();

  if (!existing) {
    await ctx.db.insert("issues", {
      fingerprint,
      surface: input.surface,
      stage: input.stage,
      errorCode: input.errorCode,
      title,
      fileKind: input.fileKind,
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      firstBuildSha: buildSha,
      lastBuildSha: buildSha,
      ownerSample: input.ownerId ? [input.ownerId] : [],
      ownersTruncated: false,
      samples: [sample],
      state: "open",
    });
    return;
  }

  const knowsOwner =
    !input.ownerId || existing.ownerSample.includes(input.ownerId);
  const roomForOwner = existing.ownerSample.length < OWNER_CAP;

  await ctx.db.patch(existing._id, {
    count: existing.count + 1,
    lastSeenAt: now,
    lastBuildSha: buildSha,
    ownerSample:
      knowsOwner || !roomForOwner
        ? existing.ownerSample
        : [...existing.ownerSample, input.ownerId!],
    ownersTruncated: existing.ownersTruncated || (!knowsOwner && !roomForOwner),
    samples: [sample, ...existing.samples].slice(0, SAMPLE_CAP),
    ...reopening(existing, now),
  });
}

/**
 * The reporting context a document carries: who pays for it, what kind of file
 * it is, how big it turned out to be.
 *
 * Resolved here rather than at each emitter for the reason `apiLogs.record`
 * resolves ownership at its own chokepoint — a new failure site cannot forget
 * to attribute itself. Returns an empty object rather than throwing for a
 * document that has since been deleted, which is a normal race when a failure
 * lands just after a delete.
 */
export async function documentIssueContext(
  ctx: MutationCtx,
  documentId: Id<"documents">
): Promise<Pick<IssueInput, "ownerId" | "fileKind" | "pageCount" | "mimeType">> {
  const doc = await ctx.db.get(documentId);
  if (!doc) return {};
  const project = doc.projectId ? await ctx.db.get(doc.projectId) : null;
  return {
    ownerId: project?.ownerId,
    fileKind: doc.mediaType ?? doc.mimeType,
    pageCount: doc.pageCount,
    mimeType: doc.mimeType,
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Shared argument shape for the two client-facing reporters.
 *
 * Two omissions, both deliberate:
 *
 *  - **No `ownerId`.** Identity is read from the session, never accepted from
 *    the caller, so nobody can file a report as someone else.
 *  - **No `documentId`, and none may ever be added here.** Partly because no
 *    client failure has one — preflight, conversion, the storage PUT and
 *    `createDocument` all fail before a document row exists — so it would be an
 *    argument nothing could fill. And partly because accepting one unchecked
 *    would let any signed-in user point an issue at a stranger's document, which
 *    plants false evidence for the triage agent to act on. Note that
 *    convex/ownership.test.ts would *not* catch that: it parses for a literal
 *    `args: {`, so a `v.id(...)` reached through this spread is invisible to it.
 *    Repro handles come from the internal reporters below, where the id is data
 *    the pipeline already holds rather than a claim from a browser.
 */
export const clientReportArgs = {
  surface: vSurface,
  stage: v.string(),
  message: v.string(),
  errorCode: v.optional(v.string()),
  fileKind: v.optional(v.string()),
  buildSha: v.optional(v.string()),
  sizeBytes: v.optional(v.number()),
  pageCount: v.optional(v.number()),
  mimeType: v.optional(v.string()),
};

/**
 * The browser's reporter for signed-in users.
 *
 * Deliberately *not* an unauthenticated endpoint. Every Convex export is a
 * public one, and a write anyone on the internet can call is a way to fill this
 * table with noise — so the two callers that exist are gated by a session
 * (here) and by a demo session (convex/demo.ts `reportIssue`). The known gap is
 * a crash on the landing page before either exists; if that turns out to
 * matter, the answer is @convex-dev/rate-limiter in front of an anonymous
 * endpoint, not an ungated one.
 */
export const report = authedMutation({
  args: clientReportArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordIssue(ctx, { ...args, ownerId: ctx.user._id });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Operator surface
// ---------------------------------------------------------------------------

/**
 * The triage queue, worst first.
 *
 * Ranked by distinct accounts affected rather than raw count, because raw count
 * is dominated by whoever bulk-uploaded a folder of the same broken file. The
 * count still breaks ties, and recency breaks those.
 *
 * Admin-only, and this is a real widening of what the operator can see: unlike
 * convex/admin.ts, which refuses anything document-derived, these rows carry
 * scrubbed provider prose and a document id to re-run. That is the price of
 * reports that diagnose rather than restate. What holds the line is that the
 * scrubbing happens at write time (issueFingerprint.ts), no document *text*
 * ever enters this table, and samples are capped at three.
 */
const vState = v.union(
  v.literal("open"),
  v.literal("triaged"),
  v.literal("resolved"),
  v.literal("ignored")
);

const listArgs = {
  state: v.optional(vState),
  limit: v.optional(v.number()),
};

/**
 * One ranking, two callers.
 *
 * The admin page and the triage agent must not be able to disagree about which
 * problem is worst, so the ordering lives here and both read it — the internal
 * twin pattern convex/authz.ts describes, for the same reason it exists there:
 * the agent reaches the deployment through the Convex MCP with a deployment
 * key and no user identity, so `adminQuery` refuses it.
 */
type IssueState = "open" | "triaged" | "resolved" | "ignored";

async function rankedIssues(
  ctx: QueryCtx,
  args: { state?: IssueState; limit?: number }
) {
  const limit = Math.min(args.limit ?? 50, 200);
  const state = args.state;
  const rows = state
    ? await ctx.db
        .query("issues")
        .withIndex("by_state_and_lastSeen", (q) => q.eq("state", state))
        .order("desc")
        .take(limit)
    : await ctx.db.query("issues").order("desc").take(limit);

  return rows
    .map((row) => ({ ...row, affectedOwners: row.ownerSample.length }))
    .sort(
      (a, b) =>
        b.affectedOwners - a.affectedOwners ||
        b.count - a.count ||
        b.lastSeenAt - a.lastSeenAt
    );
}

/**
 * The triage queue, worst first.
 *
 * Ranked by distinct accounts affected rather than raw count, because raw count
 * is dominated by whoever bulk-uploaded a folder of the same broken file. The
 * count still breaks ties, and recency breaks those.
 *
 * Admin-only, and this is a real widening of what the operator can see: unlike
 * convex/admin.ts, which refuses anything document-derived, these rows carry
 * scrubbed provider prose and a document id to re-run. That is the price of
 * reports that diagnose rather than restate. What holds the line is that the
 * scrubbing happens at write time (issueFingerprint.ts), no document *text*
 * ever enters this table, and samples are capped at three.
 */
export const list = adminQuery({
  args: listArgs,
  handler: async (ctx, args) => rankedIssues(ctx, args),
});

/** The same queue, for the triage agent. See `rankedIssues`. */
export const listForTriage = internalQuery({
  args: listArgs,
  handler: async (ctx, args) => rankedIssues(ctx, args),
});

/**
 * The triage agent's write-back.
 *
 * Internal rather than admin-gated, and that is the stronger choice on both
 * counts: it is the only channel the agent can actually use, and an internal
 * function is not a public endpoint at all — where an `adminMutation` would be
 * one more reachable, unauthenticated-by-default export guarded only by a
 * check. Nothing in the browser writes triage.
 */
export const saveTriage = internalMutation({
  args: {
    issueId: v.id("issues"),
    markdown: v.string(),
    buildSha: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const issue = await ctx.db.get(args.issueId);
    if (!issue) return null;
    await ctx.db.patch(args.issueId, {
      state: "triaged",
      regressedAt: undefined,
      triage: {
        markdown: args.markdown,
        // The count *now*, so later regrowth past it is what reopens the row.
        atCount: issue.count,
        at: Date.now(),
        buildSha: args.buildSha ?? process.env.BUILD_SHA?.slice(0, 7),
      },
    });
    return null;
  },
});

/** Move an issue between states — "I fixed this", "this is working as intended". */
export const setState = internalMutation({
  args: { issueId: v.id("issues"), state: vState },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.issueId, {
      state: args.state,
      regressedAt: undefined,
    });
    return null;
  },
});

/**
 * Cohere Command A+ — the B side of the search-synthesis A/B test.
 *
 * One call shape: a grounded answer over the retrieved pages via the v2 chat
 * API's `documents` parameter. Command A+ emits citations in-model (span
 * offsets in `message.citations`), which is the experiment: the Interfaze
 * side proves its citations post-hoc (answerVerification.ts), this side ships
 * the model's own grounding untouched. The spans are rewritten to the same
 * bare `[n]` markers the verifier grammar and renderer already share, so both
 * answers flow through one UI.
 *
 * Plain fetch, no SDK — one endpoint, and staying off "use node" keeps it
 * callable from the same action as the rest of the search pipeline.
 *
 * Response shape pinned by a live probe (2026-08-19): `content` carries a
 * `thinking` block before the `text` block (A+ reasons by default), citation
 * offsets are relative to their own block via `content_index`, sources echo
 * the caller's document ids, and `usage.billed_units` is what's billed
 * (`usage.tokens` reports more — reasoning and unbilled prompt overhead).
 */

import type { UsageLogger } from "./interfazeCost";

export const COHERE_MODEL = "command-a-plus-05-2026";

// Cohere platform list price for Command A+. The pricing page lags the model
// (checked 2026-08-19); rate confirmed against launch coverage.
const COHERE_USD_PER_M_INPUT = 2.5;
const COHERE_USD_PER_M_OUTPUT = 10;

/** The id of the entity-graph pseudo-document. Non-numeric on purpose: a
 *  claim it grounds is kept, but there is no evidence page to mark, exactly
 *  like the Interfaze prompt's known-facts block. */
const FACTS_DOCUMENT_ID = "facts";

/**
 * How much document text one grounded call may carry. Spent in rank order,
 * the same bargain as SYNTHESIS_CHAR_BUDGET in search.ts: the best hits go
 * whole, and a long page costs later ones their slot rather than everyone a
 * slice. A skipped source keeps its number — ids are positions in the
 * caller's list — so it simply cannot be cited, which is honest: the model
 * never saw it. ~20k tokens, so one call is ~$0.05 of input.
 */
const COHERE_DOC_CHAR_BUDGET = 80_000;
/** Below this, a page's remaining slice isn't worth a citation slot. */
const MIN_USEFUL_DOC_CHARS = 500;

interface CohereContentBlock {
  type?: string;
  text?: string;
}

export interface CohereCitation {
  start?: number;
  end?: number;
  /** The answer text the span covers — what the citation claims to ground. */
  text?: string;
  /** Which content block the offsets index into. */
  content_index?: number;
  sources?: Array<{ id?: string; document?: { id?: string } }>;
}

interface CohereChatResponse {
  message?: {
    content?: CohereContentBlock[];
    citations?: CohereCitation[];
  };
  finish_reason?: string;
  usage?: {
    billed_units?: { input_tokens?: number; output_tokens?: number };
  };
}

/**
 * Join the text blocks and rewrite Cohere's span citations as `[n]` markers
 * at each span's end. Only numeric source ids become markers — those are the
 * 1-based positions in the numbered source list, the same numbers
 * `searches.results` is indexed by. Offsets are block-relative, so each
 * block's base offset in the joined text is added first; a citation without
 * a content_index is treated as indexing the joined text directly.
 */
export function insertCitationMarkers(
  content: CohereContentBlock[],
  citations: CohereCitation[]
): string {
  const base: number[] = [];
  let text = "";
  for (const block of content) {
    base.push(text.length);
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }

  // Cited source numbers by insertion offset, deduped — the model often
  // cites one span from several sources and adjacent spans from one source.
  const byOffset = new Map<number, Set<number>>();
  for (const citation of citations) {
    if (typeof citation.end !== "number") continue;
    const blockBase =
      citation.content_index === undefined
        ? 0
        : (base[citation.content_index] ?? 0);
    const offset = Math.max(0, Math.min(text.length, blockBase + citation.end));
    for (const source of citation.sources ?? []) {
      const id = source.document?.id ?? source.id;
      if (!id || !/^\d+$/.test(id)) continue;
      const numbers = byOffset.get(offset) ?? new Set<number>();
      numbers.add(Number(id));
      byOffset.set(offset, numbers);
    }
  }

  // Inserted back-to-front so earlier offsets stay valid.
  let out = text;
  for (const [offset, numbers] of [...byOffset.entries()].sort(
    (a, b) => b[0] - a[0]
  )) {
    const markers = [...numbers]
      .sort((a, b) => a - b)
      .map((n) => `[${n}]`)
      .join("");
    out = out.slice(0, offset) + markers + out.slice(offset);
  }
  return out;
}

/** Words and numbers that carry attribution signal for one cited span. */
function attributionTokens(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

/** How much of a span's vocabulary a source must contain to claim it. */
const ATTRIBUTION_FLOOR = 0.5;

/**
 * Command A+'s native span attribution collapses non-deterministically on
 * multi-document payloads: measured 2026-08-19 replaying one real search,
 * identical ~9k-token requests attributed citations across 7 sources on one
 * run and stamped every one of 13 citations onto document "1" on the next.
 * Temperature 0, smaller documents, fewer documents, and chunking all failed
 * to stabilize it; the spans themselves stay correct — only the document ids
 * degenerate, always onto the first document.
 *
 * So when a response shows the degenerate signature — several documents
 * provided, three or more citations, every one naming the same source — the
 * ids are noise, and each span is re-pointed at the source whose text
 * actually contains its vocabulary (ties to the higher-ranked source). Spans
 * no source can claim lose their citation rather than keep a false one. The
 * answer text is never touched: this is attribution repair, deliberately not
 * the claim-removal gate the Interfaze side runs (answerVerification.ts) —
 * bypassing that gate is the point of the A/B.
 */
export function repairCitationSources(
  citations: CohereCitation[],
  documents: Array<{ id: string; text: string }>
): CohereCitation[] {
  if (documents.length <= 1 || citations.length < 3) return citations;
  const citedIds = new Set(
    citations.flatMap((c) =>
      (c.sources ?? []).flatMap((s) => {
        const id = s.document?.id ?? s.id;
        return id === undefined ? [] : [id];
      })
    )
  );
  if (citedIds.size !== 1) return citations;

  const docTokens = documents.map((d) => ({
    id: d.id,
    tokens: new Set(attributionTokens(d.text)),
  }));
  return citations.map((citation) => {
    const tokens = attributionTokens(citation.text ?? "");
    let best: { id: string; score: number } | null = null;
    for (const doc of docTokens) {
      const score =
        tokens.length === 0
          ? 0
          : tokens.filter((t) => doc.tokens.has(t)).length / tokens.length;
      if (score >= ATTRIBUTION_FLOOR && (!best || score > best.score)) {
        best = { id: doc.id, score };
      }
    }
    return { ...citation, sources: best ? [{ id: best.id }] : [] };
  });
}

/**
 * Ask Command A+ the question over the numbered sources. Returns the answer
 * as markdown with `[n]` markers. Throws on transport errors and on an empty
 * response; the caller decides whether that is fatal to the search.
 */
export async function cohereGroundedAnswer(
  apiKey: string,
  args: {
    question: string;
    /** In rank order — position i becomes source number i + 1. */
    sources: Array<{ title: string; text: string }>;
    facts: string[];
    log?: UsageLogger;
  }
): Promise<string> {
  const startedAt = Date.now();
  const report = async (r: {
    status: "ok" | "error";
    promptTokens?: number;
    completionTokens?: number;
    finishReason?: string;
    error?: string;
    errorCode?: string;
  }) => {
    const promptTokens = r.promptTokens ?? 0;
    const completionTokens = r.completionTokens ?? 0;
    await args.log?.({
      provider: "cohere",
      operation: "search_answer",
      model: COHERE_MODEL,
      status: r.status,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd:
        (promptTokens * COHERE_USD_PER_M_INPUT +
          completionTokens * COHERE_USD_PER_M_OUTPUT) /
        1e6,
      durationMs: Date.now() - startedAt,
      finishReason: r.finishReason,
      error: r.error,
      errorCode: r.errorCode,
      buildSha: process.env.BUILD_SHA?.slice(0, 7),
    });
  };

  const documents: Array<{
    id: string;
    data: { title: string; snippet: string };
  }> = [];
  let remaining = COHERE_DOC_CHAR_BUDGET;
  args.sources.forEach((source, i) => {
    if (remaining < MIN_USEFUL_DOC_CHARS) return;
    const text =
      source.text.length <= remaining
        ? source.text
        : source.text.slice(0, remaining);
    remaining -= text.length;
    documents.push({
      id: String(i + 1),
      data: { title: source.title, snippet: text },
    });
  });
  if (args.facts.length > 0) {
    documents.push({
      id: FACTS_DOCUMENT_ID,
      data: {
        title: "Known facts (from the entity graph extracted across the corpus)",
        snippet: args.facts.map((fact) => `- ${fact}`).join("\n"),
      },
    });
  }

  const res = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: COHERE_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You answer questions about a private document corpus. Write ONLY what the provided documents explicitly state — never fill gaps, infer, estimate, or combine facts the documents do not state themselves. An incomplete answer is correct; an answer completed from memory is worthless. If the documents answer only part of the question, answer that part and say plainly what the corpus does not establish. Use markdown structure where it helps the reader.",
        },
        { role: "user", content: args.question },
      ],
      documents,
      max_tokens: 2000,
    }),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    await report({
      status: "error",
      error: `HTTP ${res.status}. ${body}`,
      errorCode: `http_${res.status}`,
    });
    throw new Error(`Cohere chat failed (HTTP ${res.status}). ${body}`);
  }

  const data = (await res.json()) as CohereChatResponse;
  const content = data.message?.content ?? [];
  const citations = repairCitationSources(
    data.message?.citations ?? [],
    documents.map((d) => ({ id: d.id, text: d.data.snippet }))
  );
  const answer = insertCitationMarkers(content, citations);

  if (!answer.trim()) {
    await report({
      status: "error",
      promptTokens: data.usage?.billed_units?.input_tokens,
      completionTokens: data.usage?.billed_units?.output_tokens,
      finishReason: data.finish_reason,
      error: "Empty answer text in a 200 response",
      errorCode: "empty_response",
    });
    throw new Error("empty_cohere_response");
  }

  await report({
    status: "ok",
    promptTokens: data.usage?.billed_units?.input_tokens,
    completionTokens: data.usage?.billed_units?.output_tokens,
    finishReason: data.finish_reason,
  });
  return answer;
}

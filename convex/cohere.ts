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

interface CohereContentBlock {
  type?: string;
  text?: string;
}

export interface CohereCitation {
  start?: number;
  end?: number;
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

  const documents = [
    ...args.sources.map((source, i) => ({
      id: String(i + 1),
      data: { title: source.title, snippet: source.text },
    })),
    ...(args.facts.length > 0
      ? [
          {
            id: FACTS_DOCUMENT_ID,
            data: {
              title: "Known facts (from the entity graph extracted across the corpus)",
              snippet: args.facts.map((fact) => `- ${fact}`).join("\n"),
            },
          },
        ]
      : []),
  ];

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
  const answer = insertCitationMarkers(content, data.message?.citations ?? []);

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

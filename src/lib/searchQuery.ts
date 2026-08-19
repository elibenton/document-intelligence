// Structured search syntax: `kind:"tax form" refund` parses into free text
// plus typed prefix terms that SearchBar renders as chips and the backend
// turns into index-level filters. Pure module, shared by SearchBar (chip
// editing) and SearchPage (URL round-trip), so both sides agree on one
// grammar.

/** Canonical prefixes. Aliases (`in:` → `doc:`) resolve during parsing. */
export type SearchPrefix =
  | "doc"
  | "person"
  | "org"
  | "place"
  | "title"
  | "file"
  | "lang"
  | "kind"
  | "category"
  | "tag"
  | "date"
  | "before"
  | "after"
  | "quote"
  | "note";

const ALIASES: Record<string, SearchPrefix> = {
  in: "doc",
  organization: "org",
};

const KNOWN = new Set<string>([
  "doc",
  "person",
  "org",
  "place",
  "title",
  "file",
  "lang",
  "kind",
  "category",
  "tag",
  "date",
  "before",
  "after",
  "quote",
  "note",
]);

export interface PrefixTerm {
  prefix: SearchPrefix;
  /** Exactly as typed, for popping a chip back into the input. */
  raw: string;
  /** Unquoted value, curly quotes normalized. */
  value: string;
  /** Offsets into the source string. */
  start: number;
  end: number;
}

export interface ParsedQuery {
  /** Everything not consumed by a recognized prefix. */
  text: string;
  terms: PrefixTerm[];
}

// A term is `prefix:` followed by either a quoted run (straight or curly
// quotes) or a bare token. An unrecognized prefix stays in the text — a
// document titled "Re: Smith" must not lose tokens to the parser.
const TERM = /([A-Za-z]+):("([^"“”]*)["”]?|“([^"“”]*)[”"]?|(\S*))/g;

const normalizeQuotes = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

export function parseQuery(input: string): ParsedQuery {
  const terms: PrefixTerm[] = [];
  const textParts: string[] = [];
  let cursor = 0;
  TERM.lastIndex = 0;
  for (let m = TERM.exec(input); m !== null; m = TERM.exec(input)) {
    const typedPrefix = m[1].toLowerCase();
    const canonical = ALIASES[typedPrefix] ?? typedPrefix;
    if (!KNOWN.has(canonical)) continue;
    textParts.push(input.slice(cursor, m.index));
    const value = m[3] ?? m[4] ?? m[5] ?? "";
    terms.push({
      prefix: canonical as SearchPrefix,
      raw: m[0],
      value: normalizeQuotes(value).trim(),
      start: m.index,
      end: m.index + m[0].length,
    });
    cursor = m.index + m[0].length;
  }
  textParts.push(input.slice(cursor));
  const text = textParts.join(" ").replace(/\s+/g, " ").trim();
  return { text, terms };
}


const needsQuotes = (value: string) => value === "" || /\s/.test(value);

export function serializeTerm(prefix: SearchPrefix, value: string): string {
  const clean = normalizeQuotes(value).trim();
  return needsQuotes(clean) ? `${prefix}:"${clean}"` : `${prefix}:${clean}`;
}

/** Canonical string form: terms in order, then free text, single-spaced.
 * `parseQuery(serializeQuery(p))` is stable, which is what makes the URL
 * round-trip and the search-history cache key work with no extra state. */
export function serializeQuery(parsed: ParsedQuery): string {
  const parts = parsed.terms.map((t) => serializeTerm(t.prefix, t.value));
  if (parsed.text) parts.push(parsed.text);
  return parts.join(" ");
}

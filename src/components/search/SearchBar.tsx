import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import {
  Building2,
  ChevronDown,
  FileText,
  Hash,
  Highlighter,
  History,
  MapPin,
  RefreshCw,
  Search,
  Sparkles,
  User,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { DocTypeIcon } from "@/components/documents/DocTypeIcon";
import { entitySlug } from "@/lib/entitySlug";
import {
  parseQuery,
  serializeQuery,
  type PrefixTerm,
} from "@/lib/searchQuery";

/** Chip prefixes the suggest query can push down to an index filter today.
 *  Everything else still serializes into the deep-search query string. */
function scopeFromChips(chips: PrefixTerm[]) {
  const scope: {
    entityType?: string;
    docField?: "title" | "file";
    languageCode?: string;
    kind?: string;
    category?: string;
    annotations?: { field: "text" | "comment"; q: string };
  } = {};
  for (const chip of chips) {
    if (!chip.value) continue;
    if (chip.prefix === "person") scope.entityType = "person";
    else if (chip.prefix === "org") scope.entityType = "organization";
    else if (chip.prefix === "place") scope.entityType = "place";
    else if (chip.prefix === "title") scope.docField = "title";
    else if (chip.prefix === "file") scope.docField = "file";
    else if (chip.prefix === "lang") scope.languageCode = chip.value.toLowerCase();
    else if (chip.prefix === "kind") scope.kind = chip.value.toLowerCase();
    else if (chip.prefix === "category") scope.category = chip.value.toLowerCase();
    else if (chip.prefix === "quote")
      scope.annotations = { field: "text", q: chip.value };
    else if (chip.prefix === "note")
      scope.annotations = { field: "comment", q: chip.value };
  }
  return Object.keys(scope).length > 0 ? scope : undefined;
}

function EntityTypeIcon({ type }: { type: string }) {
  const cls = "size-4 text-muted-foreground shrink-0";
  if (type === "person" || type === "people") return <User className={cls} />;
  if (type === "organization") return <Building2 className={cls} />;
  if (type === "place" || type === "places") return <MapPin className={cls} />;
  return <Hash className={cls} />;
}

/** Bold the query terms inside a suggestion string. */
function Highlight({ text, query }: { text: string; query: string }) {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return <>{text}</>;
  const re = new RegExp(`(${tokens.join("|")})`, "gi");
  // split with a capture group alternates non-match / match parts
  const parts = text.split(re);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-transparent text-foreground font-semibold">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

type Item =
  | { kind: "ask" }
  | { kind: "suggested"; query: string }
  | { kind: "history"; id: string; query: string }
  | { kind: "entity"; name: string; type: string; mentionCount: number }
  | {
      kind: "document";
      documentId: string;
      name: string;
      /** The upload filename, present only when it differs from the title. */
      filename?: string;
      mediaType?: string;
      mimeType: string;
    }
  | {
      kind: "page";
      documentId: string;
      documentName: string;
      pageNumber: number;
      snippet: string;
    }
  | {
      kind: "highlight";
      annotationId: string;
      documentId: string;
      documentName: string;
      pageNumber: number;
      text: string;
      comment: string | null;
      timeStart: number | null;
    };

const SUGGESTED_QUESTION_SETS = [
  [
    "Which people or organizations appear most connected, and what evidence supports those links?",
    "Where do the sources agree or contradict one another on the key events?",
    "What timeline of important events emerges across the documents?",
  ],
  [
    "What claims recur across sources, and how does the supporting evidence differ?",
    "Which relationships are supported by multiple independent sources?",
    "What important gaps or unanswered questions remain in this collection?",
  ],
  [
    "Who influenced the major decisions described in these sources, and how?",
    "What changes in roles, positions, or relationships occur over time?",
    "Which documents contain the strongest evidence for the central issues?",
  ],
  [
    "What patterns would be easy to miss when reading each source separately?",
    "Which entities act as bridges between otherwise separate groups?",
    "What facts are disputed, uncertain, or supported by only one source?",
  ],
] as const;

/** Briefly worn by the input after ⌘K, so the bar is findable on the page. */
const FLASH_CLASSES = ["ring-2", "ring-primary/60", "shadow-md"];

const DEFAULT_RECENT_COUNT = 5;
const RECENT_COUNT_STEP = 5;

export default function SearchBar({
  projectId,
  focusSignal,
  onNavigate,
}: {
  projectId: Id<"projects">;
  /**
   * A counter the page bumps on ⌘K. Each bump focuses and selects the input,
   * and flashes a ring so the bar is findable when it was already on screen.
   */
  focusSignal?: number;
  /** Fired just before a result navigates — lets a host modal close itself. */
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  // Committed prefix terms, rendered as removable chips above the input —
  // deliberately outside the combobox ARIA below: real buttons in natural
  // tab order, so the input's delicate listbox wiring stays untouched.
  const [chips, setChips] = useState<PrefixTerm[]>([]);
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [questionSetIndex, setQuestionSetIndex] = useState(0);
  const [recentCount, setRecentCount] = useState(DEFAULT_RECENT_COUNT);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // The list is max-h-[32rem] with its own scroller, so moving `active` past
  // the fold used to slide an invisible highlight — the row was never scrolled
  // into view.
  const activeRowRef = useRef<HTMLDivElement>(null);

  // The ring is a transient on the DOM node, not React state: nothing else
  // renders from it, and a state flag here would re-render the whole dropdown
  // twice per ⌘K just to add and remove a class.
  useEffect(() => {
    if (!focusSignal) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
    input.classList.add(...FLASH_CLASSES);
    const timer = setTimeout(() => input.classList.remove(...FLASH_CLASSES), 900);
    return () => clearTimeout(timer);
  }, [focusSignal]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 150);
    return () => clearTimeout(t);
  }, [value]);

  // Prefixes typed but not yet committed to chips are stripped before the
  // text hits the search indexes — "kind:me" mid-typing is not page text.
  const debouncedText = useMemo(() => parseQuery(debounced).text, [debounced]);
  const scope = useMemo(() => scopeFromChips(chips), [chips]);
  const suggestions = useQuery(
    api.search.suggest,
    // A quote:/note: chip is a complete query on its own — the annotation
    // leg runs on the chip's value, no free text required.
    debouncedText.length >= 2 || scope?.annotations
      ? { q: debouncedText, projectId, scope }
      : "skip"
  );
  // Past deep searches — shown when the bar is focused but empty; selecting
  // one loads the stored result (no re-run).
  const recentSearches = useQuery(
    api.search.recent,
    open && !value.trim() ? { projectId } : "skip"
  );

  const completedRecentSearches = useMemo(
    () => (recentSearches ?? []).filter((search) => search.status === "completed"),
    [recentSearches]
  );

  // Flatten into one keyboard-navigable list; the "ask" row leads.
  const items = useMemo<Item[]>(() => {
    if (!value.trim() && chips.length > 0) {
      // Chips alone are a runnable deep search — and a quote:/note: chip
      // already has its matches in hand.
      const list: Item[] = [{ kind: "ask" }];
      for (const h of suggestions?.highlights ?? [])
        list.push({
          kind: "highlight",
          ...h,
          annotationId: h.annotationId as string,
          documentId: h.documentId as string,
        });
      return list;
    }
    if (!value.trim()) {
      return [
        ...SUGGESTED_QUESTION_SETS[questionSetIndex].map((query) => ({
          kind: "suggested" as const,
          query,
        })),
        ...completedRecentSearches.slice(0, recentCount).map((search) => ({
          kind: "history" as const,
          id: search._id,
          query: search.query,
        })),
      ];
    }
    // Library first: a typed word is most often the name of a document the
    // user already has in mind. Entities and page hits follow as ways in when
    // it wasn't. Section headings come from this order (see firstOfKind).
    const list: Item[] = [{ kind: "ask" }];
    for (const h of suggestions?.highlights ?? [])
      list.push({
        kind: "highlight",
        ...h,
        annotationId: h.annotationId as string,
        documentId: h.documentId as string,
      });
    for (const d of suggestions?.documents ?? [])
      list.push({ kind: "document", ...d, documentId: d.documentId as string });
    for (const e of suggestions?.entities ?? [])
      list.push({ kind: "entity", ...e });
    for (const p of suggestions?.pages ?? [])
      list.push({ kind: "page", ...p, documentId: p.documentId as string });
    return list;
  }, [
    value,
    chips,
    suggestions,
    completedRecentSearches,
    questionSetIndex,
    recentCount,
  ]);

  // Close on click outside
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  /** The full query, chips included — what deep search receives and what a
   *  shared URL round-trips through the parser. */
  function effectiveQuery(): string {
    const parsed = parseQuery(value);
    return serializeQuery({
      text: parsed.text,
      terms: [...chips, ...parsed.terms],
    });
  }

  /** Commit terminated prefix terms into chips as they're typed. A term at
   *  the caret's edge ("kind:me", 'kind:"tax') is still being typed and
   *  stays in the input; anything followed by more text, or by a trailing
   *  space, is done. */
  function handleChange(raw: string) {
    const parsed = parseQuery(raw);
    const done = parsed.terms.filter(
      (t) => t.value !== "" && (t.end < raw.length || /\s$/.test(raw))
    );
    if (done.length > 0) {
      setChips((prev) => [...prev, ...done]);
      let rest = "";
      let cursor = 0;
      for (const t of done) {
        rest += raw.slice(cursor, t.start);
        cursor = t.end;
      }
      rest += raw.slice(cursor);
      setValue(rest.replace(/\s{2,}/g, " ").trimStart());
    } else {
      setValue(raw);
    }
    setActive(0);
    setOpen(true);
  }

  /** Backspace at the caret's start pops the last chip back into the input
   *  as its typed text — one keystroke recovers it for editing. */
  function popChipIntoInput(): boolean {
    if (chips.length === 0) return false;
    const last = chips[chips.length - 1];
    setChips((prev) => prev.slice(0, -1));
    setValue(last.raw + (value ? ` ${value}` : ""));
    return true;
  }

  function go(item: Item) {
    setOpen(false);
    inputRef.current?.blur();
    onNavigate?.();
    switch (item.kind) {
      case "ask":
        navigate(
          `/search?q=${encodeURIComponent(effectiveQuery())}&project=${projectId}`
        );
        break;
      case "suggested":
        navigate(
          `/search?q=${encodeURIComponent(item.query)}&project=${projectId}`
        );
        break;
      case "history":
        navigate(`/search?id=${item.id}`);
        break;
      case "entity":
        navigate(`/entity/${entitySlug(item.name)}?project=${projectId}`);
        break;
      case "document":
        navigate(`/documents/${item.documentId}`);
        break;
      case "page":
        navigate(
          `/documents/${item.documentId}?page=${item.pageNumber + 1}&highlight=${encodeURIComponent(debouncedText)}`
        );
        break;
      case "highlight":
        // The annotation's own text is the highlight target — the viewer
        // lands on the exact passage the note marks.
        navigate(
          `/documents/${item.documentId}?page=${item.pageNumber + 1}&highlight=${encodeURIComponent(item.text.slice(0, 80))}`
        );
        break;
    }
  }

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Home" && open && items.length > 0) {
      e.preventDefault();
      setActive(0);
      return;
    }
    if (e.key === "End" && open && items.length > 0) {
      e.preventDefault();
      setActive(items.length - 1);
      return;
    }
    if (
      e.key === "Backspace" &&
      inputRef.current?.selectionStart === 0 &&
      inputRef.current?.selectionEnd === 0
    ) {
      if (popChipIntoInput()) {
        e.preventDefault();
        return;
      }
    }
    if (!open || items.length === 0) {
      if (e.key === "Enter" && (value.trim() || chips.length > 0)) {
        go({ kind: "ask" });
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(items[active] ?? { kind: "ask" });
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // Group boundaries for section labels in the dropdown
  const firstOfKind = (index: number) =>
    index === 0 || items[index].kind !== items[index - 1].kind;
  const groupLabel: Record<Exclude<Item["kind"], "ask">, string> = {
    suggested: "Suggested deep searches",
    history: "Recent searches",
    entity: "Entities",
    document: "Library",
    page: "In documents",
    highlight: "Highlights",
  };

  const rowClass = (index: number) =>
    `flex items-center gap-2.5 w-full text-left px-3 py-2 cursor-pointer ${
      active === index ? "bg-accent" : ""
    }`;

  function itemKey(item: Item): string {
    switch (item.kind) {
      case "ask":
        return "ask";
      case "suggested":
        return `suggested:${item.query}`;
      case "history":
        return `history:${item.id}`;
      case "entity":
        return `entity:${item.type}:${item.name}`;
      case "document":
        return `document:${item.documentId}`;
      case "page":
        return `page:${item.documentId}:${item.pageNumber}`;
      case "highlight":
        return `highlight:${item.annotationId}`;
    }
  }

  const remainingRecentSearches = Math.max(
    0,
    completedRecentSearches.length - recentCount
  );

  function generateMoreQuestions() {
    setQuestionSetIndex(
      (index) => (index + 1) % SUGGESTED_QUESTION_SETS.length
    );
    setActive(0);
  }

  return (
    <div ref={rootRef} className="relative mx-auto w-full max-w-3xl">
      {chips.length > 0 && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          {chips.map((chip, index) => (
            <span
              key={`${chip.prefix}:${chip.value}:${index}`}
              className="inline-flex items-center gap-1 rounded-full border bg-card py-0.5 pl-2 pr-1 text-xs"
            >
              <span className="font-medium text-primary">{chip.prefix}:</span>
              <span className="max-w-48 truncate">{chip.value}</span>
              <button
                type="button"
                aria-label={`Remove ${chip.prefix}:${chip.value} filter`}
                onClick={() => {
                  setChips((prev) => prev.filter((_, i) => i !== index));
                  inputRef.current?.focus();
                }}
                className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          /* Base UI's Autocomplete can host this list (mode="none" takes
             server-filtered items), but not its two nested action buttons:
             "Generate 3 more" and "Show 5 more" live *inside* group headings,
             and Autocomplete owns click and keyboard handling for everything
             under its List. Moving them out is a suggestion-UX change, not a
             migration. What is here is now the full WAI-ARIA combobox pattern
             — listbox/option ownership, aria-controls, aria-activedescendant,
             a roving active index, Home/End and scroll-into-view — so what is
             left is composition, not correctness. */
          // eslint-disable-next-line no-restricted-syntax
          role="combobox"
          aria-expanded={open && items.length > 0}
          aria-controls="search-suggestions"
          aria-autocomplete="list"
          aria-activedescendant={
            open && items.length > 0 ? `search-option-${active}` : undefined
          }
          aria-label="Search"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search people, documents, connections — or ask a question…"
          className="w-full h-12 pl-11 pr-4 rounded-xl border bg-card text-base shadow-sm outline-none transition-shadow focus:shadow-md focus:ring-2 focus:ring-ring/30 placeholder:text-muted-foreground"
        />
      </div>

      {open && items.length > 0 && (
        <div className="absolute z-50 mt-2 w-full rounded-xl border bg-popover text-popover-foreground shadow-lg overflow-hidden">
          <ul
            id="search-suggestions"
            /* Owned by the combobox input above; see the note there. */
            // eslint-disable-next-line no-restricted-syntax
            role="listbox"
            aria-label="Search suggestions"
            className="max-h-[32rem] overflow-y-auto py-1"
          >
            {items.map((item, index) => (
              <li key={itemKey(item)}>
                {item.kind !== "ask" && firstOfKind(index) && (
                  <div className="flex items-center justify-between gap-3 px-3 pt-2 pb-1">
                    <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                      {groupLabel[item.kind]}
                    </span>
                    {item.kind === "suggested" && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-xs normal-case tracking-normal text-muted-foreground hover:text-foreground transition-colors"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={generateMoreQuestions}
                      >
                        <RefreshCw className="size-3" />
                        Generate 3 more
                      </button>
                    )}
                  </div>
                )}
                <div
                  id={`search-option-${index}`}
                  role="option"
                  aria-selected={active === index}
                  ref={active === index ? activeRowRef : undefined}
                  className={rowClass(index)}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    go(item);
                  }}
                >
                  {item.kind === "ask" && (
                    <>
                      <Sparkles className="size-4 text-primary shrink-0" />
                      <span className="text-sm">
                        Ask:{" "}
                        <span className="font-medium">“{effectiveQuery()}”</span>
                      </span>
                      <span className="ml-auto text-2xs text-muted-foreground border rounded px-1.5 py-0.5">
                        deep search ↵
                      </span>
                    </>
                  )}
                  {item.kind === "history" && (
                    <>
                      <History className="size-4 text-muted-foreground shrink-0" />
                      <span className="text-sm truncate">{item.query}</span>
                      <span className="ml-auto text-2xs text-muted-foreground shrink-0">
                        saved
                      </span>
                    </>
                  )}
                  {item.kind === "suggested" && (
                    <>
                      <Sparkles className="size-4 text-primary shrink-0" />
                      <span className="text-sm leading-snug">{item.query}</span>
                      <span className="ml-auto text-2xs text-muted-foreground shrink-0">
                        deep search
                      </span>
                    </>
                  )}
                  {item.kind === "entity" && (
                    <>
                      <EntityTypeIcon type={item.type} />
                      <span className="text-sm truncate">
                        <Highlight text={item.name} query={debouncedText} />
                      </span>
                      <span className="ml-auto text-xs text-muted-foreground shrink-0">
                        {item.mentionCount} mention
                        {item.mentionCount !== 1 && "s"}
                      </span>
                    </>
                  )}
                  {item.kind === "document" && (
                    <>
                      <DocTypeIcon
                        mediaType={item.mediaType}
                        mimeType={item.mimeType}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm truncate">
                          <Highlight text={item.name} query={debouncedText} />
                        </span>
                        {item.filename && (
                          <span className="block text-xs text-muted-foreground truncate">
                            <Highlight text={item.filename} query={debouncedText} />
                          </span>
                        )}
                      </span>
                    </>
                  )}
                  {item.kind === "highlight" && (
                    <>
                      <Highlighter className="size-4 text-muted-foreground shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-xs text-muted-foreground truncate">
                          {item.documentName}
                          {item.timeStart === null &&
                            ` · p.${item.pageNumber + 1}`}
                        </span>
                        <span className="block text-sm truncate">
                          “{item.text}”
                        </span>
                        {item.comment && (
                          <span className="block text-xs truncate text-muted-foreground">
                            {item.comment}
                          </span>
                        )}
                      </span>
                    </>
                  )}
                  {item.kind === "page" && (
                    <>
                      <FileText className="size-4 text-muted-foreground shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-xs text-muted-foreground truncate">
                          {item.documentName} · p.{item.pageNumber + 1}
                        </span>
                        <span className="block text-sm truncate">
                          <Highlight text={item.snippet} query={debouncedText} />
                        </span>
                      </span>
                    </>
                  )}
                </div>
              </li>
            ))}
            {!value.trim() && remainingRecentSearches > 0 && (
              <li className="border-t mt-1 px-3 py-2">
                <button
                  type="button"
                  className="inline-flex w-full items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() =>
                    setRecentCount((count) => count + RECENT_COUNT_STEP)
                  }
                >
                  <ChevronDown className="size-3.5" />
                  Show {Math.min(RECENT_COUNT_STEP, remainingRecentSearches)} more
                </button>
              </li>
            )}
            {suggestions === undefined && debounced.trim().length >= 2 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">
                Searching…
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

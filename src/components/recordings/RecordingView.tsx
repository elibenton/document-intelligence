import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useMutation } from "convex/react";
import { ArrowDownToLine, Loader2, RefreshCw, Users } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { languageName } from "@/lib/languages";
import { buildSpeakerColorMap } from "./speakerColors";
import { findActive } from "./transcriptAnchors";
import { TranscriptTurn } from "./TranscriptTurn";
import { TransportBar } from "./TransportBar";
import { SpeakerNamingDialog } from "./SpeakerNamingDialog";
import { transcriptSignature } from "../../../convex/speakerSignature";
import {
  AnnotationComment,
  type SelectionAnchor,
} from "@/components/viewer/AnnotationLayer";
import {
  annotationColor,
  DEFAULT_ANNOTATION_COLOR,
  type AnnotationColor,
} from "@/components/viewer/annotationColors";
import { SelectionActions } from "@/components/viewer/SelectionActions";
import { useHighlightUndo } from "@/components/viewer/useHighlightUndo";
import { useConfirm } from "@/components/ui/use-confirm";

export interface RecordingViewRef {
  seekTo: (seconds: number) => void;
}

interface PendingNote {
  anchor: SelectionAnchor;
  timeRange: { start: number; end: number };
  text: string;
  blockIds: string[];
}

export const RecordingView = forwardRef<
  RecordingViewRef,
  {
    document: Doc<"documents">;
    url: string | null | undefined;
    showTranslation?: boolean;
    /** Armed highlighter color: a selection commits straight to a highlight
     *  of this color, with no comment card afterwards. */
    penColor?: AnnotationColor | null;
    /** TOC section start times, in playback order. With the callback below,
     *  the view reports which section the playhead is in — only when it
     *  changes, so the parent is not re-rendered per timeupdate tick. */
    sectionTimes?: number[];
    onActiveSectionChange?: (index: number) => void;
    /** The Contents panel's committed search term: matching words highlight
     *  in the transcript, mirroring the PDF viewer's search overlay. */
    searchTerm?: string;
  }
>(function RecordingView(
  {
    document: doc,
    url,
    showTranslation = false,
    penColor = null,
    sectionTimes,
    onActiveSectionChange,
    searchTerm,
  },
  ref
) {
  const segments = useQuery(api.transcripts.byDocument, {
    documentId: doc._id,
  });
  const retranscribe = useMutation(api.processing.runFullPipeline);

  const isVideo =
    doc.mediaType === "video" || doc.mimeType.startsWith("video/");

  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [following, setFollowing] = useState(true);
  const [retrying, setRetrying] = useState(false);

  const speakerColor = useMemo(
    () => buildSpeakerColorMap(segments ?? []),
    [segments],
  );

  // Speaker naming: human names render over the diarizer labels (which stay
  // the machine key — colors and joins never re-key); unconfirmed ai
  // suggestions live only in the dialog. The dialog auto-opens once per
  // mount when the transcript's signature differs from the one the user
  // last answered — first visit, or a re-transcription that changed the
  // diarization.
  const speakerRows = useQuery(api.documentSpeakers.byDocument, {
    documentId: doc._id,
  });
  const confirmSpeakers = useMutation(api.documentSpeakers.confirm);
  // Inline rename from a turn's header — one assignment through the same
  // mutation the naming dialog uses, so the library/entity side effects and
  // the answered-signature stay identical.
  const renameSpeaker = useCallback(
    (label: string, name: string) =>
      confirmSpeakers({
        documentId: doc._id,
        assignments: [{ label, name }],
      }),
    [confirmSpeakers, doc._id]
  );
  // The rename popover's option lists, fetched only once an editor has
  // actually been opened — most visits never rename anyone.
  const [nameOptionsArmed, setNameOptionsArmed] = useState(false);
  const armNameOptions = useCallback(() => setNameOptionsArmed(true), []);
  const speakerLibrary = useQuery(
    api.speakers.list,
    nameOptionsArmed ? {} : "skip"
  );
  const speakerSuggestions = useQuery(
    api.documentSpeakers.suggestions,
    nameOptionsArmed ? { documentId: doc._id } : "skip"
  );
  const nameByLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of speakerRows ?? []) {
      if (row.source === "human") map.set(row.label, row.name);
    }
    return map;
  }, [speakerRows]);

  // Options offered when renaming a speaker: the AI's suggestion for that
  // voice first, then names already assigned in this recording, then the
  // user's speaker library — deduped, first spelling wins.
  const getNameOptions = useCallback(
    (label: string) => {
      const seen = new Set<string>();
      const items: { value: string; label: string; hint?: string }[] = [];
      const add = (raw: string, hint?: string) => {
        const value = raw.trim();
        const key = value.toLowerCase();
        if (!value || seen.has(key)) return;
        seen.add(key);
        items.push({ value, label: value, hint });
      };
      for (const s of speakerSuggestions ?? []) {
        if (s.label === label) add(s.name, "suggested");
      }
      for (const [otherLabel, name] of nameByLabel) {
        if (otherLabel !== label) add(name, "in this recording");
      }
      for (const s of speakerLibrary ?? []) {
        add(s.name, `used ${s.useCount}×`);
      }
      return items;
    },
    [speakerSuggestions, nameByLabel, speakerLibrary]
  );

  const rename = useMemo(
    () => ({
      commit: renameSpeaker,
      getOptions: getNameOptions,
      arm: armNameOptions,
    }),
    [renameSpeaker, getNameOptions, armNameOptions]
  );

  // Two diarizer labels given the same human name are the same person:
  // they combine — one color (the first-appearing label's), and consecutive
  // turns merge under a single header (see the render below). Unnamed labels
  // keep their own machine-keyed color, so naming never shuffles the rest.
  const colorByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const seg of segments ?? []) {
      const name = nameByLabel.get(seg.speaker) ?? seg.speaker;
      const color = speakerColor.get(seg.speaker);
      if (color && !map.has(name)) map.set(name, color);
    }
    return map;
  }, [segments, nameByLabel, speakerColor]);
  const [namingOpen, setNamingOpen] = useState(false);
  const currentSignature =
    segments && segments.length > 0 ? transcriptSignature(segments) : null;
  const needsNaming =
    currentSignature !== null &&
    doc.speakerNamingSignature !== currentSignature &&
    speakerColor.size >= 2;
  // Compare-during-render, not an effect: open once per signature change.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (needsNaming && openedFor !== currentSignature) {
    setOpenedFor(currentSignature);
    setNamingOpen(true);
  }

  const active = useMemo(
    () => (segments ? findActive(segments, currentTime) : { segment: -1, word: -1 }),
    [segments, currentTime],
  );

  // Which word indices of each segment the committed search term covers.
  // Matching runs on the words joined by single spaces, so multi-word terms
  // match across word boundaries; per-segment sets keep TranscriptTurn's
  // memo effective (turns without matches receive undefined).
  const searchWordsBySegment = useMemo(() => {
    const term = searchTerm?.trim().toLowerCase();
    if (!term || term.length < 2 || !segments) return null;
    const map = new Map<number, Set<number>>();
    segments.forEach((seg, si) => {
      let joined = "";
      const wordStart: number[] = [];
      for (const w of seg.words) {
        if (joined) joined += " ";
        wordStart.push(joined.length);
        joined += w.word.toLowerCase();
      }
      const matched = new Set<number>();
      let from = 0;
      for (;;) {
        const at = joined.indexOf(term, from);
        if (at === -1) break;
        const end = at + term.length;
        from = end;
        seg.words.forEach((w, wi) => {
          const s = wordStart[wi];
          if (s < end && s + w.word.length > at) matched.add(wi);
        });
      }
      if (matched.size > 0) map.set(si, matched);
    });
    return map;
  }, [searchTerm, segments]);

  // Keep the active word in view during playback — unless the user has
  // scrolled away, in which case following pauses until they ask for it back
  // or make an explicit seek (which declares a new focus point).
  useEffect(() => {
    if (following && playing && activeWordRef.current) {
      activeWordRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [active.segment, active.word, following, playing]);

  // The user's hand, not ours: wheel and touch are events only a person
  // fires, so there is no guessing whether a scroll event came from our own
  // scrollIntoView — scrolling away always works mid-playback, and the
  // "Resume following" button is the way back to the playhead.
  const onUserScroll = useCallback(() => setFollowing(false), []);

  // Which TOC section the playhead is inside — reported upward only on
  // change (a few times per recording, not per tick).
  const lastSection = useRef(-1);
  useEffect(() => {
    if (!sectionTimes || !onActiveSectionChange) return;
    let index = -1;
    for (let i = sectionTimes.length - 1; i >= 0; i--) {
      if (sectionTimes[i] <= currentTime) {
        index = i;
        break;
      }
    }
    if (index !== lastSection.current) {
      lastSection.current = index;
      onActiveSectionChange(index);
    }
  }, [currentTime, sectionTimes, onActiveSectionChange]);

  const seekTo = useCallback((time: number) => {
    const media = mediaRef.current;
    if (!media) return;
    clipEndRef.current = null;
    media.currentTime = time;
    setCurrentTime(time);
    setFollowing(true);
    if (media.paused) void media.play();
  }, []);

  // A bounded clip: seek, play, and stop at the end — the naming dialog's
  // "confirm the voice" button. The end time rides a ref checked on each
  // timeupdate tick; any manual seek or play clears it so the clip never
  // pauses playback the user started themselves.
  const clipEndRef = useRef<number | null>(null);
  const playClip = useCallback((start: number, end: number) => {
    const media = mediaRef.current;
    if (!media) return;
    clipEndRef.current = end;
    media.currentTime = start;
    setCurrentTime(start);
    void media.play();
  }, []);

  const togglePlay = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) void media.play();
    else media.pause();
  }, []);

  const changeSpeed = useCallback((next: number) => {
    setSpeed(next);
    if (mediaRef.current) mediaRef.current.playbackRate = next;
  }, []);

  // Space / arrows drive playback anywhere in the document view, except while
  // typing or inside an open dialog — the classic space-scrolls-the-page and
  // space-in-a-comment-box bugs are the guards here.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.closest("[role=dialog]"))
      ) {
        return;
      }
      const media = mediaRef.current;
      if (!media) return;
      if (e.key === " ") {
        e.preventDefault();
        if (media.paused) void media.play();
        else media.pause();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        media.currentTime = Math.max(0, media.currentTime - 5);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        media.currentTime = Math.min(media.duration || Infinity, media.currentTime + 5);
      }
    }
    window.document.addEventListener("keydown", onKeyDown);
    return () => window.document.removeEventListener("keydown", onKeyDown);
  }, []);

  const mediaEvents = {
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const media = e.currentTarget;
      if (clipEndRef.current !== null && media.currentTime >= clipEndRef.current) {
        clipEndRef.current = null;
        media.pause();
      }
      setCurrentTime(media.currentTime);
    },
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) =>
      setDuration(e.currentTarget.duration),
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
  };

  // Notes: highlights anchor by time, so they survive re-transcription (the
  // segments are disposable, the seconds are not). Selection resolves through
  // the data-seg/data-word attributes the word spans already carry.
  const annotations = useQuery(api.annotations.byDocument, {
    documentId: doc._id,
  });
  const createAnnotation = useMutation(api.annotations.create);
  const updateAnnotation = useMutation(api.annotations.update);
  const removeAnnotation = useMutation(api.annotations.remove);
  const mergeAnnotations = useMutation(api.annotations.merge);
  // The comment card open on a just-highlighted selection ("Add note" in the
  // offer popover). Transcript runs render inside each turn with no anchor
  // node, so the card hangs from the selection's own viewport rect instead.
  const [notePopup, setNotePopup] = useState<{
    id: string;
    anchor: SelectionAnchor;
  } | null>(null);

  // ⌘Z deletes the last highlight this visit created; the catch swallows the
  // not-found error for one already deleted through its comment card.
  const undoRemove = useCallback(
    (id: string) => {
      removeAnnotation({ id: id as Doc<"annotations">["_id"] }).catch(() => {});
    },
    [removeAnnotation]
  );
  const recordCreated = useHighlightUndo(undoRemove);

  const highlightsBySegment = useMemo(() => {
    const map = new Map<number, { start: number; end: number; fill: string }[]>();
    if (!segments || !annotations) return map;
    for (const note of annotations) {
      if (!note.timeRange) continue;
      const fill = annotationColor(note.color).fill;
      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si];
        if (note.timeRange.start < seg.endTime && note.timeRange.end > seg.startTime) {
          const bucket = map.get(si);
          const entry = { ...note.timeRange, fill };
          if (bucket) bucket.push(entry);
          else map.set(si, [entry]);
        }
      }
    }
    return map;
  }, [segments, annotations]);

  const commitNote = useCallback(
    async (note: PendingNote, color: AnnotationColor) => {
      return await createAnnotation({
        documentId: doc._id,
        // The transcript IS page 0 in the mirror — truthful, not a fudge.
        pageNumber: 0,
        color,
        text: note.text,
        rects: [],
        blockIds: note.blockIds,
        timeRange: note.timeRange,
      });
    },
    [createAnnotation, doc._id],
  );

  /** A drag's selection, awaiting the offer popover's verdict. */
  const [pendingNote, setPendingNote] = useState<PendingNote | null>(null);

  // Committing folds into any highlight whose time range the selection
  // overlaps; the union re-reads the words inside the merged span, so the
  // stored text matches the widened anchor exactly.
  const commitPending = useCallback(
    async (note: PendingNote, color: AnnotationColor) => {
      const overlapped = (annotations ?? []).filter(
        (a) =>
          a.timeRange &&
          a.timeRange.start < note.timeRange.end &&
          a.timeRange.end > note.timeRange.start
      );
      if (overlapped.length === 0) {
        const id = await commitNote(note, color);
        // Only fresh highlights join the ⌘Z stack: undoing a merge would
        // delete the survivor outright, losing the pre-merge highlight too.
        recordCreated(id);
        return id;
      }
      const merged = {
        start: Math.min(
          note.timeRange.start,
          ...overlapped.map((a) => a.timeRange!.start)
        ),
        end: Math.max(
          note.timeRange.end,
          ...overlapped.map((a) => a.timeRange!.end)
        ),
      };
      const parts: string[] = [];
      const segIds: string[] = [];
      (segments ?? []).forEach((seg, si) => {
        const words = seg.words.filter(
          (w) => w.end > merged.start && w.start < merged.end
        );
        if (words.length > 0) {
          parts.push(words.map((w) => w.word).join(" "));
          segIds.push(`transcript_seg${si}`);
        }
      });
      return await mergeAnnotations({
        id: overlapped[0]._id,
        absorb: overlapped.slice(1).map((a) => a._id),
        text: parts.join(" "),
        rects: [],
        blockIds: segIds,
        timeRange: merged,
      });
    },
    [annotations, commitNote, mergeAnnotations, recordCreated, segments]
  );

  const settlePending = useCallback(() => {
    setPendingNote(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const highlightPending = useCallback(
    (openNote: boolean) => {
      if (!pendingNote) return;
      const note = pendingNote;
      settlePending();
      void (async () => {
        const id = await commitPending(note, DEFAULT_ANNOTATION_COLOR);
        if (openNote) setNotePopup({ id, anchor: note.anchor });
      })();
    },
    [commitPending, pendingNote, settlePending]
  );

  const copyPendingLink = useCallback(() => {
    if (!pendingNote) return;
    // No time-coded deep link yet — the document URL is the closest anchor a
    // transcript quote has.
    const url = new URL(window.location.pathname, window.location.origin);
    void navigator.clipboard.writeText(`“${pendingNote.text}”\n${url.href}`);
    settlePending();
  }, [pendingNote, settlePending]);

  const onTranscriptPointerUp = useCallback(() => {
    if (!segments) return;
    const selection = window.getSelection();
    // A click is a zero-length selection; without this every seek would pop
    // the note card.
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setNotePopup(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const wordEl = (node: Node) =>
      (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
        "[data-word]",
      ) ?? null;
    const startEl = wordEl(range.startContainer);
    const endEl = wordEl(range.endContainer);
    if (!startEl || !endEl) return;
    const pos = (el: HTMLElement) => ({
      seg: Number(el.closest<HTMLElement>("[data-seg]")?.dataset.seg ?? -1),
      word: Number(el.dataset.word ?? -1),
    });
    let a = pos(startEl);
    let b = pos(endEl);
    if (a.seg < 0 || b.seg < 0 || a.word < 0 || b.word < 0) return;
    if (a.seg > b.seg || (a.seg === b.seg && a.word > b.word)) [a, b] = [b, a];
    const startWord = segments[a.seg]?.words[a.word];
    const endWord = segments[b.seg]?.words[b.word];
    if (!startWord || !endWord) return;
    // The stored text is the covered words joined — it matches the anchor
    // exactly, unlike selection.toString() with its DOM whitespace.
    const parts: string[] = [];
    for (let si = a.seg; si <= b.seg; si++) {
      const words = segments[si].words;
      const from = si === a.seg ? a.word : 0;
      const to = si === b.seg ? b.word : words.length - 1;
      parts.push(words.slice(from, to + 1).map((w) => w.word).join(" "));
    }
    const rect = range.getBoundingClientRect();
    const note: PendingNote = {
      anchor: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      },
      timeRange: { start: startWord.start, end: endWord.end },
      text: parts.join(" "),
      blockIds: Array.from(
        { length: b.seg - a.seg + 1 },
        (_, i) => `transcript_seg${a.seg + i}`,
      ),
    };
    // Armed, the pen commits on lift — that is the whole gesture. Otherwise
    // the selection is just a selection: the offer popover decides whether it
    // becomes a highlight, a note, or a copied quote.
    if (penColor) {
      selection.removeAllRanges();
      void commitPending(note, penColor);
      return;
    }
    setNotePopup(null);
    setPendingNote(note);
  }, [segments, penColor, commitPending]);

  useImperativeHandle(ref, () => ({ seekTo }), [seekTo]);

  const isProcessing = doc.status === "uploaded" || doc.status === "parsing";
  const failed = doc.status === "failed";
  const confirm = useConfirm();

  async function startTranscription() {
    // Destructive for the transcript's derived state: names re-confirm by
    // signature, highlights re-anchor by time (possibly ±1 word), but any
    // future text corrections die with the segments. Say so before running.
    if (segments && segments.length > 0) {
      const ok = await confirm({
        title: "Re-transcribe this recording?",
        body: "The transcript is replaced. Highlights re-anchor by time, and you'll be asked to re-confirm speaker names if the diarization changed.",
        confirmLabel: "Re-transcribe",
      });
      if (!ok) return;
    }
    setRetrying(true);
    try {
      await retranscribe({ documentId: doc._id });
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* The picture stays at the top for video; the controls live in the
          transport strip at the bottom either way. */}
      {isVideo && url && (
        <div className="border-b p-4 shrink-0">
          <video
            ref={(el) => {
              mediaRef.current = el;
            }}
            src={url}
            controls
            className="w-full max-h-72 rounded-lg bg-black"
            {...mediaEvents}
          />
        </div>
      )}

      {/* Transcript */}
      <div
        ref={scrollRef}
        onWheel={onUserScroll}
        onTouchMove={onUserScroll}
        onPointerUp={onTranscriptPointerUp}
        className="relative flex-1 overflow-y-auto p-6"
      >
        {/* One centered measure: the heading, controls and turns share the
            same column so nothing sits at a different left edge. */}
        <div className="mx-auto w-full max-w-3xl flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {showTranslation && doc.translationLanguageCode
              ? `${languageName(doc.translationLanguageCode)} transcript`
              : "Original transcript"}
          </h2>
          {segments && segments.length > 0 && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setNamingOpen(true)}
              >
                <Users className="size-3.5 mr-1" />
                Name speakers
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={retrying}
                onClick={() => void startTranscription()}
              >
                <RefreshCw
                  className={cn("size-3.5 mr-1", retrying && "animate-spin")}
                />
                Re-transcribe
              </Button>
            </div>
          )}
        </div>

        {segments === undefined ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : segments.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            {isProcessing ? (
              <>
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Transcribing with speaker diarization…
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {failed
                    ? doc.errorMessage ?? "Transcription failed."
                    : "No transcript yet."}
                </p>
                <Button
                  size="sm"
                  disabled={retrying}
                  onClick={() => void startTranscription()}
                >
                  {retrying ? "Starting…" : "Transcribe"}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl flex flex-col">
            {segments.map((seg, si) => {
              const name = nameByLabel.get(seg.speaker) ?? seg.speaker;
              const prev = segments[si - 1];
              const prevName = prev
                ? nameByLabel.get(prev.speaker) ?? prev.speaker
                : null;
              return (
              <TranscriptTurn
                key={seg._id}
                segment={seg}
                index={si}
                speakerName={name}
                colorClass={colorByName.get(name)}
                showHeader={name !== prevName}
                searchWords={searchWordsBySegment?.get(si)}
                rename={rename}
                isActive={active.segment === si}
                activeWordIndex={active.segment === si ? active.word : -1}
                showTranslation={showTranslation}
                highlights={highlightsBySegment.get(si)}
                onSeek={seekTo}
                activeWordRef={(el) => {
                  if (el) activeWordRef.current = el;
                }}
              />
              );
            })}
          </div>
        )}

        {!following && playing && (
          <div className="sticky bottom-4 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setFollowing(true);
                activeWordRef.current?.scrollIntoView({
                  block: "center",
                  behavior: "smooth",
                });
              }}
            >
              <ArrowDownToLine className="size-3.5 mr-1" />
              Resume following
            </Button>
          </div>
        )}
      </div>

      {/* Transport — pinned under the transcript like a status bar. */}
      <div className="border-t px-4 py-3 shrink-0">
        {url === undefined ? (
          <Skeleton className="h-8 w-full" />
        ) : url === null ? (
          <p className="text-sm text-muted-foreground">Media file not found.</p>
        ) : (
          <>
            {!isVideo && (
              <audio
                ref={(el) => {
                  mediaRef.current = el;
                }}
                src={url}
                {...mediaEvents}
              />
            )}
            <TransportBar
              playing={playing}
              currentTime={currentTime}
              duration={duration}
              speed={speed}
              onTogglePlay={togglePlay}
              onSeek={seekTo}
              onSpeedChange={changeSpeed}
              seekOnly={isVideo}
            />
          </>
        )}
      </div>

      {segments && segments.length > 0 && (
        <SpeakerNamingDialog
          document={doc}
          segments={segments}
          speakerColor={speakerColor}
          speakerRows={speakerRows}
          open={namingOpen}
          onOpenChange={setNamingOpen}
          onPlayClip={playClip}
        />
      )}

      {pendingNote && (
        <SelectionActions
          anchor={pendingNote.anchor}
          onHighlight={() => highlightPending(false)}
          onNote={() => highlightPending(true)}
          onCopyLink={copyPendingLink}
          onDismiss={() => setPendingNote(null)}
        />
      )}
      {notePopup &&
        (() => {
          const annotation = annotations?.find((a) => a._id === notePopup.id);
          if (!annotation) return null;
          const id = annotation._id;
          const dismiss = () => setNotePopup(null);
          return (
            <AnnotationComment
              // Remount per highlight: the comment draft is seeded from the row.
              key={id}
              annotation={annotation}
              anchorRect={notePopup.anchor}
              onChangeComment={(comment) => {
                void updateAnnotation({ id, comment });
                dismiss();
              }}
              onChangeColor={(color) => void updateAnnotation({ id, color })}
              onDelete={() => {
                void removeAnnotation({ id });
                dismiss();
              }}
              onDismiss={dismiss}
            />
          );
        })()}
    </div>
  );
});

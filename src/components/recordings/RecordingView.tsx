import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export function RecordingView({
  document: doc,
  url,
  showTranslation = false,
}: {
  document: Doc<"documents">;
  url: string | null | undefined;
  showTranslation?: boolean;
}) {
  const segments = useQuery(api.transcripts.byDocument, {
    documentId: doc._id,
  });
  const retranscribe = useMutation(api.processing.runFullPipeline);

  const isVideo =
    doc.mediaType === "video" || doc.mimeType.startsWith("video/");

  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  // Brackets our own scrollIntoView so the scroll listener can tell the
  // user's hand from ours. A counter, not a boolean: smooth scrolling fires
  // several scroll events after the call returns.
  const programmaticScrollUntil = useRef(0);
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
  const nameByLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of speakerRows ?? []) {
      if (row.source === "human") map.set(row.label, row.name);
    }
    return map;
  }, [speakerRows]);
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

  // Keep the active word in view during playback — unless the user has
  // scrolled away, in which case following pauses until they ask for it back
  // or make an explicit seek (which declares a new focus point).
  useEffect(() => {
    if (following && playing && activeWordRef.current) {
      programmaticScrollUntil.current = Date.now() + 600;
      activeWordRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [active.segment, active.word, following, playing]);

  const onUserScroll = useCallback(() => {
    if (Date.now() > programmaticScrollUntil.current) setFollowing(false);
  }, []);

  const seekTo = useCallback((time: number) => {
    const media = mediaRef.current;
    if (!media) return;
    media.currentTime = time;
    setCurrentTime(time);
    setFollowing(true);
    if (media.paused) void media.play();
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
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) =>
      setCurrentTime(e.currentTarget.currentTime),
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) =>
      setDuration(e.currentTarget.duration),
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
  };

  const isProcessing = doc.status === "uploaded" || doc.status === "parsing";
  const failed = doc.status === "failed";

  async function startTranscription() {
    setRetrying(true);
    try {
      await retranscribe({ documentId: doc._id });
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Player */}
      <div className="border-b p-4 shrink-0 bg-card flex flex-col gap-2">
        {url === undefined ? (
          <Skeleton className="h-12 w-full" />
        ) : url === null ? (
          <p className="text-sm text-muted-foreground">Media file not found.</p>
        ) : (
          <>
            {isVideo ? (
              <video
                ref={(el) => {
                  mediaRef.current = el;
                }}
                src={url}
                controls
                className="w-full max-h-72 rounded-lg bg-black"
                {...mediaEvents}
              />
            ) : (
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

      {/* Transcript */}
      <div
        ref={scrollRef}
        onScroll={onUserScroll}
        className="relative flex-1 overflow-y-auto p-6"
      >
        <div className="flex items-center justify-between mb-4">
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
          <div className="flex flex-col gap-5 max-w-3xl">
            {segments.map((seg, si) => (
              <TranscriptTurn
                key={seg._id}
                segment={seg}
                index={si}
                speakerName={nameByLabel.get(seg.speaker) ?? seg.speaker}
                colorClass={speakerColor.get(seg.speaker)}
                isActive={active.segment === si}
                activeWordIndex={active.segment === si ? active.word : -1}
                showTranslation={showTranslation}
                onSeek={seekTo}
                activeWordRef={(el) => {
                  if (el) activeWordRef.current = el;
                }}
              />
            ))}
          </div>
        )}

        {!following && playing && (
          <div className="sticky bottom-4 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setFollowing(true);
                programmaticScrollUntil.current = Date.now() + 600;
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

      {segments && segments.length > 0 && (
        <SpeakerNamingDialog
          document={doc}
          segments={segments}
          speakerColor={speakerColor}
          speakerRows={speakerRows}
          open={namingOpen}
          onOpenChange={setNamingOpen}
        />
      )}
    </div>
  );
}

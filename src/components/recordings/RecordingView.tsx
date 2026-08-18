import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { languageDirection, languageName } from "@/lib/languages";

// Deterministic per-speaker accent colors
const SPEAKER_COLORS = [
  "text-blue-600 dark:text-blue-400",
  "text-emerald-600 dark:text-emerald-400",
  "text-purple-600 dark:text-purple-400",
  "text-rose-600 dark:text-rose-400",
  "text-amber-600 dark:text-amber-400",
  "text-cyan-600 dark:text-cyan-400",
];

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = h > 0 ? String(m % 60).padStart(2, "0") : String(m);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

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
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [retrying, setRetrying] = useState(false);

  const speakerColor = useMemo(() => {
    const map = new Map<string, string>();
    for (const seg of segments ?? []) {
      if (!map.has(seg.speaker)) {
        map.set(seg.speaker, SPEAKER_COLORS[map.size % SPEAKER_COLORS.length]);
      }
    }
    return map;
  }, [segments]);

  // Active segment/word for the current playback position
  const active = useMemo(() => {
    if (!segments) return { segment: -1, word: -1 };
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      const nextStart = segments[si + 1]?.startTime ?? Infinity;
      if (currentTime >= seg.startTime && currentTime < Math.max(seg.endTime, nextStart)) {
        let wi = -1;
        for (let w = 0; w < seg.words.length; w++) {
          if (currentTime >= seg.words[w].start) wi = w;
          else break;
        }
        return { segment: si, word: wi };
      }
    }
    return { segment: -1, word: -1 };
  }, [segments, currentTime]);

  // Keep the active word in view during playback
  useEffect(() => {
    if (autoScroll && activeWordRef.current) {
      activeWordRef.current.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    }
  }, [active.segment, active.word, autoScroll]);

  function seekTo(time: number) {
    const media = mediaRef.current;
    if (!media) return;
    media.currentTime = time;
    setCurrentTime(time);
    if (media.paused) void media.play();
  }

  const isProcessing = doc.status === "uploaded" || doc.status === "parsing";
  const failed = doc.status === "failed";

  return (
    <div className="flex flex-col h-full">
      {/* Player */}
      <div className="border-b p-4 shrink-0 bg-card">
        {url === undefined ? (
          <Skeleton className="h-12 w-full" />
        ) : url === null ? (
          <p className="text-sm text-muted-foreground">Media file not found.</p>
        ) : isVideo ? (
          <video
            ref={(el) => {
              mediaRef.current = el;
            }}
            src={url}
            controls
            className="w-full max-h-72 rounded-lg bg-black"
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          />
        ) : (
          <audio
            ref={(el) => {
              mediaRef.current = el;
            }}
            src={url}
            controls
            className="w-full"
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          />
        )}
      </div>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {showTranslation && doc.translationLanguageCode
              ? `${languageName(doc.translationLanguageCode)} transcript`
              : "Original transcript"}
          </h2>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              Follow playback
            </label>
            {segments && segments.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                disabled={retrying}
                onClick={async () => {
                  setRetrying(true);
                  try {
                    await retranscribe({ documentId: doc._id });
                  } finally {
                    setRetrying(false);
                  }
                }}
              >
                <RefreshCw
                  className={cn("size-3.5 mr-1", retrying && "animate-spin")}
                />
                Re-transcribe
              </Button>
            )}
          </div>
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
                  onClick={async () => {
                    setRetrying(true);
                    try {
                      await retranscribe({ documentId: doc._id });
                    } finally {
                      setRetrying(false);
                    }
                  }}
                >
                  {retrying ? "Starting…" : "Transcribe"}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-5 max-w-3xl">
            {segments.map((seg, si) => (
              <div key={seg._id}>
                <div className="flex items-baseline gap-2 mb-1">
                  <span
                    className={cn(
                      "text-sm font-semibold",
                      speakerColor.get(seg.speaker)
                    )}
                  >
                    {seg.speaker}
                  </span>
                  <button
                    onClick={() => seekTo(seg.startTime)}
                    className="text-xs text-muted-foreground tabular-nums hover:text-foreground hover:underline"
                    title="Jump to this segment"
                  >
                    {formatTime(seg.startTime)}
                  </button>
                </div>
                <p
                  dir={
                    showTranslation
                      ? languageDirection(seg.translatedLanguageCode)
                      : "ltr"
                  }
                  className={cn(
                    "text-sm leading-7",
                    active.segment === si && "bg-accent/40 rounded px-1 -mx-1"
                  )}
                >
                  {showTranslation && seg.translatedText
                    ? seg.translatedText
                    : seg.words.length > 0
                    ? seg.words.map((w, wi) => {
                        const isActive =
                          active.segment === si && active.word === wi;
                        return (
                          <span
                            key={wi}
                            ref={isActive ? activeWordRef : undefined}
                            onClick={() => seekTo(w.start)}
                            className={cn(
                              "cursor-pointer rounded px-0.5 hover:bg-primary/15",
                              isActive && "bg-primary/25"
                            )}
                            title={formatTime(w.start)}
                          >
                            {w.word}{" "}
                          </span>
                        );
                      })
                    : seg.text}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

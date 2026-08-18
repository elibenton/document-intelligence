import { Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatTime } from "./speakerColors";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

/**
 * The audio transport. Replaces the native <audio controls> chrome so
 * play/pause, ±10s, speed, and seeking are keyboard-reachable and styled;
 * video keeps its native controls (fullscreen, PiP) and only borrows the
 * speed/skip buttons.
 */
export function TransportBar({
  playing,
  currentTime,
  duration,
  speed,
  onTogglePlay,
  onSeek,
  onSpeedChange,
  seekOnly = false,
}: {
  playing: boolean;
  currentTime: number;
  duration: number;
  speed: number;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onSpeedChange: (speed: number) => void;
  /** Video mode: the native element owns play/pause; we add skip + speed. */
  seekOnly?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {!seekOnly && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onTogglePlay}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onSeek(Math.max(0, currentTime - 10))}
        aria-label="Back 10 seconds"
        title="Back 10 seconds (←)"
      >
        <RotateCcw className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onSeek(Math.min(duration || Infinity, currentTime + 10))}
        aria-label="Forward 10 seconds"
        title="Forward 10 seconds (→)"
      >
        <RotateCw className="size-4" />
      </Button>
      {!seekOnly && (
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          onChange={(e) => onSeek(Number(e.target.value))}
          aria-label="Seek"
          className="min-w-0 flex-1 accent-primary"
        />
      )}
      <span
        className={cn(
          "shrink-0 text-xs tabular-nums text-muted-foreground",
          seekOnly && "ml-auto",
        )}
      >
        {formatTime(currentTime)}
        {duration > 0 && ` / ${formatTime(duration)}`}
      </span>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label="Playback speed"
              className="tabular-nums"
            >
              {speed}×
            </Button>
          }
        />
        <PopoverContent className="flex w-24 flex-col p-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => onSpeedChange(s)}
              className={cn(
                "rounded px-2 py-1 text-left text-sm tabular-nums hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                s === speed && "font-semibold text-primary",
              )}
            >
              {s}×
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

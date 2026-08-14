import {
  PROVIDER_FILE_OBJECT_SAFE_BYTES,
  PROVIDER_URL_SAFE_BYTES,
} from "../../convex/interfazeLimits";
import { formatBytes } from "./formatBytes";

const AUDIO_EXTENSIONS = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "oga",
  "ogg",
  "wav",
  "webm",
]);

/** Both ceilings are the provider's, shared with the pipeline that enforces them. */
export const AUDIO_LARGE_TRANSFER_BYTES = PROVIDER_FILE_OBJECT_SAFE_BYTES;
export const AUDIO_URL_SAFE_BYTES = PROVIDER_URL_SAFE_BYTES;

export type AudioContainer =
  | "aac"
  | "flac"
  | "m4a"
  | "mp3"
  | "ogg"
  | "wav"
  | "webm"
  | "unknown";

export type AudioSizeClass = "standard" | "large_url" | "normalization_required";

export function classifyAudioSize(bytes: number): AudioSizeClass {
  if (bytes > AUDIO_URL_SAFE_BYTES) return "normalization_required";
  if (bytes > AUDIO_LARGE_TRANSFER_BYTES) return "large_url";
  return "standard";
}

export function shouldOptimizeAudio(
  container: AudioContainer,
  bytes: number
): boolean {
  const sizeClass = classifyAudioSize(bytes);
  return (
    sizeClass === "normalization_required" ||
    (container === "wav" && sizeClass === "large_url")
  );
}

export type AudioPreflightResult =
  | {
      ok: true;
      action: "upload" | "convert";
      container: AudioContainer;
      durationSeconds: number | null;
      providerInput: "url";
      message: string;
    }
  | {
      ok: false;
      code: "empty" | "invalid_audio";
      container: AudioContainer;
      durationSeconds: number | null;
      message: string;
    };

function extensionOf(name: string): string {
  return name.toLowerCase().split(".").pop() ?? "";
}

export function isAudioUpload(file: File): boolean {
  const mime = file.type.toLowerCase();
  if (mime.startsWith("audio/")) return true;
  // WebM can contain either audio or video. A real video MIME wins over the
  // ambiguous extension so video uploads do not enter the audio preflight.
  if (mime.startsWith("video/")) return false;
  return AUDIO_EXTENSIONS.has(extensionOf(file.name));
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

/** Detect the common containers we advertise from their file signatures. */
export function detectAudioContainer(bytes: Uint8Array): AudioContainer {
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") {
    return "wav";
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "fLaC") return "flac";
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "webm";
  }
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === "ID3") return "mp3";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    return "aac";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return "mp3";
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") return "m4a";
  return "unknown";
}

function containerFromExtension(file: File): AudioContainer {
  const ext = extensionOf(file.name);
  if (ext === "oga") return "ogg";
  return AUDIO_EXTENSIONS.has(ext) ? (ext as AudioContainer) : "unknown";
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  return hours > 0
    ? `${hours}h ${minutes}m`
    : `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const element = document.createElement("audio");
    const objectUrl = URL.createObjectURL(file);
    let settled = false;

    const finish = (duration: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(objectUrl);
      resolve(duration);
    };

    const timeoutId = window.setTimeout(() => finish(null), 8_000);
    element.preload = "metadata";
    element.onloadedmetadata = () => {
      finish(
        Number.isFinite(element.duration) && element.duration > 0
          ? element.duration
          : null
      );
    };
    element.onerror = () => finish(null);
    element.src = objectUrl;
  });
}

export async function preflightAudio(file: File): Promise<AudioPreflightResult> {
  if (file.size === 0) {
    return {
      ok: false,
      code: "empty",
      container: "unknown",
      durationSeconds: null,
      message: "This audio file is empty.",
    };
  }

  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const signatureContainer = detectAudioContainer(header);
  const extensionContainer = containerFromExtension(file);
  const durationSeconds = await readDuration(file);
  const container =
    signatureContainer !== "unknown" ? signatureContainer : extensionContainer;

  if (
    signatureContainer !== "unknown" &&
    extensionContainer !== "unknown" &&
    signatureContainer !== extensionContainer
  ) {
    return {
      ok: false,
      code: "invalid_audio",
      container: signatureContainer,
      durationSeconds,
      message: `The filename says ${extensionContainer.toUpperCase()}, but the file contents are ${signatureContainer.toUpperCase()}. Rename or convert the original file and try again.`,
    };
  }

  if (container === "unknown" && durationSeconds === null) {
    return {
      ok: false,
      code: "invalid_audio",
      container,
      durationSeconds,
      message:
        "This file could not be identified as supported audio. Try MP3, M4A, WAV, AAC, OGG, FLAC, or WebM audio.",
    };
  }

  const sizeClass = classifyAudioSize(file.size);
  const shouldConvert = shouldOptimizeAudio(container, file.size);
  if (shouldConvert) {
    const duration = formatDuration(durationSeconds);
    return {
      ok: true,
      action: "convert",
      container,
      durationSeconds,
      providerInput: "url",
      message: `${duration ? `${duration} · ` : ""}${formatBytes(file.size)} ${container.toUpperCase()} · will optimize before upload`,
    };
  }

  const duration = formatDuration(durationSeconds);
  return {
    ok: true,
    action: "upload",
    container,
    durationSeconds,
    providerInput: "url",
    message: `${duration ? `${duration} · ` : ""}${formatBytes(file.size)} · ${
      sizeClass === "large_url" ? "large-audio transfer" : "ready"
    }`,
  };
}

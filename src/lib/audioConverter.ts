import { AUDIO_URL_SAFE_BYTES } from "@/lib/audioPreflight";

const OUTPUT_BITRATE = 32_000;
const OUTPUT_SAMPLE_RATE = 48_000;
const SOURCE_CACHE_BYTES = 16 * 1024 * 1024;

export interface AudioConversionOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

function optimizedName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "") || "audio";
  return `${base}.optimized.webm`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Audio optimization was canceled.", "AbortError");
  }
}

/**
 * Convert speech audio in the browser before it reaches Convex storage.
 *
 * Mediabunny is intentionally loaded only for files selected by preflight, so
 * normal uploads do not pay for the media conversion bundle. The source is
 * read incrementally and the in-memory target contains only the compact Opus
 * result, rather than a decoded copy of the entire recording.
 */
export async function optimizeAudioForUpload(
  file: File,
  options: AudioConversionOptions = {}
): Promise<File> {
  throwIfAborted(options.signal);

  const {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Output,
    Quality,
    WebMOutputFormat,
    canEncodeAudio,
  } = await import("mediabunny");

  throwIfAborted(options.signal);
  const quality = new Quality({ bitrate: OUTPUT_BITRATE });
  const canEncodeOpus = await canEncodeAudio("opus", {
    numberOfChannels: 1,
    sampleRate: OUTPUT_SAMPLE_RATE,
    quality,
  });
  if (!canEncodeOpus) {
    throw new Error(
      "This browser cannot optimize audio to Opus. Try the latest Chrome, Edge, or Safari, or convert the file to MP3 first."
    );
  }

  const input = new Input({
    source: new BlobSource(file, { maxCacheSize: SOURCE_CACHE_BYTES }),
    formats: ALL_FORMATS,
  });
  let conversion: Awaited<ReturnType<(typeof Conversion)["init"]>> | undefined;
  const cancelConversion = () => {
    void conversion?.cancel();
  };
  options.signal?.addEventListener("abort", cancelConversion, { once: true });

  try {
    if (!(await input.canRead())) {
      throw new Error(
        "This audio container cannot be decoded in this browser. Convert it to WAV, MP3, M4A, FLAC, OGG, or WebM and try again."
      );
    }

    const target = new BufferTarget();
    const output = new Output({
      format: new WebMOutputFormat(),
      target,
    });
    conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: { discard: true },
      audio: {
        codec: "opus",
        forceTranscode: true,
        numberOfChannels: 1,
        sampleRate: OUTPUT_SAMPLE_RATE,
        quality,
      },
      showWarnings: false,
    });

    if (!conversion.isValid) {
      throw new Error(
        "No usable audio track was found in this file, so it could not be optimized."
      );
    }

    // Mediabunny reports progress per packet, so this fires thousands of times
    // for a long recording — and the only consumer turns each call into a
    // setState over the upload list. Those re-renders run on the thread doing
    // the encoding, so an unfiltered callback spends the conversion competing
    // with itself. The value is a whole percent, so anything that does not move
    // it is a re-render that could not have changed a pixel.
    let reported = -1;
    conversion.onProgress = (progress) => {
      const percent = Math.min(99, Math.round(progress * 100));
      if (percent === reported) return;
      reported = percent;
      options.onProgress?.(percent);
    };
    await conversion.execute();
    throwIfAborted(options.signal);

    if (!target.buffer) {
      throw new Error("Audio optimization finished without producing a file.");
    }
    if (target.buffer.byteLength > AUDIO_URL_SAFE_BYTES) {
      throw new Error(
        "This recording is still too large after optimization. Split it into shorter recordings and upload each part."
      );
    }

    options.onProgress?.(100);
    return new File([target.buffer], optimizedName(file.name), {
      type: "audio/webm",
      lastModified: file.lastModified,
    });
  } finally {
    options.signal?.removeEventListener("abort", cancelConversion);
    input.dispose();
  }
}

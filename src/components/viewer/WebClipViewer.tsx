import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

interface WebClipViewerProps {
  url: string; // storage URL of the archived single-file HTML snapshot
}

// Not every stored blob is a styled single-file archive: older clippers
// saved bare Readability output with no CSS at all, which renders as
// unformatted text and natural-size images. Those get reader typography;
// real archives keep their own styles untouched.
const hasOwnStyles = (html: string): boolean =>
  /<style[\s>]|rel=["']?stylesheet/i.test(html);

const READER_HEAD = `<base target="_blank"><style>
  body { margin: 2rem auto; padding: 0 1.5rem; max-width: 42rem;
    font: 17px/1.65 Georgia, "Times New Roman", serif; color: #1a1a1a;
    background: #fff; overflow-wrap: break-word; }
  img, video { max-width: 100%; height: auto; }
  figure { margin: 1.5rem 0; }
  figcaption { font-size: 0.85em; color: #666; }
  h1, h2, h3, h4 { line-height: 1.25; font-family: system-ui, sans-serif; }
  a { color: #1a56db; }
  blockquote { margin: 1.5rem 0; padding-left: 1rem;
    border-left: 3px solid #ddd; color: #555; }
  pre { overflow-x: auto; }
  table { display: block; overflow-x: auto; border-collapse: collapse; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; }
</style>`;

function withReaderStyles(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  const at = head ? head.index + head[0].length : 0;
  return html.slice(0, at) + READER_HEAD + html.slice(at);
}

export function WebClipViewer({ url }: WebClipViewerProps) {
  const [state, setState] = useState<
    { html: string } | { error: string } | null
  >(null);

  // Reset for a new document during render, not in the effect — the effect
  // only starts the fetch.
  const [seenUrl, setSeenUrl] = useState(url);
  if (url !== seenUrl) {
    setSeenUrl(url);
    setState(null);
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        return response.text();
      })
      .then((html) => {
        setState({ html: hasOwnStyles(html) ? html : withReaderStyles(html) });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setState({ error: e instanceof Error ? e.message : String(e) });
      });
    return () => controller.abort();
  }, [url]);

  return (
    <div className="flex flex-col h-full w-full min-w-0">
      {state === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : "error" in state ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <AlertCircle className="size-4" />
          Couldn&apos;t load the archived page ({state.error})
        </div>
      ) : (
        // Scripts stay blocked; allow-popups lets the archive's
        // <base target="_blank"> links open the live page in a real tab,
        // escaping the sandbox so that tab runs normally.
        <iframe
          srcDoc={state.html}
          title="Archived web page"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          className="flex-1 min-h-0 w-full border-0 bg-white"
        />
      )}
    </div>
  );
}

import { ExternalLink, Globe } from "lucide-react";

interface WebClipViewerProps {
  url: string; // storage URL of the archived single-file HTML snapshot
  sourceUrl?: string;
  clippedAt?: number;
}

export function WebClipViewer({ url, sourceUrl, clippedAt }: WebClipViewerProps) {
  let domain: string | null = null;
  if (sourceUrl) {
    try {
      domain = new URL(sourceUrl).hostname;
    } catch {
      domain = null;
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-muted/50 text-xs text-muted-foreground shrink-0">
        <Globe className="size-3.5 shrink-0" />
        <span className="truncate">
          Archived snapshot
          {domain ? ` of ${domain}` : ""}
          {clippedAt
            ? ` · clipped ${new Date(clippedAt).toLocaleDateString()}`
            : ""}
        </span>
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 hover:text-foreground shrink-0"
          >
            View original <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      <iframe
        src={url}
        title="Archived web page"
        sandbox=""
        className="flex-1 w-full border-0 bg-white"
      />
    </div>
  );
}

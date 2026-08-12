interface ImageViewerProps {
  url: string;
  name: string;
}

/** Viewer panel for image documents (PNG/JPEG) — parses ride the same OCR path as PDFs. */
export function ImageViewer({ url, name }: ImageViewerProps) {
  return (
    <div className="h-full overflow-auto bg-muted/30 flex items-start justify-center p-6">
      <img
        src={url}
        alt={name}
        className="max-w-full h-auto rounded-md border shadow-sm bg-white"
      />
    </div>
  );
}

import { useState, useCallback } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { PageNavigator } from "./PageNavigator";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

interface PdfViewerProps {
  url: string;
  renderOverlay?: (pageNumber: number, dimensions: { width: number; height: number }) => React.ReactNode;
}

export function PdfViewer({ url, renderOverlay }: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageDimensions, setPageDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  const onDocumentLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  }, []);

  const onPageLoadSuccess = useCallback((page: { width: number; height: number }) => {
    setPageDimensions({ width: page.width, height: page.height });
  }, []);

  return (
    <div className="flex flex-col items-center gap-4">
      <PageNavigator
        currentPage={currentPage}
        numPages={numPages}
        onPageChange={setCurrentPage}
      />
      <div className="relative border rounded-lg overflow-hidden bg-white shadow-sm">
        <Document
          file={url}
          onLoadSuccess={onDocumentLoadSuccess}
          loading={
            <div className="flex items-center justify-center h-96 w-[600px]">
              <p className="text-muted-foreground">Loading PDF...</p>
            </div>
          }
        >
          <Page
            pageNumber={currentPage}
            width={600}
            onLoadSuccess={onPageLoadSuccess}
            renderAnnotationLayer={false}
          />
          {renderOverlay && pageDimensions.width > 0 && (
            <div className="absolute inset-0 pointer-events-none">
              {renderOverlay(currentPage, pageDimensions)}
            </div>
          )}
        </Document>
      </div>
    </div>
  );
}

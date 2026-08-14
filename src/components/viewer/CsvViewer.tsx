import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Download, Table } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

const MAX_PREVIEW_ROWS = 10_000;
const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 40;
const ROW_NUMBER_WIDTH = 72;
const COLUMN_WIDTH = 180;
const OVERSCAN_ROWS = 8;
const OVERSCAN_COLUMNS = 2;

interface Viewport {
  scrollTop: number;
  scrollLeft: number;
  width: number;
  height: number;
}

interface CsvViewerProps {
  url: string;
  name: string;
}

/**
 * Fast CSV preview. Parsing runs off the main thread and both axes are
 * virtualized, so DOM size stays bounded even when the stored file has many
 * thousands of rows or hundreds of columns.
 */
export function CsvViewer({ url, name }: CsvViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [parseWarningCount, setParseWarningCount] = useState(0);
  const [viewport, setViewport] = useState<Viewport>({
    scrollTop: 0,
    scrollLeft: 0,
    width: 1_000,
    height: 700,
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setRows(null);
    setError(null);
    setTruncated(false);
    setParseWarningCount(0);

    void fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        return response.text();
      })
      .then(async (text) => {
        if (!active) return;
        const Papa = (await import("papaparse")).default;
        if (!active) return;
        Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), {
          worker: true,
          preview: MAX_PREVIEW_ROWS + 2,
          skipEmptyLines: "greedy",
          complete: (result) => {
            if (!active) return;
            const parsedRows = result.data.map((row) =>
              row.map((cell) => String(cell ?? ""))
            );
            if (parsedRows.length === 0) {
              setError("This CSV contains no readable rows.");
              return;
            }
            const hasMore = parsedRows.length > MAX_PREVIEW_ROWS + 1;
            setTruncated(hasMore);
            setRows(parsedRows.slice(0, MAX_PREVIEW_ROWS + 1));
            setParseWarningCount(result.errors.length);
          },
          error: (parseError: Error) => {
            if (active) setError(parseError.message);
          },
        });
      })
      .catch((fetchError: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : "The CSV could not be loaded."
        );
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [url]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const updateSize = () =>
      setViewport((current) => ({
        ...current,
        width: element.clientWidth,
        height: element.clientHeight,
      }));
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [rows]);

  const table = useMemo(() => {
    if (!rows) return null;
    const columnCount = Math.max(1, ...rows.map((row) => row.length));
    const headerRow = rows[0] ?? [];
    return {
      headers: Array.from({ length: columnCount }, (_, index) =>
        headerRow[index]?.trim() || `Column ${index + 1}`
      ),
      body: rows.slice(1),
      columnCount,
    };
  }, [rows]);

  const visible = useMemo(() => {
    const rowCount = table?.body.length ?? 0;
    const columnCount = table?.columnCount ?? 0;
    const firstRow = Math.max(
      0,
      Math.floor((viewport.scrollTop - HEADER_HEIGHT) / ROW_HEIGHT) -
        OVERSCAN_ROWS
    );
    const lastRow = Math.min(
      rowCount,
      firstRow + Math.ceil(viewport.height / ROW_HEIGHT) + OVERSCAN_ROWS * 2
    );
    const firstColumn = Math.max(
      0,
      Math.floor(
        Math.max(0, viewport.scrollLeft - ROW_NUMBER_WIDTH) / COLUMN_WIDTH
      ) - OVERSCAN_COLUMNS
    );
    const lastColumn = Math.min(
      columnCount,
      firstColumn +
        Math.ceil(viewport.width / COLUMN_WIDTH) +
        OVERSCAN_COLUMNS * 2
    );
    return { firstRow, lastRow, firstColumn, lastColumn };
  }, [table, viewport]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertCircle className="size-7 text-destructive" />
        <div>
          <p className="font-medium">Couldn’t preview this CSV</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        </div>
        <a className="text-sm text-primary hover:underline" href={url} download={name}>
          Download the stored original
        </a>
      </div>
    );
  }

  if (!table) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Spinner className="size-4 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Parsing CSV…</p>
      </div>
    );
  }

  const visibleColumns = Array.from(
    { length: visible.lastColumn - visible.firstColumn },
    (_, index) => visible.firstColumn + index
  );
  const visibleRows = Array.from(
    { length: visible.lastRow - visible.firstRow },
    (_, index) => visible.firstRow + index
  );
  const totalWidth = ROW_NUMBER_WIDTH + table.columnCount * COLUMN_WIDTH;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-muted/40 px-3 text-xs text-muted-foreground">
        <Table className="size-3.5" />
        <span>
          {truncated ? "Previewing first " : ""}
          {table.body.length.toLocaleString()} row
          {table.body.length === 1 ? "" : "s"} × {table.columnCount.toLocaleString()} column
          {table.columnCount === 1 ? "" : "s"}
        </span>
        {parseWarningCount > 0 && (
          <span title="The preview recovered from malformed CSV rows">
            · {parseWarningCount} parse warning{parseWarningCount === 1 ? "" : "s"}
          </span>
        )}
        <span className="ml-auto hidden sm:inline">Original stored · complete file analyzed</span>
        <a
          href={url}
          download={name}
          className="inline-flex items-center gap-1 text-foreground hover:text-primary"
        >
          <Download className="size-3.5" />
          Download
        </a>
      </div>

      <div
        ref={scrollRef}
        role="region"
        aria-label="CSV data grid"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto bg-muted/15 font-mono text-xs"
        onScroll={(event) => {
          const element = event.currentTarget;
          setViewport((current) => ({
            ...current,
            scrollTop: element.scrollTop,
            scrollLeft: element.scrollLeft,
          }));
        }}
      >
        <div style={{ width: totalWidth, minWidth: "100%" }}>
          <div
            className="sticky top-0 z-20 border-b bg-muted shadow-sm"
            style={{ width: totalWidth, height: HEADER_HEIGHT }}
          >
            <div
              className="sticky left-0 z-30 flex items-center border-r bg-muted px-3 font-semibold text-muted-foreground"
              style={{ width: ROW_NUMBER_WIDTH, height: HEADER_HEIGHT }}
            >
              Row
            </div>
            {visibleColumns.map((columnIndex) => (
              <div
                key={columnIndex}
                className="absolute top-0 flex items-center truncate border-r px-3 font-semibold"
                style={{
                  left: ROW_NUMBER_WIDTH + columnIndex * COLUMN_WIDTH,
                  width: COLUMN_WIDTH,
                  height: HEADER_HEIGHT,
                }}
                title={table.headers[columnIndex]}
              >
                {table.headers[columnIndex]}
              </div>
            ))}
          </div>

          <div
            className="relative"
            style={{ height: table.body.length * ROW_HEIGHT, width: totalWidth }}
          >
            {visibleRows.map((rowIndex) => {
              const row = table.body[rowIndex] ?? [];
              return (
                <div
                  key={rowIndex}
                  className="absolute left-0 border-b hover:bg-accent/60"
                  style={{
                    top: rowIndex * ROW_HEIGHT,
                    width: totalWidth,
                    height: ROW_HEIGHT,
                  }}
                >
                  <div
                    className="sticky left-0 z-10 flex items-center justify-end border-r bg-background px-3 text-muted-foreground"
                    style={{ width: ROW_NUMBER_WIDTH, height: ROW_HEIGHT }}
                  >
                    {(rowIndex + 1).toLocaleString()}
                  </div>
                  {visibleColumns.map((columnIndex) => {
                    const value = row[columnIndex] ?? "";
                    return (
                      <div
                        key={columnIndex}
                        className="absolute top-0 flex items-center truncate border-r px-3"
                        style={{
                          left: ROW_NUMBER_WIDTH + columnIndex * COLUMN_WIDTH,
                          width: COLUMN_WIDTH,
                          height: ROW_HEIGHT,
                        }}
                        title={value}
                      >
                        {value || <span className="text-muted-foreground/50">—</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

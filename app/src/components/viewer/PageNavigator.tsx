import { Button } from "@/components/ui/button";

interface PageNavigatorProps {
  currentPage: number;
  numPages: number;
  onPageChange: (page: number) => void;
}

export function PageNavigator({ currentPage, numPages, onPageChange }: PageNavigatorProps) {
  if (numPages === 0) return null;

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        disabled={currentPage <= 1}
      >
        Previous
      </Button>
      <span className="text-sm text-muted-foreground tabular-nums">
        Page {currentPage} of {numPages}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(Math.min(numPages, currentPage + 1))}
        disabled={currentPage >= numPages}
      >
        Next
      </Button>
    </div>
  );
}

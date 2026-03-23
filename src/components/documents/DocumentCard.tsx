import { Link } from "react-router-dom";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Doc } from "../../../convex/_generated/dataModel";

const statusColors: Record<string, string> = {
  uploaded: "bg-muted text-muted-foreground",
  parsing: "bg-blue-100 text-blue-800",
  parsed: "bg-blue-100 text-blue-800",
  extracting: "bg-amber-100 text-amber-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

const statusLabels: Record<string, string> = {
  uploaded: "Uploaded",
  parsing: "Parsing",
  parsed: "Parsed",
  extracting: "Extracting",
  completed: "Completed",
  failed: "Failed",
};

export function DocumentCard({ document }: { document: Doc<"documents"> }) {
  const removeDocument = useMutation(api.documents.remove);

  return (
    <Card className="hover:bg-accent/50 transition-colors">
      <CardHeader className="p-4">
        <div className="flex items-start justify-between gap-2">
          <Link to={`/documents/${document._id}`} className="min-w-0 flex-1">
            <CardTitle className="text-sm font-medium truncate cursor-pointer hover:underline">
              {document.name}
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              {new Date(document.uploadedAt).toLocaleDateString()}
              {document.pageCount && ` \u00B7 ${document.pageCount} pages`}
            </CardDescription>
          </Link>
          <div className="flex items-center gap-1.5 shrink-0">
            <Badge
              variant="secondary"
              className={statusColors[document.status] ?? ""}
            >
              {statusLabels[document.status] ?? document.status}
            </Badge>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-red-600 hover:bg-red-50"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (window.confirm(`Delete "${document.name}"?`)) {
                  removeDocument({ id: document._id });
                }
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </Button>
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}

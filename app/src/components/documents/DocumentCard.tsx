import { Link } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Doc } from "../../../convex/_generated/dataModel";

const statusColors: Record<string, string> = {
  uploaded: "bg-muted text-muted-foreground",
  ocr_processing: "bg-blue-100 text-blue-800",
  ner_processing: "bg-purple-100 text-purple-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

const statusLabels: Record<string, string> = {
  uploaded: "Uploaded",
  ocr_processing: "OCR Processing",
  ner_processing: "NER Processing",
  completed: "Completed",
  failed: "Failed",
};

export function DocumentCard({ document }: { document: Doc<"documents"> }) {
  return (
    <Link to={`/documents/${document._id}`}>
      <Card className="hover:bg-accent/50 transition-colors cursor-pointer">
        <CardHeader className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-sm font-medium truncate">
                {document.name}
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                {new Date(document.uploadedAt).toLocaleDateString()}
                {document.pageCount && ` \u00B7 ${document.pageCount} pages`}
              </CardDescription>
            </div>
            <Badge
              variant="secondary"
              className={statusColors[document.status] ?? ""}
            >
              {statusLabels[document.status] ?? document.status}
            </Badge>
          </div>
        </CardHeader>
      </Card>
    </Link>
  );
}

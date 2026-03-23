import { Link } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Doc } from "../../../convex/_generated/dataModel";

export function EntityCard({ entity }: { entity: Doc<"entities"> }) {
  return (
    <Link to={`/entities/${entity._id}`}>
      <Card className="hover:bg-accent/50 transition-colors cursor-pointer">
        <CardHeader className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-sm font-medium truncate">
                {entity.name}
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                {entity.mentionCount} mention{entity.mentionCount !== 1 && "s"}
                {" \u00B7 "}
                {entity.documentCount} doc{entity.documentCount !== 1 && "s"}
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-xs">
              {Math.round(entity.avgConfidence * 100)}%
            </Badge>
          </div>
        </CardHeader>
      </Card>
    </Link>
  );
}

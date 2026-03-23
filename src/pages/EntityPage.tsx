import { useParams, Link } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

export default function EntityPage() {
  const { slug } = useParams<{ slug: string }>();
  const entity = useQuery(api.entities.getBySlug, { slug: slug ?? "" });
  const documents = useQuery(
    api.entities.documentsForEntity,
    entity ? { entityId: entity._id } : "skip"
  );

  if (entity === undefined) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
      </div>
    );
  }

  if (entity === null) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Entity not found.</p>
        <Link to="/" className="text-sm underline mt-2 inline-block">
          Back to home
        </Link>
      </div>
    );
  }

  const typeLabels: Record<string, string> = {
    people: "Person",
    organization: "Organization",
    places: "Place",
    dates: "Date",
  };

  return (
    <div className="flex flex-col h-screen">
      <header className="border-b px-6 py-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
          <Link to="/" className="hover:text-foreground">
            Home
          </Link>
          <span>/</span>
          <span>{entity.name}</span>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">{entity.name}</h1>
          <Badge variant="outline" className="text-xs capitalize">
            {typeLabels[entity.type] ?? entity.type}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          {entity.mentionCount} mention{entity.mentionCount !== 1 && "s"} across{" "}
          {entity.documentCount} document{entity.documentCount !== 1 && "s"}
        </p>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <h2 className="text-lg font-semibold mb-3">Appears In</h2>

        {documents === undefined ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        ) : documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No document mentions found.
          </p>
        ) : (
          <div className="flex flex-col">
            {documents.map((doc) => (
              <Link
                key={doc._id}
                to={`/documents/${doc._id}`}
                className="flex items-center justify-between py-1.5 px-1 -mx-1 rounded hover:bg-accent/50 transition-colors"
              >
                <span className="text-sm truncate">{doc.name}</span>
                <span className="text-xs text-muted-foreground shrink-0 ml-3">
                  {doc.mentionCount} mention{doc.mentionCount !== 1 && "s"}
                </span>
              </Link>
            ))}
          </div>
        )}

        {entity.aliases.length > 0 && (
          <div className="mt-6">
            <h2 className="text-lg font-semibold mb-2">Aliases</h2>
            <div className="flex flex-wrap gap-2">
              {entity.aliases.map((alias) => (
                <Badge key={alias} variant="secondary" className="text-xs">
                  {alias}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

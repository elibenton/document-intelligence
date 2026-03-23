import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";

export default function StoryPage() {
  const { slug } = useParams<{ slug: string }>();
  const story = useQuery(api.stories.getBySlug, { slug: slug ?? "" });
  const documents = useQuery(
    api.stories.documentsForStory,
    story ? { storyId: story._id } : "skip"
  );
  const entities = useQuery(
    api.stories.entitiesForStory,
    story ? { storyId: story._id } : "skip"
  );
  const toggleStar = useMutation(api.stories.toggleStar);

  if (story === undefined) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
      </div>
    );
  }

  if (story === null) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Story not found.</p>
        <Link to="/" className="text-sm underline mt-2 inline-block">
          Back to home
        </Link>
      </div>
    );
  }

  // Group entities by type
  const entityGroups = new Map<string, NonNullable<typeof entities>>();
  if (entities) {
    for (const entity of entities) {
      const group = entityGroups.get(entity.type) ?? [];
      group.push(entity);
      entityGroups.set(entity.type, group);
    }
  }

  const sortedTypes = [...entityGroups.keys()].sort((a, b) => {
    if (a === "people") return -1;
    if (b === "people") return 1;
    return a.localeCompare(b);
  });

  const typeLabels: Record<string, string> = {
    people: "People",
    organization: "Organizations",
    places: "Places",
    dates: "Dates",
  };

  const toSlug = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  return (
    <div className="flex flex-col h-screen">
      <header className="border-b px-6 py-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
          <Link to="/" className="hover:text-foreground">
            Home
          </Link>
          <span>/</span>
          <span>{story.name}</span>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">{story.name}</h1>
          <button
            onClick={() => toggleStar({ id: story._id })}
            className={`text-lg ${story.starred ? "text-amber-500" : "text-muted-foreground hover:text-amber-500"}`}
            title={story.starred ? "Unstar" : "Star"}
          >
            {story.starred ? "★" : "☆"}
          </button>
        </div>
        {story.description && (
          <p className="text-sm text-muted-foreground mt-1">
            {story.description}
          </p>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left 2/3 — Documents */}
        <div className="w-2/3 border-r p-6 overflow-y-auto">
          <h2 className="text-lg font-semibold mb-3">
            Documents
            {documents && (
              <span className="text-sm font-normal text-muted-foreground ml-2">
                ({documents.length})
              </span>
            )}
          </h2>

          {documents === undefined ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ) : documents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No documents in this story yet.
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
                    {doc.pageCount && `${doc.pageCount} pages`}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Right 1/3 — Entities */}
        <div className="w-1/3 p-6 overflow-y-auto">
          <h2 className="text-lg font-semibold mb-4">
            Entities
            {entities && (
              <span className="text-sm font-normal text-muted-foreground ml-2">
                ({entities.length})
              </span>
            )}
          </h2>

          {entities === undefined ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ) : entities.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No entities yet. Run extractions on the story's documents.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {sortedTypes.map((type) => (
                <div key={type}>
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                    {typeLabels[type] ?? type}
                  </h3>
                  <div className="flex flex-col">
                    {entityGroups.get(type)!.map((entity) => (
                      <Link
                        key={entity._id}
                        to={`/entity/${toSlug(entity.name)}`}
                        className="flex items-center justify-between py-1 px-1 -mx-1 rounded hover:bg-accent/50 transition-colors"
                      >
                        <span className="text-sm truncate">{entity.name}</span>
                        <span className="text-xs text-muted-foreground shrink-0 ml-3">
                          {entity.mentionCount} mention
                          {entity.mentionCount !== 1 && "s"}
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

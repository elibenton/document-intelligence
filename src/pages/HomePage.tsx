import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { UploadButton } from "@/components/documents/UploadButton";
import { Skeleton } from "@/components/ui/skeleton";

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export default function HomePage() {
  const documents = useQuery(api.documents.list);
  const entities = useQuery(api.entities.listAll);
  const starredStories = useQuery(api.stories.listStarredWithCounts);
  const allStories = useQuery(api.stories.list);

  const createStory = useMutation(api.stories.create);
  const toggleStar = useMutation(api.stories.toggleStar);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newStoryName, setNewStoryName] = useState("");

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

  async function handleCreateStory(e: React.FormEvent) {
    e.preventDefault();
    if (!newStoryName.trim()) return;
    await createStory({ name: newStoryName.trim(), starred: true });
    setNewStoryName("");
    setShowCreateForm(false);
  }

  return (
    <div className="flex flex-col h-screen">
      <header className="border-b px-6 py-4">
        <h1 className="text-xl font-bold">Document Intelligence</h1>
        <p className="text-sm text-muted-foreground">
          Upload PDFs, extract entities, uncover connections.
        </p>
      </header>
      <div className="flex flex-1 overflow-hidden">
        {/* Left 2/3 — Stories + Documents */}
        <div className="w-2/3 border-r p-6 overflow-y-auto">
          {/* Starred Stories */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Stories</h2>
              <button
                onClick={() => setShowCreateForm(!showCreateForm)}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {showCreateForm ? "Cancel" : "+ New Story"}
              </button>
            </div>

            {showCreateForm && (
              <form onSubmit={handleCreateStory} className="flex gap-2 mb-4">
                <input
                  type="text"
                  value={newStoryName}
                  onChange={(e) => setNewStoryName(e.target.value)}
                  placeholder="Story name..."
                  className="flex-1 text-sm border rounded px-3 py-1.5 bg-background"
                  autoFocus
                />
                <button
                  type="submit"
                  className="text-sm px-3 py-1.5 bg-primary text-primary-foreground rounded hover:bg-primary/90"
                >
                  Create
                </button>
              </form>
            )}

            {starredStories === undefined ? (
              <div className="grid grid-cols-3 gap-4">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </div>
            ) : starredStories.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center border rounded-lg">
                No starred stories yet. Create a story and star it to pin it
                here.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-4">
                {starredStories.map((story) => (
                  <div
                    key={story._id}
                    className="rounded-lg border bg-card p-4 hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-1">
                      <Link
                        to={`/story/${story.slug}`}
                        className="font-medium text-sm truncate flex-1 hover:underline"
                      >
                        {story.name}
                      </Link>
                      <button
                        onClick={() => toggleStar({ id: story._id })}
                        className="text-amber-500 hover:text-amber-600 shrink-0"
                        title="Unstar"
                      >
                        ★
                      </button>
                    </div>
                    {story.description && (
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        {story.description}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-2">
                      {story.documentCount} doc
                      {story.documentCount !== 1 && "s"}
                      {" · "}
                      {story.entityCount} entit
                      {story.entityCount !== 1 ? "ies" : "y"}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {/* Unstarred stories as compact list */}
            {allStories && allStories.filter((s) => !s.starred).length > 0 && (
              <div className="mt-4">
                <h3 className="text-sm font-medium text-muted-foreground mb-2">
                  All Stories
                </h3>
                <div className="flex flex-col">
                  {allStories
                    .filter((s) => !s.starred)
                    .map((story) => (
                      <div
                        key={story._id}
                        className="flex items-center justify-between py-1.5 px-1 -mx-1 rounded hover:bg-accent/50 transition-colors group"
                      >
                        <Link
                          to={`/story/${story.slug}`}
                          className="text-sm truncate hover:underline"
                        >
                          {story.name}
                        </Link>
                        <button
                          onClick={() => toggleStar({ id: story._id })}
                          className="text-xs text-muted-foreground hover:text-amber-500 shrink-0 ml-3"
                          title="Star"
                        >
                          ☆
                        </button>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>

          {/* All Documents */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold">Documents</h2>
              <UploadButton />
            </div>

            {documents === undefined ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            ) : documents.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No documents yet. Upload a PDF to get started.
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
                      {new Date(doc.uploadedAt).toLocaleDateString()}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right 1/3 — Entities grouped by type */}
        <div className="w-1/3 p-6 overflow-y-auto">
          <h2 className="text-lg font-semibold mb-4">Entities</h2>

          {entities === undefined ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </div>
          ) : entities.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No entities found yet. Open a document and run an extraction.
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

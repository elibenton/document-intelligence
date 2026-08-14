import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * The `/p/:slug` address of a project the caller knows only by id.
 *
 * The viewer, an entity page and a search all arrive holding a project id and
 * need the slug for one thing: the back-link. That stays a small lookup rather
 * than being folded into each page's main query — the row is a few fields and
 * is usually already in the client's cache from the project page the user came
 * from. Until it resolves the caller has no slug, so the back-link falls back
 * to the project picker.
 */
export function useProjectSlug(
  projectId: Id<"projects"> | null | undefined
): string | undefined {
  return useQuery(api.projects.get, projectId ? { id: projectId } : "skip")
    ?.slug;
}

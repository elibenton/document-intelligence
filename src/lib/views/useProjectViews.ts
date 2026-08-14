import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { DEFAULT_LIBRARY_VIEW } from "./documentProperties";
import { DEFAULT_ENTITIES_VIEW } from "./entityProperties";
import type { ViewConfig } from "./types";

/**
 * The saved state of a project's two lists, plus the divider between them.
 *
 * Local edits are layered over the stored value rather than copied into state:
 * the effective config is `local ?? stored ?? default`. That ordering does two
 * jobs at once — the list responds to a click immediately instead of after a
 * round trip, and the echo of our own debounced write coming back through the
 * query can't clobber a newer local edit.
 */

const PERSIST_DELAY_MS = 400;
export const DEFAULT_SPLIT_RATIO = 2 / 3;

const DEFAULTS = {
  library: DEFAULT_LIBRARY_VIEW as ViewConfig,
  entities: DEFAULT_ENTITIES_VIEW as ViewConfig,
};

export function useProjectViews(projectId: Id<"projects">) {
  const stored = useQuery(api.projectViews.get, { projectId });
  const save = useMutation(api.projectViews.save);

  const [localLibrary, setLocalLibrary] = useState<ViewConfig | null>(null);
  const [localEntities, setLocalEntities] = useState<ViewConfig | null>(null);
  const [localRatio, setLocalRatio] = useState<number | null>(null);

  // Navigating to another project reuses this component, so the previous
  // project's unsaved edits have to be dropped. Adjusting state during render
  // is React's sanctioned way to reset on a changed input — an effect would
  // render one frame of the wrong project's view first.
  const [seenProject, setSeenProject] = useState(projectId);
  if (seenProject !== projectId) {
    setSeenProject(projectId);
    setLocalLibrary(null);
    setLocalEntities(null);
    setLocalRatio(null);
  }

  const library = localLibrary ?? (stored?.library as ViewConfig) ?? DEFAULTS.library;
  const entities =
    localEntities ?? (stored?.entities as ViewConfig) ?? DEFAULTS.entities;
  const splitRatio = localRatio ?? stored?.splitRatio ?? DEFAULT_SPLIT_RATIO;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Parameters<typeof save>[0] | null>(null);

  const persist = useCallback(
    (patch: { library?: ViewConfig; entities?: ViewConfig; splitRatio?: number }) => {
      pending.current = { ...(pending.current ?? {}), projectId, ...patch };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const args = pending.current;
        pending.current = null;
        if (args) void save(args);
      }, PERSIST_DELAY_MS);
    },
    [projectId, save]
  );

  // Don't strand the last edit if the page unmounts mid-debounce.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) void save(pending.current);
    };
  }, [save]);

  const setLibrary = useCallback(
    (config: ViewConfig) => {
      setLocalLibrary(config);
      persist({ library: config });
    },
    [persist]
  );

  const setEntities = useCallback(
    (config: ViewConfig) => {
      setLocalEntities(config);
      persist({ entities: config });
    },
    [persist]
  );

  const setSplitRatio = useCallback(
    (ratio: number) => {
      setLocalRatio(ratio);
      persist({ splitRatio: ratio });
    },
    [persist]
  );

  return {
    library,
    entities,
    splitRatio,
    setLibrary,
    setEntities,
    setSplitRatio,
  };
}

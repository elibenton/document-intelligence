import { useCallback, useRef, useState } from "react";
import { useMutation } from "convex/react";
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { MergeCandidate } from "./EntityMergeDialog";

/**
 * Drag-one-entity-onto-another to merge, shared by the document sidebar and
 * the project page's Entities panel: the drag state, the survivor-picker
 * pair, the mergeManual call with in-dialog error reporting, and the
 * immediate-undo state. The rendering (MergeDropRow, EntityMergeDialog,
 * MergeUndoBar) stays with the pages; this owns everything they agree on.
 */
export function useEntityMergeDnd(
  entities:
    | { _id: Id<"entities">; name: string; mentionCount: number }[]
    | undefined
) {
  // For a standalone DndContext (the document sidebar). The project page's
  // rows ride the group-sort context's own sensors instead.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );
  const [draggedName, setDraggedName] = useState<string | null>(null);
  const [mergePair, setMergePair] = useState<{
    a: MergeCandidate;
    b: MergeCandidate;
  } | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeUndo, setMergeUndo] = useState<{
    logId: Id<"mergeLog">;
    survivorName: string;
    mergedName: string;
  } | null>(null);
  const mergeManual = useMutation(api.mergeSuggestions.mergeManual);
  const unmergeMutation = useMutation(api.mergeSuggestions.unmerge);

  // The drop's trailing click lands on the target row — a search-load in the
  // sidebar, a navigation on the project page. MergeDropRow reads this to
  // swallow that one click.
  const suppressClickRef = useRef(false);
  const suppressNextClick = useCallback(() => {
    suppressClickRef.current = true;
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }, []);

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const entity = entities?.find((e) => e._id === event.active.id);
      setDraggedName(entity?.name ?? null);
    },
    [entities]
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggedName(null);
      suppressNextClick();
      const { active, over } = event;
      if (!over || over.id === active.id) return;
      const byId = new Map(
        (entities ?? []).map((entity) => [entity._id as string, entity])
      );
      const a = byId.get(String(active.id));
      const b = byId.get(String(over.id));
      if (!a || !b) return;
      setMergeError(null);
      setMergePair({
        a: { _id: a._id, name: a.name, mentionCount: a.mentionCount },
        b: { _id: b._id, name: b.name, mentionCount: b.mentionCount },
      });
    },
    [entities, suppressNextClick]
  );

  const onDragCancel = useCallback(() => {
    setDraggedName(null);
    suppressNextClick();
  }, [suppressNextClick]);

  const runMerge = useCallback(
    (keepEntityId: Id<"entities">) => {
      if (!mergePair || mergeBusy) return;
      setMergeBusy(true);
      setMergeError(null);
      void (async () => {
        try {
          const result = await mergeManual({
            entityId: mergePair.a._id,
            otherEntityId: mergePair.b._id,
            keepEntityId,
          });
          const survivor =
            keepEntityId === mergePair.a._id ? mergePair.a : mergePair.b;
          const merged =
            keepEntityId === mergePair.a._id ? mergePair.b : mergePair.a;
          if (result?.mergeLogId) {
            setMergeUndo({
              logId: result.mergeLogId,
              survivorName: survivor.name,
              mergedName: merged.name,
            });
          }
          setMergePair(null);
        } catch {
          // The pair may have changed under us — a concurrent merge or
          // delete. Say so in the dialog rather than closing it silently.
          setMergeError(
            "The merge failed — one of these entities may have just changed. Close and try again."
          );
        } finally {
          setMergeBusy(false);
        }
      })();
    },
    [mergeBusy, mergeManual, mergePair]
  );

  const undoLast = useCallback(() => {
    if (!mergeUndo) return;
    void unmergeMutation({ logId: mergeUndo.logId });
    setMergeUndo(null);
  }, [mergeUndo, unmergeMutation]);

  return {
    sensors,
    suppressClickRef,
    draggedName,
    mergePair,
    mergeBusy,
    mergeError,
    mergeUndo,
    onDragStart,
    onDragEnd,
    onDragCancel,
    runMerge,
    closeDialog: useCallback(() => setMergePair(null), []),
    undoLast,
  };
}

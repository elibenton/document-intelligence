import type { ReactNode, RefObject } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import type { Id } from "../../../convex/_generated/dataModel";

/**
 * One entity row as a drag-merge participant: draggable by its row (pointer
 * only — the merge queue remains the keyboard path to a merge), and a drop
 * target for any other row. While another entity hovers here, the row
 * ring-highlights and a small "Merge with …" helper names what a drop does.
 *
 * Both roles carry `data.rowDrag`, which is how a shared DndContext (the
 * project page's group-sort context) tells a row drag from a heading drag.
 * The wrapper also swallows the drop's trailing click, which would otherwise
 * activate whatever the row does on click.
 */
export function MergeDropRow({
  entityId,
  name,
  suppressClickRef,
  children,
}: {
  entityId: Id<"entities"> | undefined;
  name: string;
  suppressClickRef: RefObject<boolean>;
  children: (drag: {
    handleProps: React.HTMLAttributes<HTMLElement>;
    isDragging: boolean;
  }) => ReactNode;
}) {
  const id = entityId ?? `unresolved:${name}`;
  const draggable = useDraggable({
    id,
    disabled: entityId === undefined,
    data: { rowDrag: true },
  });
  const droppable = useDroppable({
    id,
    disabled: entityId === undefined || draggable.isDragging,
    data: { rowDrag: true },
  });
  return (
    <div
      ref={(el) => {
        draggable.setNodeRef(el);
        droppable.setNodeRef(el);
      }}
      onClickCapture={(event) => {
        if (suppressClickRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      className={cn(
        "relative",
        droppable.isOver && "rounded-md ring-2 ring-primary/60"
      )}
    >
      {children({
        handleProps: {
          onPointerDown: draggable.listeners?.onPointerDown as
            | React.PointerEventHandler<HTMLElement>
            | undefined,
        },
        isDragging: draggable.isDragging,
      })}
      {droppable.isOver && (
        <span className="pointer-events-none absolute -top-2 right-2 z-10 rounded-full border bg-background px-2 py-0.5 text-2xs font-medium shadow-sm">
          Merge with {name}
        </span>
      )}
    </div>
  );
}

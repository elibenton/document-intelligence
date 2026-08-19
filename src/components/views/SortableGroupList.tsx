import {
  useCallback,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ListGroup } from "./ListGroup";

type DragHandle = ComponentProps<typeof ListGroup>["dragHandle"];

interface SortableGroup {
  key: string;
  label: string;
  /** The no-value bucket pins to the bottom in every sort — it never drags. */
  isEmpty: boolean;
  rows: unknown[];
}

/**
 * Drag-to-reorder for a list's group headings, shared by the Library and
 * Entities panels (dnd-kit underneath — Base UI has no drag primitive).
 *
 * Pointer drags lift from anywhere on a heading; the 6px activation distance
 * keeps a plain click toggling the disclosure. The grip button carries the
 * keyboard interaction (Space lifts, arrows move, Space drops — dnd-kit
 * announces each step to screen readers). While dragging, the group parks in
 * its slot as a dimmed placeholder and a compact heading chip follows the
 * cursor, so an open group's whole body never rides along under the pointer.
 * A drop suppresses the gesture's trailing click so the disclosure it lands
 * on doesn't also toggle.
 */
export function SortableGroupList<G extends SortableGroup>({
  groups,
  enabled,
  onReorder,
  renderGroup,
}: {
  groups: G[];
  /** False for ungrouped lists — there are no headings to drag. */
  enabled: boolean;
  /** The full key order, top to bottom, after a drop. */
  onReorder: (orderedKeys: string[]) => void;
  /** Render one group; spread `dragHandle` into its ListGroup when given. */
  renderGroup: (group: G, dragHandle: DragHandle) => ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  // The drop's trailing click would toggle the heading it lands on — the
  // same gesture-tail problem the viewer popovers defer past.
  const suppressToggle = useRef(false);
  const [dragging, setDragging] = useState<{
    label: string;
    count: number;
  } | null>(null);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const group = groups.find((g) => g.key === event.active.id);
      if (group) setDragging({ label: group.label, count: group.rows.length });
    },
    [groups]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDragging(null);
      suppressToggle.current = true;
      setTimeout(() => {
        suppressToggle.current = false;
      }, 0);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const keys = groups.filter((g) => !g.isEmpty).map((g) => g.key);
      const from = keys.indexOf(String(active.id));
      const to = keys.indexOf(String(over.id));
      if (from === -1 || to === -1) return;
      onReorder(arrayMove(keys, from, to));
    },
    [groups, onReorder]
  );

  if (!enabled) {
    return <>{groups.map((group) => renderGroup(group, undefined))}</>;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <SortableContext
        items={groups.filter((g) => !g.isEmpty).map((g) => g.key)}
        strategy={verticalListSortingStrategy}
      >
        {groups.map((group) =>
          group.isEmpty ? (
            <div key={group.key}>{renderGroup(group, undefined)}</div>
          ) : (
            <SortableItem
              key={group.key}
              group={group}
              suppressToggle={suppressToggle}
              renderGroup={renderGroup}
            />
          )
        )}
      </SortableContext>
      <DragOverlay>
        {dragging && (
          <div className="flex cursor-grabbing items-center justify-between rounded-md border bg-background px-2 py-1.5 shadow-md">
            <span className="text-sm font-medium">{dragging.label}</span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {dragging.count}
            </span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function SortableItem<G extends SortableGroup>({
  group,
  suppressToggle,
  renderGroup,
}: {
  group: G;
  suppressToggle: React.RefObject<boolean>;
  renderGroup: (group: G, dragHandle: DragHandle) => ReactNode;
}) {
  const { setNodeRef, transform, transition, listeners, attributes, isDragging } =
    useSortable({ id: group.key });
  return (
    // While dragging, the in-list original goes fully invisible — the
    // DragOverlay chip is the only visual. It keeps its transform so the
    // sorting strategy's layout stays consistent; hiding rather than dimming
    // is what keeps the screen free of a ghost heading under the chip.
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "opacity-0")}
    >
      {renderGroup(group, {
        summaryProps: {
          onPointerDown: listeners?.onPointerDown as
            | React.PointerEventHandler<HTMLElement>
            | undefined,
          onClickCapture: (event) => {
            if (suppressToggle.current) {
              event.preventDefault();
              event.stopPropagation();
            }
          },
        },
        grip: (
          // A plain <button>, deliberately: Base UI's Button owns Space/Enter
          // for its press behavior, which ate the KeyboardSensor's lift —
          // measured in the harness, the drag never engaged through it. The
          // handle's semantics come from dnd-kit's own attributes
          // (role/tabIndex/aria-roledescription + live announcements).
          <Tooltip content="Drag to reorder">
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Reorder the ${group.label} group`}
            onClick={(event) => {
              // A click on the grip is a grab, never a disclosure toggle.
              event.preventDefault();
              event.stopPropagation();
            }}
            className={cn(
              "grid size-6 shrink-0 cursor-grab place-items-center rounded-md text-muted-foreground",
              "opacity-0 transition-opacity hover:bg-accent group-hover/heading:opacity-100",
              "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring",
              "active:cursor-grabbing"
            )}
          >
            <GripVertical className="size-3.5" />
          </button>
          </Tooltip>
        ),
      })}
    </div>
  );
}

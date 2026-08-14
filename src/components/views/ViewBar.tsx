import { useEffect, useRef, useState } from "react";
import {
  ArrowUpDown,
  Filter,
  GripVertical,
  Layers,
  Plus,
  Search,
  Settings2,
  X,
} from "lucide-react";
import {
  OPERATOR_LABELS,
  OPERATORS_BY_KIND,
  operatorArity,
  type FilterCondition,
  type FilterOperator,
  type GroupSort,
  type PropertyDef,
  type PropertyOption,
  type ViewConfig,
} from "@/lib/views/types";
import { cn } from "@/lib/utils";
import { MiniSelect, PanelHeading, ViewPopover } from "./ViewPopover";

/**
 * The four view controls — properties, grouping, filtering, ordering — plus
 * free-text search and a reset.
 *
 * Every menu here is generated from the property registry it is handed, so
 * this component knows nothing about documents or entities. Both lists render
 * the same bar.
 */

interface ViewBarProps<T> {
  defs: PropertyDef<T>[];
  config: ViewConfig;
  onChange: (config: ViewConfig) => void;
  /** All rows, unfiltered — property option lists are computed from these. */
  rows: T[];
  query: string;
  onQueryChange: (query: string) => void;
  onReset: () => void;
  isDefault: boolean;
}

export function ViewBar<T>({
  defs,
  config,
  onChange,
  rows,
  query,
  onQueryChange,
  onReset,
  isDefault,
}: ViewBarProps<T>) {
  return (
    <div className="flex items-center gap-1 bg-background">
      <PropertiesPanel defs={defs} config={config} onChange={onChange} />
      <GroupPanel defs={defs} config={config} onChange={onChange} />
      <FilterPanel defs={defs} config={config} onChange={onChange} rows={rows} />
      <SortPanel defs={defs} config={config} onChange={onChange} />
      <ToolbarSearch value={query} onChange={onQueryChange} />
      {(!isDefault || query !== "") && (
        <button
          type="button"
          onClick={onReset}
          aria-label="Reset this view"
          title="Reset this view"
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Properties — which chips show, and in what order
// ---------------------------------------------------------------------------

function PropertiesPanel<T>({
  defs,
  config,
  onChange,
}: {
  defs: PropertyDef<T>[];
  config: ViewConfig;
  onChange: (config: ViewConfig) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const hideable = defs.filter((def) => !def.pinned);
  const visible = config.visibleProperties.filter((id) =>
    hideable.some((def) => def.id === id)
  );
  const hidden = hideable
    .filter((def) => !visible.includes(def.id))
    .map((def) => def.id);

  const labelOf = (id: string) => defs.find((def) => def.id === id)?.label ?? id;

  function toggle(id: string) {
    onChange({
      ...config,
      visibleProperties: visible.includes(id)
        ? visible.filter((other) => other !== id)
        : [...visible, id],
    });
  }

  function moveBefore(dragged: string, target: string) {
    if (dragged === target) return;
    const next = visible.filter((id) => id !== dragged);
    next.splice(next.indexOf(target), 0, dragged);
    onChange({ ...config, visibleProperties: next });
  }

  return (
    <ViewPopover
      icon={Settings2}
      label="Properties"
      active={visible.length > 0}
      width="w-64"
    >
      <PanelHeading>Shown — drag to reorder</PanelHeading>
      {visible.length === 0 && (
        <p className="px-1 pb-2 text-xs text-muted-foreground">
          Nothing but the title.
        </p>
      )}
      {visible.map((id) => (
        <div
          key={id}
          draggable
          onDragStart={() => setDragging(id)}
          onDragEnd={() => setDragging(null)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => dragging && moveBefore(dragging, id)}
          className={cn(
            "flex items-center gap-1 rounded px-1 py-1 text-xs hover:bg-accent",
            dragging === id && "opacity-40"
          )}
        >
          <GripVertical className="size-3 shrink-0 cursor-grab text-muted-foreground" />
          <input
            type="checkbox"
            checked
            onChange={() => toggle(id)}
            aria-label={`Hide ${labelOf(id)}`}
            className="size-3 shrink-0 cursor-pointer accent-primary"
          />
          <span className="truncate">{labelOf(id)}</span>
        </div>
      ))}

      {hidden.length > 0 && (
        <>
          <PanelHeading>Hidden</PanelHeading>
          {hidden.map((id) => (
            <label
              key={id}
              className="flex cursor-pointer items-center gap-1 rounded px-1 py-1 pl-5 text-xs text-muted-foreground hover:bg-accent"
            >
              <input
                type="checkbox"
                checked={false}
                onChange={() => toggle(id)}
                className="size-3 shrink-0 cursor-pointer accent-primary"
              />
              <span className="truncate">{labelOf(id)}</span>
            </label>
          ))}
        </>
      )}
    </ViewPopover>
  );
}

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

function GroupPanel<T>({
  defs,
  config,
  onChange,
}: {
  defs: PropertyDef<T>[];
  config: ViewConfig;
  onChange: (config: ViewConfig) => void;
}) {
  const groupable = defs.filter((def) => def.groupable);

  return (
    <ViewPopover icon={Layers} label="Group" active={!!config.groupBy} width="w-64">
      <PanelHeading>Group by</PanelHeading>
      <MiniSelect
        ariaLabel="Group by"
        className="w-full"
        placeholder="No grouping"
        value={config.groupBy ?? ""}
        onChange={(value) =>
          onChange({ ...config, groupBy: value === "" ? undefined : value })
        }
        options={groupable.map((def) => ({ value: def.id, label: def.label }))}
      />

      {config.groupBy && (
        <>
          <PanelHeading>Order groups</PanelHeading>
          <MiniSelect
            ariaLabel="Group order"
            className="w-full"
            value={config.groupSort ?? "asc"}
            onChange={(value) =>
              onChange({ ...config, groupSort: value as GroupSort })
            }
            options={[
              { value: "asc", label: "A → Z" },
              { value: "desc", label: "Z → A" },
              { value: "count", label: "Most rows first" },
            ]}
          />
          <label className="mt-2 flex cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-accent">
            <input
              type="checkbox"
              checked={config.hideEmptyGroups !== false}
              onChange={(event) =>
                onChange({ ...config, hideEmptyGroups: event.target.checked })
              }
              className="size-3 cursor-pointer accent-primary"
            />
            Hide empty groups
          </label>
        </>
      )}
    </ViewPopover>
  );
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

function FilterPanel<T>({
  defs,
  config,
  onChange,
  rows,
}: {
  defs: PropertyDef<T>[];
  config: ViewConfig;
  onChange: (config: ViewConfig) => void;
  rows: T[];
}) {
  const filterable = defs.filter((def) => def.filterable);

  function update(index: number, next: FilterCondition) {
    const filters = [...config.filters];
    filters[index] = next;
    onChange({ ...config, filters });
  }

  function remove(index: number) {
    onChange({
      ...config,
      filters: config.filters.filter((_, i) => i !== index),
    });
  }

  function add() {
    const def = filterable[0];
    if (!def) return;
    onChange({
      ...config,
      filters: [
        ...config.filters,
        { property: def.id, operator: OPERATORS_BY_KIND[def.kind][0] },
      ],
    });
  }

  return (
    <ViewPopover
      icon={Filter}
      label="Filter"
      active={config.filters.length > 0}
      width="w-80"
    >
      {config.filters.length === 0 ? (
        <p className="px-1 py-1 text-xs text-muted-foreground">
          No filters. Everything is shown.
        </p>
      ) : (
        config.filters.map((condition, index) => {
          const def = filterable.find((d) => d.id === condition.property);
          return (
            <div key={index} className="mb-1.5 rounded border p-1.5">
              <div className="flex items-center gap-1">
                <span className="w-8 shrink-0 text-2xs uppercase text-muted-foreground">
                  {index === 0 ? "Where" : "And"}
                </span>
                <MiniSelect
                  ariaLabel="Filter property"
                  className="min-w-0 flex-1"
                  value={condition.property}
                  onChange={(property) => {
                    const next = filterable.find((d) => d.id === property);
                    if (!next) return;
                    // The old operator may not exist for the new kind, so the
                    // condition resets rather than becoming unreadable.
                    update(index, {
                      property,
                      operator: OPERATORS_BY_KIND[next.kind][0],
                    });
                  }}
                  options={filterable.map((d) => ({ value: d.id, label: d.label }))}
                />
                <button
                  type="button"
                  onClick={() => remove(index)}
                  aria-label="Remove filter"
                  className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </div>
              {def && (
                <div className="mt-1 flex items-center gap-1 pl-9">
                  <MiniSelect
                    ariaLabel="Filter operator"
                    className="shrink-0"
                    value={condition.operator}
                    onChange={(operator) =>
                      update(index, {
                        property: condition.property,
                        operator: operator as FilterOperator,
                      })
                    }
                    options={OPERATORS_BY_KIND[def.kind].map((operator) => ({
                      value: operator,
                      label: OPERATOR_LABELS[operator],
                    }))}
                  />
                  <FilterValueEditor
                    def={def}
                    rows={rows}
                    condition={condition}
                    onChange={(next) => update(index, next)}
                  />
                </div>
              )}
            </div>
          );
        })
      )}
      <button
        type="button"
        onClick={add}
        className="mt-1 flex w-full items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Plus className="size-3" /> Add filter
      </button>
    </ViewPopover>
  );
}

function FilterValueEditor<T>({
  def,
  rows,
  condition,
  onChange,
}: {
  def: PropertyDef<T>;
  rows: T[];
  condition: FilterCondition;
  onChange: (next: FilterCondition) => void;
}) {
  const arity = operatorArity(condition.operator);
  if (arity === "none") return null;

  const options: PropertyOption[] = def.options?.(rows) ?? [];

  if (arity === "many") {
    const chosen = condition.values ?? [];
    if (options.length === 0) {
      return (
        <input
          type="text"
          aria-label="Filter values"
          placeholder="a, b, c"
          value={chosen.join(", ")}
          onChange={(event) =>
            onChange({
              ...condition,
              values: event.target.value
                .split(",")
                .map((part) => part.trim())
                .filter(Boolean),
            })
          }
          className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
      );
    }
    return (
      <div className="flex min-w-0 flex-1 flex-wrap gap-1">
        {options.map((option) => {
          const on = chosen.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              onClick={() =>
                onChange({
                  ...condition,
                  values: on
                    ? chosen.filter((v) => v !== option.value)
                    : [...chosen, option.value],
                })
              }
              className={cn(
                "rounded-full border px-1.5 py-0.5 text-2xs transition-colors",
                on
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "bg-background text-muted-foreground hover:bg-accent"
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (options.length > 0 && (def.kind === "select" || def.kind === "boolean")) {
    return (
      <MiniSelect
        ariaLabel="Filter value"
        className="min-w-0 flex-1"
        placeholder="Choose…"
        value={condition.value ?? ""}
        onChange={(value) => onChange({ ...condition, value })}
        options={options}
      />
    );
  }

  return (
    <input
      type={def.kind === "number" ? "number" : "text"}
      aria-label="Filter value"
      // Dates are ISO prefixes of any precision, so a date picker would force
      // a day onto a filter the user meant as a whole year.
      placeholder={def.kind === "date" ? "YYYY or YYYY-MM-DD" : "Value"}
      value={condition.value ?? ""}
      onChange={(event) => onChange({ ...condition, value: event.target.value })}
      className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
    />
  );
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

function SortPanel<T>({
  defs,
  config,
  onChange,
}: {
  defs: PropertyDef<T>[];
  config: ViewConfig;
  onChange: (config: ViewConfig) => void;
}) {
  const sortable = defs.filter((def) => def.sortable);

  return (
    <ViewPopover
      icon={ArrowUpDown}
      label="Sort"
      active={config.sorts.length > 0}
      width="w-72"
    >
      {config.sorts.length === 0 ? (
        <p className="px-1 py-1 text-xs text-muted-foreground">
          No sort — rows appear in the order they arrive.
        </p>
      ) : (
        config.sorts.map((sort, index) => (
          <div key={index} className="mb-1 flex items-center gap-1">
            <span className="w-8 shrink-0 text-2xs uppercase text-muted-foreground">
              {index === 0 ? "By" : "Then"}
            </span>
            <MiniSelect
              ariaLabel="Sort property"
              className="min-w-0 flex-1"
              value={sort.property}
              onChange={(property) => {
                const sorts = [...config.sorts];
                sorts[index] = { ...sort, property };
                onChange({ ...config, sorts });
              }}
              options={sortable.map((def) => ({ value: def.id, label: def.label }))}
            />
            <MiniSelect
              ariaLabel="Sort direction"
              className="shrink-0"
              value={sort.direction}
              onChange={(direction) => {
                const sorts = [...config.sorts];
                sorts[index] = { ...sort, direction: direction as "asc" | "desc" };
                onChange({ ...config, sorts });
              }}
              options={[
                { value: "asc", label: "Asc" },
                { value: "desc", label: "Desc" },
              ]}
            />
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...config,
                  sorts: config.sorts.filter((_, i) => i !== index),
                })
              }
              aria-label="Remove sort"
              className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        ))
      )}
      <button
        type="button"
        onClick={() => {
          const used = new Set(config.sorts.map((sort) => sort.property));
          const next = sortable.find((def) => !used.has(def.id)) ?? sortable[0];
          if (!next) return;
          onChange({
            ...config,
            sorts: [...config.sorts, { property: next.id, direction: "asc" }],
          });
        }}
        className="mt-1 flex w-full items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Plus className="size-3" /> Add sort
      </button>
      <p className="px-1 pt-1 text-2xs text-muted-foreground">
        Rows with no value always sort last.
      </p>
    </ViewPopover>
  );
}

// ---------------------------------------------------------------------------
// Search — moved out of HomePage so both lists share one implementation
// ---------------------------------------------------------------------------

export function ToolbarSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);

  return (
    <div
      className={cn(
        "relative flex h-7 items-center rounded-md transition-colors",
        value && "bg-accent"
      )}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setExpanded(false);
        }
      }}
    >
      <button
        type="button"
        aria-label="Search this view"
        aria-expanded={expanded}
        title="Search"
        onClick={() => setExpanded((current) => !current)}
        // Same rule as the view controls: an active search colours its icon.
        className={cn(
          "relative grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-accent",
          value
            ? "text-active hover:text-active"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Search className="size-3.5" />
      </button>
      {expanded && (
        <input
          ref={inputRef}
          type="search"
          aria-label="Search this view input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Search"
          className="absolute right-0 top-full z-30 mt-1 h-9 w-44 rounded-lg border bg-popover px-3 text-xs text-popover-foreground shadow-md outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
        />
      )}
    </div>
  );
}

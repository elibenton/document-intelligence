import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * A collapsible group header, generalized from the Entities list's
 * type-groups so both lists can group by anything.
 *
 * Collapse state is local and deliberately not persisted: it's a "let me see
 * past this for a second" gesture, and restoring yesterday's collapsed groups
 * on load would hide rows the user has no memory of hiding.
 */
export function ListGroup({
  label,
  count,
  defaultOpen,
  forceOpen,
  onToggle,
  children,
  footer,
}: {
  label: string;
  count: number;
  defaultOpen?: boolean;
  /** Filtering narrows the list to what you asked for — don't also hide it. */
  forceOpen?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
  /** Rendered under a collapsed group — the starred-entity peek. */
  footer?: ReactNode;
}) {
  // `defaultOpen` used to be passed straight into the controlled `open`
  // attribute, so a group that started open could never be closed. Hold the
  // state here and let `forceOpen` override it.
  const [open, setOpen] = useState(defaultOpen ?? false);

  // Native <details> stays, rather than Base UI's Collapsible: Chrome expands
  // a closed <details> to reveal a find-in-page match, and a div-based panel
  // does not unless it carries hidden="until-found". Worth more than the
  // consistency.
  return (
    <div>
      <details
        className="group"
        open={forceOpen || open}
        onToggle={(event) => {
          setOpen(event.currentTarget.open);
          onToggle?.(event.currentTarget.open);
        }}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between rounded-md px-1 py-1.5 -mx-1 transition-colors hover:bg-accent/50 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
            <span className="truncate">{label}</span>
          </span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
        </summary>
        <div className="flex flex-col pl-4">{children}</div>
      </details>
      {footer}
    </div>
  );
}

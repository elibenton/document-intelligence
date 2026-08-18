import { cn } from "@/lib/utils";

/**
 * Thin progress bar. Pass a 0-100 `value` for determinate progress;
 * omit it for an indeterminate sliding bar.
 */
function Progress({
  value,
  className,
}: {
  value?: number | null;
  className?: string;
}) {
  const indeterminate = value == null;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
      className={cn(
        "relative h-1.5 w-full overflow-hidden rounded-full bg-muted",
        className
      )}
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-300 ease-out",
          indeterminate && "progress-indeterminate absolute w-2/5"
        )}
        style={indeterminate ? undefined : { width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export { Progress };

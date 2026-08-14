import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The app had eight distinct ways of reporting an async result and no toast at
 * all: a local `saving` boolean with the rejection swallowed, an inline error
 * string, a `console.error` the user never sees, a dismissible banner, and
 * several fire-and-forget mutations with no feedback whatsoever.
 *
 * Errors do not auto-dismiss. A message that disappears before it is read is
 * the same as no message, and the previous upload-error cards timed out after
 * eight seconds.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <ToastPrimitive.Provider timeout={5000}>
      {children}
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-[100] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 outline-none">
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((toast) => (
    <ToastPrimitive.Root
      key={toast.id}
      toast={toast}
      className={cn(
        "flex items-start gap-3 rounded-lg border bg-popover px-3.5 py-3 text-sm text-popover-foreground shadow-lg",
        "transition-[opacity,transform] duration-200",
        "data-starting-style:translate-x-4 data-starting-style:opacity-0",
        "data-ending-style:translate-x-4 data-ending-style:opacity-0",
        toast.type === "error" && "border-destructive/40",
        toast.type === "success" && "border-success/40"
      )}
    >
      <div className="min-w-0 flex-1">
        <ToastPrimitive.Title className="font-medium" />
        <ToastPrimitive.Description className="mt-0.5 text-muted-foreground" />
      </div>
      <ToastPrimitive.Close
        aria-label="Dismiss"
        className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  ));
}


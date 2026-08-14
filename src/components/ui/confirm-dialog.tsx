import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmContext, type ConfirmOptions } from "@/components/ui/use-confirm";
import { cn } from "@/lib/utils";

/**
 * Replaces five `window.confirm` calls.
 *
 * Native prompts were never a styling complaint: they sit outside the app's
 * focus model, return focus nowhere on dismiss, and can't say what the action
 * costs. One of the five gated a *billable* retranslation behind "OK/Cancel".
 *
 * The hook keeps the imperative `if (await confirm(...))` shape the call sites
 * already had, so the swap doesn't restructure their control flow.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmOptions) => {
    setOptions(next);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOpen(false);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog.Root
        open={open}
        onOpenChange={(next) => {
          // Escape and outside-press both land here; treat either as "no".
          if (!next) settle(false);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0" />
          <AlertDialog.Popup
            className={cn(
              "fixed left-1/2 top-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2",
              "rounded-xl border bg-popover p-5 text-popover-foreground shadow-lg outline-none",
              "transition-[opacity,transform] duration-150",
              "data-starting-style:scale-96 data-starting-style:opacity-0",
              "data-ending-style:scale-96 data-ending-style:opacity-0"
            )}
          >
            <AlertDialog.Title className="text-base font-semibold">
              {options?.title}
            </AlertDialog.Title>
            {options?.body && (
              <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
                {options.body}
              </AlertDialog.Description>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => settle(false)}>
                Cancel
              </Button>
              <Button
                variant={options?.tone === "destructive" ? "destructive" : "default"}
                size="sm"
                onClick={() => settle(true)}
              >
                {options?.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ConfirmContext.Provider>
  );
}


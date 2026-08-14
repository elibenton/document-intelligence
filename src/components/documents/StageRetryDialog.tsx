import { createContext, useContext, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

/**
 * A retry always shows what it is about to send, and lets the user change it.
 *
 * Re-running Analyze or Extract with byte-identical input is close to a no-op —
 * Interfaze's semantic cache will hand back the same answer — so the reason to
 * retry is almost always to steer the run differently. The dialog makes that
 * the default gesture rather than a hidden option.
 *
 * This used to hand-roll the modal: `createPortal`, a `window` keydown listener
 * for Escape, `role="dialog" aria-modal`, and a one-shot
 * `querySelector("textarea, input").focus()`. It had no focus trap, never
 * returned focus to the trigger, and its window-level Escape closed every open
 * dialog at once — pressing Escape over the viewer dismissed the selection
 * popover along with it. `ui/dialog.tsx` already wrapped Base UI and gives all
 * of that for free.
 */
function Modal({
  title,
  description,
  onClose,
  children,
  footer,
}: {
  title: string;
  description: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  // The prompt textarea is the point of the dialog, so focus starts there
  // rather than on the first tabbable node.
  const initialFocusRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        initialFocus={initialFocusRef}
        className="max-h-[85vh] gap-3 overflow-y-auto p-4"
      >
        <div>
          <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
          <DialogDescription className="mt-0.5 text-xs">
            {description}
          </DialogDescription>
        </div>
        <ModalFocusContext.Provider value={initialFocusRef}>
          {children}
        </ModalFocusContext.Provider>
        <div className="flex justify-end gap-2">{footer}</div>
      </DialogContent>
    </Dialog>
  );
}

/** Lets each dialog body hand its prompt field to the modal's initial focus. */
const ModalFocusContext = createContext<React.RefObject<
  HTMLTextAreaElement | HTMLInputElement | null
> | null>(null);

function useModalFocusRef() {
  return useContext(ModalFocusContext);
}

/** Retry Analyze with an editable prompt. */
export function AnalyzeRetryDialog({
  defaultPrompt,
  onClose,
  onRun,
}: {
  defaultPrompt: string;
  onClose: () => void;
  onRun: (prompt: string) => Promise<void>;
}) {
  const focusRef = useModalFocusRef();
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unchanged = prompt.trim() === defaultPrompt.trim();

  async function run() {
    setRunning(true);
    setError(null);
    try {
      await onRun(prompt.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  }

  return (
    <Modal
      title="Re-run Analyze"
      description="Analyze reads the stored scan — the document is not scanned again."
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="outline" onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button size="sm" onClick={run} disabled={running || !prompt.trim()}>
            {running ? (
              <span className="flex items-center gap-1.5">
                <Spinner className="size-3.5" />
                Queueing…
              </span>
            ) : (
              "Run Analyze"
            )}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="analyze-prompt" className="text-xs font-medium text-muted-foreground">
          Prompt
        </label>
        <Textarea
          id="analyze-prompt"
          ref={focusRef as React.RefObject<HTMLTextAreaElement>}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          className="text-xs"
        />
        {unchanged && (
          <p className="text-2xs text-muted-foreground">
            Unchanged — this will re-run from cache. Edit the prompt to steer it
            differently.
          </p>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </Modal>
  );
}

/** Retry Extract with an editable template. */

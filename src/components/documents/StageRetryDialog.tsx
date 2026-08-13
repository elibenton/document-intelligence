import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export interface TemplateRole {
  role: string;
  question: string;
  entityType: string;
}

const ENTITY_TYPES = ["person", "organization", "place", "other"];

/**
 * A retry always shows what it is about to send, and lets the user change it.
 *
 * Re-running Analyze or Extract with byte-identical input is close to a no-op —
 * Interfaze's semantic cache will hand back the same answer — so the reason to
 * retry is almost always to steer the run differently. The dialog makes that
 * the default gesture rather than a hidden option.
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
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    panelRef.current?.querySelector<HTMLElement>("textarea, input")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg rounded-lg border bg-card p-4 shadow-lg flex flex-col gap-3 max-h-[85vh] overflow-y-auto"
      >
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        {children}
        <div className="flex justify-end gap-2">{footer}</div>
      </div>
    </div>,
    document.body
  );
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
                <Spinner className="h-3.5 w-3.5" />
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
        <textarea
          id="analyze-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          className="text-xs rounded-md border bg-background p-2 leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {unchanged && (
          <p className="text-[11px] text-muted-foreground">
            Unchanged — this will re-run from cache. Edit the prompt to steer it
            differently.
          </p>
        )}
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Modal>
  );
}

/** Retry Extract with an editable template. */
export function ExtractRetryDialog({
  defaultRoles,
  onClose,
  onRun,
}: {
  defaultRoles: TemplateRole[];
  onClose: () => void;
  onRun: (roles: TemplateRole[]) => Promise<void>;
}) {
  const [roles, setRoles] = useState<TemplateRole[]>(
    defaultRoles.length > 0
      ? defaultRoles.map((r) => ({ ...r }))
      : [
          {
            role: "person",
            question: "Who are the individual people named in this document?",
            entityType: "person",
          },
        ]
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clean = roles.filter((r) => r.role.trim() && r.question.trim());

  function updateRole(index: number, patch: Partial<TemplateRole>) {
    setRoles((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function run() {
    if (clean.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      await onRun(clean);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  }

  return (
    <Modal
      title="Re-run Extract"
      description="Edit what to look for, then run extraction again over this document."
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="outline" onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button size="sm" onClick={run} disabled={running || clean.length === 0}>
            {running ? (
              <span className="flex items-center gap-1.5">
                <Spinner className="h-3.5 w-3.5" />
                Queueing…
              </span>
            ) : (
              "Run Extract"
            )}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Entities to extract
        </span>
        {roles.map((r, i) => (
          <div key={i} className="flex flex-col gap-1 rounded-md border p-2">
            <div className="flex gap-1.5">
              <Input
                value={r.role}
                aria-label={`Role ${i + 1}`}
                placeholder="role (e.g. witness)"
                onChange={(e) => updateRole(i, { role: e.target.value.toLowerCase() })}
                className="text-xs h-7 flex-1"
              />
              <select
                value={r.entityType}
                aria-label={`Entity type for role ${i + 1}`}
                onChange={(e) => updateRole(i, { entityType: e.target.value })}
                className="text-xs h-7 border rounded-md bg-background px-1"
              >
                {ENTITY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={`Remove role ${i + 1}`}
                onClick={() => setRoles((prev) => prev.filter((_, j) => j !== i))}
                className="text-muted-foreground hover:text-destructive text-xs px-1"
              >
                ✕
              </button>
            </div>
            <Input
              value={r.question}
              aria-label={`Question for role ${i + 1}`}
              placeholder="Question to ask (e.g. Who testified as a witness?)"
              onChange={(e) => updateRole(i, { question: e.target.value })}
              className="text-xs h-7"
            />
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            setRoles((prev) => [
              ...prev,
              { role: "", question: "", entityType: "person" },
            ])
          }
          className="text-xs text-muted-foreground hover:text-foreground text-left"
        >
          + Add role
        </button>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Modal>
  );
}

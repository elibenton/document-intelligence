import { useEffect, useMemo, useState } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

interface TemplateRole {
  role: string;
  question: string;
  entityType: string;
}

const ENTITY_TYPES = ["person", "organization", "place", "other"];

/**
 * Upload review panel: the AI metadata pass guesses the document kind and
 * pre-fills that kind's extraction template. The user edits the roles and
 * questions, optionally saves them back to the kind, and confirms to run
 * the entity extraction.
 */
export function ExtractionSetup({
  document,
  onDone,
}: {
  document: Doc<"documents">;
  onDone?: () => void;
}) {
  const documentId = document._id as Id<"documents">;
  const kinds = useQuery(api.kinds.list);
  const runTemplateExtraction = useAction(api.processing.runTemplateExtraction);
  const updateDocumentMeta = useMutation(api.metadata.updateDocumentMeta);

  const [kind, setKind] = useState<string>(document.primaryKind ?? "");
  const [kindTouched, setKindTouched] = useState(false);
  const [roles, setRoles] = useState<TemplateRole[]>([]);
  const [rolesTouched, setRolesTouched] = useState(false);
  const [saveTemplate, setSaveTemplate] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kindByName = useMemo(() => {
    const map = new Map<string, Doc<"documentKinds">>();
    for (const k of kinds ?? []) map.set(k.name, k);
    return map;
  }, [kinds]);

  // The metadata pass may finish after mount: adopt the AI's kind guess and
  // its template until the user has touched either field.
  useEffect(() => {
    if (!kindTouched && document.primaryKind && document.primaryKind !== kind) {
      setKind(document.primaryKind);
    }
  }, [document.primaryKind, kindTouched, kind]);

  useEffect(() => {
    if (rolesTouched) return;
    // The understanding result belongs to this source and is more specific
    // than a shared kind template. This matters especially for CSV datasets:
    // a generic "report" template from an unrelated upload must never replace
    // the columns and subject Interfaze just analyzed.
    if (document.suggestedRoles && document.suggestedRoles.length > 0) {
      setRoles(document.suggestedRoles.map((role) => ({ ...role })));
      return;
    }
    const template = kindByName.get(kind)?.templateRoles;
    if (template && template.length > 0) {
      setRoles(template.map((r) => ({ ...r })));
    } else if (roles.length === 0) {
      setRoles([
        {
          role: "person",
          question: "Who are the individual people named in this document?",
          entityType: "person",
        },
      ]);
    }
  }, [document.suggestedRoles, kind, kindByName, rolesTouched, roles.length]);

  const metadataPending =
    !document.primaryKind && document.status !== "failed";

  function updateRole(index: number, patch: Partial<TemplateRole>) {
    setRolesTouched(true);
    setRoles((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...patch } : r))
    );
  }

  async function handleRun() {
    const cleanRoles = roles.filter((r) => r.role.trim() && r.question.trim());
    if (cleanRoles.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      if (kind.trim() && kind.trim().toLowerCase() !== document.primaryKind) {
        await updateDocumentMeta({
          documentId,
          primaryKind: kind.trim(),
        });
      }
      await runTemplateExtraction({
        documentId,
        roles: cleanRoles,
        saveToKind: saveTemplate && kind.trim() ? kind.trim() : undefined,
      });
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-3 flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">Review extraction</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {metadataPending
            ? "Guessing document kind…"
            : "Confirm what to look for, then run extraction."}
        </p>
      </div>

      {/* Kind */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">
          Document kind
        </label>
        <Input
          list="document-kinds"
          value={kind}
          placeholder={metadataPending ? "detecting…" : "e.g. legal brief"}
          onChange={(e) => {
            setKindTouched(true);
            setRolesTouched(false); // adopt the new kind's template
            setKind(e.target.value.toLowerCase());
          }}
          className="text-xs h-8"
        />
        <datalist id="document-kinds">
          {(kinds ?? []).map((k) => (
            <option key={k._id} value={k.name} />
          ))}
        </datalist>
      </div>

      {/* Template roles */}
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium text-muted-foreground">
          Entities to extract
        </label>
        {roles.map((r, i) => (
          <div key={i} className="flex flex-col gap-1 rounded-md border p-2">
            <div className="flex gap-1.5">
              <Input
                value={r.role}
                placeholder="role (e.g. witness)"
                onChange={(e) =>
                  updateRole(i, { role: e.target.value.toLowerCase() })
                }
                className="text-xs h-7 flex-1"
              />
              <select
                value={r.entityType}
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
                onClick={() => {
                  setRolesTouched(true);
                  setRoles((prev) => prev.filter((_, j) => j !== i));
                }}
                className="text-muted-foreground hover:text-destructive text-xs px-1"
                title="Remove"
              >
                ✕
              </button>
            </div>
            <Input
              value={r.question}
              placeholder="Question to ask (e.g. Who testified as a witness?)"
              onChange={(e) => updateRole(i, { question: e.target.value })}
              className="text-xs h-7"
            />
          </div>
        ))}
        <button
          onClick={() => {
            setRolesTouched(true);
            setRoles((prev) => [
              ...prev,
              { role: "", question: "", entityType: "person" },
            ]);
          }}
          className="text-xs text-muted-foreground hover:text-foreground text-left"
        >
          + Add role
        </button>
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={saveTemplate}
          onChange={(e) => setSaveTemplate(e.target.checked)}
        />
        Save as default template for “{kind || "this kind"}”
      </label>

      {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}

      <Button
        size="sm"
        onClick={handleRun}
        disabled={running || roles.every((r) => !r.role.trim())}
      >
        {running ? (
          <span className="flex items-center gap-1.5">
            <Spinner className="h-3.5 w-3.5" />
            Extracting…
          </span>
        ) : (
          "Run extraction"
        )}
      </Button>
    </div>
  );
}

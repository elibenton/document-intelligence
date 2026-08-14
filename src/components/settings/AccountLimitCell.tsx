import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The operator's half of "get in touch and I'll raise your limit".
 *
 * Editable in place rather than behind a dialog: answering that request is a
 * single number, and the row already shows the spend that justifies it.
 *
 * Deliberately has no confirmation step. Lowering a limit does not destroy
 * anything — it pauses new work, and raising it again undoes that — so the
 * usual guard against an irreversible click has nothing to protect here.
 */
export function AccountLimitCell({
  userId,
  limitUsd,
}: {
  userId: string;
  limitUsd: number;
}) {
  const setLimit = useMutation(api.budget.setLimit);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // `null` means "not editing", so the cell follows the server value until the
  // operator actually types — otherwise a raise made in another tab would be
  // masked by a stale local copy.
  const value = draft ?? limitUsd.toFixed(2);
  const parsed = Number(value);
  const valid = Number.isFinite(parsed) && parsed >= 0;

  const save = async () => {
    if (!valid || parsed === limitUsd) {
      setDraft(null);
      return;
    }
    setSaving(true);
    try {
      await setLimit({ userId, limitUsd: parsed });
      setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center justify-end gap-1.5">
      <span aria-hidden className="text-muted-foreground">
        $
      </span>
      <Input
        aria-label="Spending limit in dollars"
        inputMode="decimal"
        className="h-7 w-20 text-right tabular-nums"
        value={value}
        disabled={saving}
        aria-invalid={!valid || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setDraft(null);
        }}
        onBlur={() => void save()}
      />
      {draft !== null && valid && parsed !== limitUsd && (
        <Button size="sm" variant="secondary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      )}
    </div>
  );
}

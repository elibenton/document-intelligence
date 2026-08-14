import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  DEFAULT_CITATION_STYLE,
  type CitationStyle,
} from "../../../convex/projectTemplates";
import { CitationStylePicker } from "@/components/projects/projectVocabulary";

/**
 * How this project's search answers cite the documents they quote.
 *
 * Saved on click rather than behind a Save button: it is one value with four
 * options and no destructive consequence — unlike the app-wide default
 * language, which re-translates the archive and therefore asks first.
 *
 * Changing this costs nothing and re-runs nothing. Answers are stored with
 * plain `[n]` markers and formatted at render time, so switching style
 * re-renders every existing answer in the new one.
 */
export function CitationStyleSettings({
  projectId,
  citationStyle,
}: {
  projectId: Id<"projects">;
  citationStyle?: string;
}) {
  const update = useMutation(api.projects.update);
  const [saving, setSaving] = useState(false);

  const current = (citationStyle ?? DEFAULT_CITATION_STYLE) as CitationStyle;

  async function choose(style: CitationStyle) {
    if (style === current || saving) return;
    setSaving(true);
    try {
      await update({ id: projectId, citationStyle: style });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-8 rounded-lg border bg-card p-4">
      <CitationStylePicker
        value={current}
        disabled={saving}
        onChange={(style) => void choose(style)}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        Applied when an answer is displayed, not when it is written — changing
        this re-formats answers you already have.
      </p>
    </div>
  );
}

import { useCallback, useState } from "react";
import type { Id } from "../../../convex/_generated/dataModel";
import SearchBar from "./SearchBar";
import { useSearchHotkey } from "./useSearchHotkey";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/**
 * The project's universal search bar, summoned over whatever page the user is
 * on. Pages that already show the bar (the project home, the search page)
 * don't mount this — they pass the hotkey a focus signal instead, so ⌘K walks
 * the user to the bar in front of them rather than stacking a copy on top of
 * it.
 *
 * Escape and click-outside dismissal come from the dialog primitive; ⌘K
 * toggles.
 */
export function ProjectSearchDialog({
  projectId,
}: {
  projectId: Id<"projects">;
}) {
  const [open, setOpen] = useState(false);
  useSearchHotkey(useCallback(() => setOpen((v) => !v), []));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        // No surface of its own: the search bar and its dropdown bring their
        // own card, the same one the project home page shows.
        className="top-[14vh] w-[calc(100%-2rem)] max-w-2xl translate-y-0 gap-0 border-none bg-transparent p-0 shadow-none"
        // The bar focuses itself via focusSignal; leaving the popup out of it
        // avoids a focus handoff that would drop the caret.
        initialFocus={false}
      >
        <DialogTitle className="sr-only">Search this project</DialogTitle>
        <SearchBar
          projectId={projectId}
          focusSignal={open ? 1 : 0}
          onNavigate={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

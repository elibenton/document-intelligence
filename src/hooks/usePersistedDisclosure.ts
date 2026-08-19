import { useCallback, useState } from "react";

/**
 * Caret state that survives reload: any chevron that opens or closes a
 * section keeps the user's last choice in localStorage, so a menu the user
 * closed is never reopened on them (and one they opened stays open).
 *
 * Every accessor is guarded — Safari in private mode throws on localStorage
 * rather than returning null, and a caret that cannot be *remembered* should
 * still be one that can be *toggled*.
 */
const PREFIX = "haystack:disclosure:";

export function readDisclosure(key: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? null : raw === "1";
  } catch {
    return null;
  }
}

export function writeDisclosure(key: string, open: boolean): void {
  try {
    window.localStorage.setItem(PREFIX + key, open ? "1" : "0");
  } catch {
    // Non-fatal: the choice lasts for this page's lifetime.
  }
}

export function usePersistedDisclosure(key: string, defaultOpen: boolean) {
  const [open, setOpen] = useState(() => readDisclosure(key) ?? defaultOpen);
  const set = useCallback(
    (next: boolean) => {
      setOpen(next);
      writeDisclosure(key, next);
    },
    [key]
  );
  return [open, set] as const;
}

/**
 * A persisted set of string ids — for lists where every row carries its own
 * caret (collapsed entity groups, expanded connection lists). The updater is
 * functional-only, mirroring how every call site already used setState.
 */
export function usePersistedStringSet(key: string) {
  const [value, setValue] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(PREFIX + key);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
    } catch {
      return new Set<string>();
    }
  });
  const update = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => {
      setValue((prev) => {
        const next = updater(prev);
        try {
          window.localStorage.setItem(PREFIX + key, JSON.stringify([...next]));
        } catch {
          // Non-fatal, as above.
        }
        return next;
      });
    },
    [key]
  );
  return [value, update] as const;
}

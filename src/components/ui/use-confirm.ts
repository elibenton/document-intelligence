import { createContext, useContext } from "react";
import type { ReactNode } from "react";

/**
 * Split out of `confirm-dialog.tsx` for the same reason `button-variants.ts` is
 * split out of `button.tsx`: a module that exports both a component and a
 * value breaks Fast Refresh for the whole file.
 */
export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  tone?: "default" | "destructive";
};

export const ConfirmContext = createContext<
  ((options: ConfirmOptions) => Promise<boolean>) | null
>(null);

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used inside ConfirmProvider");
  return confirm;
}

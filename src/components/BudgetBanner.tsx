import { useQuery } from "convex/react";
import { Wallet } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { buttonVariants } from "@/components/ui/button-variants";
import { SUPPORT_EMAIL } from "@/lib/support";

/**
 * Shown once an account has spent its allowance.
 *
 * A banner rather than an error toast on the failed action, because the state
 * is persistent rather than momentary: every upload, search and retry will
 * refuse until the limit is raised, and discovering that one rejection at a
 * time is a bad way to learn it. The server refuses regardless — this exists so
 * the refusal is explained before it is hit.
 */
export function BudgetBanner() {
  const budget = useQuery(api.budget.mine);
  if (!budget?.exhausted) return null;

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 border-b border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/60"
    >
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        <Wallet className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
            You've used your ${budget.limitUsd.toFixed(2)} of processing
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
            Uploads, searches and retries are paused. Documents already
            processed stay readable, and anything mid-flight will finish. Get in
            touch and I'll raise your limit.
          </p>
        </div>
        <a
          href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
            "Haystack — request more processing"
          )}`}
          className={`${buttonVariants({ size: "sm" })} shrink-0`}
        >
          Request more
        </a>
      </div>
    </div>
  );
}

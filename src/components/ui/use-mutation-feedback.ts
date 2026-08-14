import { Toast } from "@base-ui/react/toast";

/**
 * Split out of `toast.tsx` so that file only exports components — a mixed
 * module breaks Fast Refresh. Same reason as `button-variants.ts`.
 *
 * `run` reports failures instead of dropping them, and returns whether the
 * call succeeded so a caller can keep its own success path. Errors are given
 * `timeout: 0`: a message that disappears before it is read is the same as no
 * message, and the upload-error cards this replaces expired after eight
 * seconds.
 */
export function useMutationFeedback() {
  const manager = Toast.useToastManager();
  return {
    async run<T>(
      promise: Promise<T>,
      { error, success }: { error: string; success?: string }
    ): Promise<T | undefined> {
      try {
        const result = await promise;
        if (success) manager.add({ title: success, type: "success" });
        return result;
      } catch (cause) {
        manager.add({
          title: error,
          description: cause instanceof Error ? cause.message : undefined,
          type: "error",
          timeout: 0,
        });
        return undefined;
      }
    },
    notify: manager.add,
  };
}

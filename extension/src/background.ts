/**
 * Background service worker: owns the clip lifecycle so it survives the popup
 * closing mid-upload. The popup sends {type: "clip"}; the worker injects the
 * capture script, runs it, POSTs to the Convex endpoint, and broadcasts
 * status updates (also mirrored to the action badge + chrome.storage.session).
 */

interface ClipStatus {
  state: "capturing" | "uploading" | "done" | "error";
  message?: string;
  documentId?: string;
  tabId?: number;
}

interface Settings {
  endpoint: string; // https://<deployment>.convex.site
  apiKey: string;
  appBaseUrl: string;
}

const MAX_BODY_BYTES = 19 * 1024 * 1024; // Convex HTTP actions cap at 20MB

async function getSettings(): Promise<Settings> {
  const sync = await chrome.storage.sync.get(["endpoint", "appBaseUrl"]);
  const local = await chrome.storage.local.get(["apiKey"]);
  return {
    endpoint: (sync.endpoint ?? "").replace(/\/+$/, ""),
    apiKey: local.apiKey ?? "",
    appBaseUrl: (sync.appBaseUrl ?? "http://localhost:5173").replace(/\/+$/, ""),
  };
}

async function setStatus(status: ClipStatus): Promise<void> {
  await chrome.storage.session.set({ clipStatus: status });
  chrome.runtime.sendMessage({ type: "clipStatus", status }).catch(() => {
    /* popup may be closed */
  });
  const badge = {
    capturing: { text: "…", color: "#f59e0b" },
    uploading: { text: "↑", color: "#3b82f6" },
    done: { text: "✓", color: "#22c55e" },
    error: { text: "!", color: "#ef4444" },
  }[status.state];
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  if (status.state === "done" || status.state === "error") {
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 8000);
  }
}

async function capture(
  tabId: number,
  inlineImages: boolean
): Promise<Record<string, unknown>> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["capture.js"],
  });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (opts: { inlineImages: boolean }) =>
      (window as unknown as {
        __haystackCapture: (o: unknown) => Promise<unknown>;
      }).__haystackCapture(opts),
    args: [{ inlineImages }],
  });
  if (!result?.result) throw new Error("Capture returned no result");
  return result.result as Record<string, unknown>;
}

async function runClip(
  tabId: number,
  extras: { title?: string; tags: string[]; notes?: string }
): Promise<void> {
  const settings = await getSettings();
  if (!settings.endpoint || !settings.apiKey) {
    await setStatus({
      state: "error",
      message: "Set the endpoint URL and API key in the extension options first.",
      tabId,
    });
    return;
  }

  try {
    await setStatus({ state: "capturing", tabId });
    let payload = await capture(tabId, true);

    // Oversized archive (Convex caps request bodies at 20MB): retry without
    // inlined images before giving up.
    if (JSON.stringify(payload).length > MAX_BODY_BYTES) {
      payload = await capture(tabId, false);
      if (JSON.stringify(payload).length > MAX_BODY_BYTES) {
        throw new Error("Page too large to clip even without images (>19MB)");
      }
    }

    if (extras.title?.trim()) payload.title = extras.title.trim();
    payload.tags = extras.tags;
    if (extras.notes?.trim()) payload.notes = extras.notes.trim();

    await setStatus({ state: "uploading", tabId });
    const res = await fetch(`${settings.endpoint}/clip`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const hint =
        res.status === 401
          ? " (check the API key in extension options)"
          : res.status === 404
            ? " (check the endpoint URL — it should be your .convex.site URL)"
            : "";
      throw new Error(`Upload failed: HTTP ${res.status}${hint} ${detail.slice(0, 200)}`);
    }

    const { documentId } = (await res.json()) as { documentId: string };
    await setStatus({ state: "done", documentId, tabId });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setStatus({ state: "error", message, tabId });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "clip" && typeof msg.tabId === "number") {
    void runClip(msg.tabId, {
      title: msg.title,
      tags: Array.isArray(msg.tags) ? msg.tags : [],
      notes: msg.notes,
    });
    sendResponse({ started: true });
  }
  return false;
});

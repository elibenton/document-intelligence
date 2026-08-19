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
  /** Metadata the capture extracted, shown as a preview once clipped. */
  meta?: {
    title?: string;
    author?: string;
    siteName?: string;
    publishedAt?: string;
    description?: string;
  };
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

const STATUS_COLORS: Record<ClipStatus["state"], string> = {
  capturing: "#f59e0b",
  uploading: "#3b82f6",
  done: "#22c55e",
  error: "#ef4444",
};

let baseIconBitmap: Promise<ImageBitmap> | undefined;

/** Toolbar icon with a small colored status dot in the bottom-right corner. */
async function setStatusIcon(state: ClipStatus["state"]): Promise<void> {
  baseIconBitmap ??= fetch(chrome.runtime.getURL("icons/128.png"))
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b));
  const icon = await baseIconBitmap;
  const imageData: Record<number, ImageData> = {};
  for (const size of [16, 32]) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(icon, 0, 0, size, size);
    const r = size * 0.22;
    const cx = size - r - 1;
    const cy = size - r - 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
    ctx.fillStyle = "#fff"; // thin ring so the dot reads on any toolbar
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = STATUS_COLORS[state];
    ctx.fill();
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  await chrome.action.setIcon({ imageData });
}

async function setStatus(status: ClipStatus): Promise<void> {
  await chrome.storage.session.set({ clipStatus: status });
  chrome.runtime.sendMessage({ type: "clipStatus", status }).catch(() => {
    /* popup may be closed */
  });
  await setStatusIcon(status.state).catch(() => {
    /* icon decoration is cosmetic; never fail the clip over it */
  });
  if (status.state === "done" || status.state === "error") {
    setTimeout(() => {
      void chrome.action.setIcon({
        path: { 16: "icons/16.png", 32: "icons/32.png" },
      });
    }, 8000);
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
  extras: {
    title?: string;
    projectId?: string;
    force?: boolean;
  }
): Promise<void> {
  const settings = await getSettings();
  if (!settings.endpoint || !settings.apiKey) {
    await setStatus({
      state: "error",
      message: "Not connected — open the extension options and sign in first.",
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
    // Per-clip project from the popup's dropdown; the server falls back to
    // the token's own project when absent.
    if (extras.projectId) payload.projectId = extras.projectId;
    // Past the server's duplicate refusal: the popup warned, the user chose
    // "Clip again".
    if (extras.force) payload.force = true;

    await setStatus({ state: "uploading", tabId });
    const res = await fetch(`${settings.endpoint}/clip`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 409) {
      // Duplicate refused server-side (clipped from another machine, or a
      // race). Surface the existing document so the popup can link to it.
      const dup = (await res.json().catch(() => ({}))) as {
        documentId?: string;
        projectName?: string;
      };
      await setStatus({
        state: "error",
        message: `Already clipped${dup.projectName ? ` into ${dup.projectName}` : ""}. `,
        documentId: dup.documentId,
        tabId,
      });
      return;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const hint =
        res.status === 401
          ? " (token revoked? Reconnect from the extension options)"
          : res.status === 404
            ? " (check the endpoint URL — it should be your .convex.site URL)"
            : "";
      throw new Error(`Upload failed: HTTP ${res.status}${hint} ${detail.slice(0, 200)}`);
    }

    const { documentId } = (await res.json()) as { documentId: string };
    const captured = payload.metadata as
      | Record<string, string | undefined>
      | undefined;
    await setStatus({
      state: "done",
      documentId,
      tabId,
      meta: {
        title: payload.title as string | undefined,
        author: captured?.byline,
        siteName: captured?.siteName,
        publishedAt: captured?.publishedAt,
        description: captured?.description ?? captured?.excerpt,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setStatus({ state: "error", message, tabId });
  }
}

/**
 * Connect handshake: the app's /clipper/connect page (an origin listed in
 * externally_connectable) sends the endpoint + personal token here after the
 * user signs in. Only honored while a connect the user started from the
 * options page is pending, and only from the exact origin they started it
 * against — a stray page on a matched origin can't re-point the clipper.
 */
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "haystack-clipper-connect") return false;
  void (async () => {
    const { connectOrigin } = await chrome.storage.session.get(["connectOrigin"]);
    const senderOrigin = sender.url ? new URL(sender.url).origin : "";
    if (!connectOrigin || senderOrigin !== connectOrigin) {
      sendResponse({
        ok: false,
        error: "No connection in progress — start from the extension options.",
      });
      return;
    }
    const endpoint =
      typeof msg.endpoint === "string" ? msg.endpoint.replace(/\/+$/, "") : "";
    const token = typeof msg.token === "string" ? msg.token : "";
    if (!/^https:\/\/[a-z0-9-]+\.convex\.site$/.test(endpoint) || !token) {
      sendResponse({ ok: false, error: "Malformed connect message." });
      return;
    }
    await chrome.storage.session.remove("connectOrigin");
    await chrome.storage.sync.set({ endpoint, appBaseUrl: senderOrigin });
    await chrome.storage.local.set({ apiKey: token });
    sendResponse({ ok: true });
  })();
  return true; // keep the channel open for the async sendResponse
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "clip" && typeof msg.tabId === "number") {
    void runClip(msg.tabId, {
      title: msg.title,
      projectId: typeof msg.projectId === "string" ? msg.projectId : undefined,
      force: msg.force === true,
    });
    sendResponse({ started: true });
  }
  return false;
});

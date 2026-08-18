/**
 * Options page: one "Sign in & connect" button. It opens the app's
 * /clipper/connect page (behind the app's own sign-in), which hands the
 * endpoint + personal token back to the background worker via
 * externally_connectable messaging — see background.ts. Nothing is pasted.
 */

const DEFAULT_APP_URL = "https://glorious-warbler-976.convex.site";

const appUrlInput = document.getElementById("appUrl") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const connectBtn = document.getElementById("connect") as HTMLButtonElement;
const disconnectBtn = document.getElementById("disconnect") as HTMLButtonElement;

async function render(): Promise<void> {
  const sync = await chrome.storage.sync.get(["endpoint", "appBaseUrl"]);
  const local = await chrome.storage.local.get(["apiKey"]);
  const connected = Boolean(sync.endpoint && local.apiKey);

  if (!appUrlInput.value) {
    appUrlInput.value = (sync.appBaseUrl as string) ?? DEFAULT_APP_URL;
  }
  disconnectBtn.hidden = !connected;
  connectBtn.textContent = connected ? "Reconnect" : "Sign in & connect";
  statusEl.className = connected ? "ok" : "";
  statusEl.innerHTML = "";
  if (connected) {
    statusEl.append("Connected ✓ ");
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = `Clipping to ${sync.endpoint as string}`;
    statusEl.appendChild(detail);
  } else {
    statusEl.textContent = "Not connected.";
  }
}

connectBtn.addEventListener("click", () => {
  void (async () => {
    let origin: string;
    try {
      origin = new URL(appUrlInput.value.trim()).origin;
    } catch {
      statusEl.className = "";
      statusEl.textContent = "That Haystack URL isn't a valid URL.";
      return;
    }
    // The background worker only accepts a connect message from the origin
    // recorded here, and only while a connect the user started is pending.
    await chrome.storage.session.set({ connectOrigin: origin });
    await chrome.tabs.create({
      url: `${origin}/clipper/connect?ext=${chrome.runtime.id}`,
    });
  })();
});

disconnectBtn.addEventListener("click", () => {
  void (async () => {
    await chrome.storage.local.remove("apiKey");
    await chrome.storage.sync.remove("endpoint");
    await render();
  })();
});

chrome.storage.onChanged.addListener(() => void render());

void render();

// Make this file a module so its top-level names don't collide with popup.ts
// in the shared tsconfig program (esbuild bundles each entry separately).
export {};

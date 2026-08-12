const endpointInput = document.getElementById("endpoint") as HTMLInputElement;
const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const appBaseUrlInput = document.getElementById("appBaseUrl") as HTMLInputElement;
const savedEl = document.getElementById("saved") as HTMLSpanElement;

async function load(): Promise<void> {
  const sync = await chrome.storage.sync.get(["endpoint", "appBaseUrl"]);
  const local = await chrome.storage.local.get(["apiKey"]);
  endpointInput.value = (sync.endpoint as string) ?? "";
  appBaseUrlInput.value = (sync.appBaseUrl as string) ?? "http://localhost:5173";
  apiKeyInput.value = (local.apiKey as string) ?? "";
}

document.getElementById("save")!.addEventListener("click", () => {
  void (async () => {
    await chrome.storage.sync.set({
      endpoint: endpointInput.value.trim().replace(/\/+$/, ""),
      appBaseUrl: appBaseUrlInput.value.trim().replace(/\/+$/, ""),
    });
    // The key stays on this machine only
    await chrome.storage.local.set({ apiKey: apiKeyInput.value.trim() });
    savedEl.hidden = false;
    setTimeout(() => (savedEl.hidden = true), 2000);
  })();
});

void load();

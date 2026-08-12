const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const titleInput = $<HTMLInputElement>("title");
const tagsInput = $<HTMLInputElement>("tags");
const notesInput = $<HTMLTextAreaElement>("notes");
const clipButton = $<HTMLButtonElement>("clip");
const statusEl = $<HTMLDivElement>("status");

let activeTabId: number | undefined;

function showStatus(status: {
  state: string;
  message?: string;
  documentId?: string;
}): void {
  statusEl.className = "";
  clipButton.disabled = status.state === "capturing" || status.state === "uploading";
  switch (status.state) {
    case "capturing":
      statusEl.textContent = "Capturing page…";
      break;
    case "uploading":
      statusEl.textContent = "Uploading…";
      break;
    case "done": {
      statusEl.className = "ok";
      statusEl.textContent = "✓ Clipped! ";
      void chrome.storage.sync.get(["appBaseUrl"]).then(({ appBaseUrl }) => {
        const base = ((appBaseUrl as string) ?? "http://localhost:5173").replace(/\/+$/, "");
        const link = document.createElement("a");
        link.href = `${base}/documents/${status.documentId}`;
        link.target = "_blank";
        link.textContent = "Open in Document Intelligence";
        statusEl.appendChild(link);
      });
      break;
    }
    case "error":
      statusEl.className = "error";
      statusEl.textContent = status.message ?? "Something went wrong";
      break;
  }
}

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;

  if (!tab?.url || !/^https?:/.test(tab.url)) {
    clipButton.disabled = true;
    statusEl.className = "error";
    statusEl.textContent = "This page can't be clipped.";
    return;
  }

  titleInput.value = tab.title ?? "";
  $<HTMLDivElement>("pageUrl").textContent = tab.url;
  if (tab.favIconUrl) {
    const fav = $<HTMLImageElement>("favicon");
    fav.src = tab.favIconUrl;
    fav.hidden = false;
  }

  // Resume in-flight/finished status if the popup was reopened
  const { clipStatus } = await chrome.storage.session.get(["clipStatus"]);
  if (clipStatus && clipStatus.tabId === activeTabId) showStatus(clipStatus);
}

clipButton.addEventListener("click", () => {
  if (activeTabId === undefined) return;
  const tags = tagsInput.value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  void chrome.runtime.sendMessage({
    type: "clip",
    tabId: activeTabId,
    title: titleInput.value,
    tags,
    notes: notesInput.value,
  });
  showStatus({ state: "capturing" });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "clipStatus" && msg.status?.tabId === activeTabId) {
    showStatus(msg.status);
  }
});

$<HTMLAnchorElement>("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});

void init();

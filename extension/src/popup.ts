const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const projectSelect = $<HTMLSelectElement>("project");
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
        link.textContent = "Open in Haystack";
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

/**
 * Fill the per-clip project dropdown from GET /clip/projects. Defaults to the
 * last project clipped to (remembered locally), falling back to the token's
 * own project. If the fetch fails the dropdown collapses to one "default"
 * option — the server clips into the token's project when none is sent.
 */
async function loadProjects(): Promise<void> {
  const { endpoint, lastProjectId } = await chrome.storage.sync.get([
    "endpoint",
    "lastProjectId",
  ]);
  const { apiKey } = await chrome.storage.local.get(["apiKey"]);
  if (!endpoint || !apiKey) return; // background reports "not connected"
  try {
    const res = await fetch(`${endpoint as string}/clip/projects`, {
      headers: { Authorization: `Bearer ${apiKey as string}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { defaultProjectId, projects } = (await res.json()) as {
      defaultProjectId: string;
      projects: { id: string; name: string }[];
    };
    projectSelect.replaceChildren(
      ...projects.map(({ id, name }) => new Option(name, id))
    );
    const preferred =
      projects.find((p) => p.id === lastProjectId)?.id ?? defaultProjectId;
    projectSelect.value = preferred;
    projectSelect.disabled = false;
  } catch {
    projectSelect.replaceChildren(new Option("Default project", ""));
    projectSelect.disabled = true;
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
  const projectId = projectSelect.value || undefined;
  if (projectId) {
    void chrome.storage.sync.set({ lastProjectId: projectId });
  }
  void chrome.runtime.sendMessage({
    type: "clip",
    tabId: activeTabId,
    title: titleInput.value,
    tags,
    notes: notesInput.value,
    projectId,
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
void loadProjects();

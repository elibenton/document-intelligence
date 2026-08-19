const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const projectSelect = $<HTMLSelectElement>("project");
const titleInput = $<HTMLInputElement>("title");
const clipButton = $<HTMLButtonElement>("clip");
const statusEl = $<HTMLDivElement>("status");
const reclipWarning = $<HTMLDivElement>("reclipWarning");
const metaPreview = $<HTMLDListElement>("metaPreview");

let activeTabId: number | undefined;
let forceReclip = false;

/** Append an "Open in Haystack" link for a documentId to `parent`. */
function appendOpenLink(
  parent: HTMLElement,
  documentId: string,
  text: string
): void {
  void chrome.storage.sync.get(["appBaseUrl"]).then(({ appBaseUrl }) => {
    const base = ((appBaseUrl as string) ?? "http://localhost:5173").replace(/\/+$/, "");
    const link = document.createElement("a");
    link.href = `${base}/documents/${documentId}`;
    link.target = "_blank";
    link.textContent = text;
    parent.appendChild(link);
  });
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** Preview of the metadata the capture extracted from the page. */
function showMetaPreview(meta: Record<string, string | undefined>): void {
  const rows: [string, string | undefined][] = [
    ["Title", meta.title],
    ["Author", meta.byline],
    ["Site", meta.siteName],
    ["Published", meta.publishedAt],
    ["Summary", meta.description],
  ];
  metaPreview.replaceChildren(
    ...rows
      .filter(([, value]) => value?.trim())
      .flatMap(([label, value]) => {
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value!;
        return [dt, dd];
      })
  );
  metaPreview.hidden = metaPreview.childElementCount === 0;
}

function showStatus(status: {
  state: string;
  message?: string;
  documentId?: string;
  meta?: Record<string, string | undefined>;
}): void {
  statusEl.className = "";
  clipButton.disabled = status.state === "capturing" || status.state === "uploading";
  metaPreview.hidden = true;
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
      if (status.documentId) {
        appendOpenLink(statusEl, status.documentId, "Open in Haystack");
      }
      if (status.meta) showMetaPreview(status.meta);
      break;
    }
    case "error":
      statusEl.className = "error";
      statusEl.textContent = status.message ?? "Something went wrong";
      // A 409 duplicate refusal carries the existing document's id.
      if (status.documentId) {
        appendOpenLink(statusEl, status.documentId, "Open existing");
      }
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

  // Resume in-flight/finished status if the popup was reopened
  const { clipStatus } = await chrome.storage.session.get(["clipStatus"]);
  if (clipStatus && clipStatus.tabId === activeTabId) showStatus(clipStatus);

  void warnIfAlreadyClipped(tab.url);
}

/**
 * Ask the server whether this URL is already clipped into any of the owner's
 * projects. The server refuses duplicates (409) unless `force` is sent, so
 * this both warns and arms the "Clip again" override.
 */
async function warnIfAlreadyClipped(url: string): Promise<void> {
  const { endpoint } = await chrome.storage.sync.get(["endpoint"]);
  const { apiKey } = await chrome.storage.local.get(["apiKey"]);
  if (!endpoint || !apiKey) return;
  try {
    const res = await fetch(
      `${endpoint as string}/clip/lookup?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: `Bearer ${apiKey as string}` } }
    );
    if (!res.ok) return;
    const { existing } = (await res.json()) as {
      existing: {
        documentId: string;
        projectName: string;
        clippedAt: number;
      } | null;
    };
    if (!existing) return;
    forceReclip = true;
    reclipWarning.textContent = `⚠ Already clipped into ${existing.projectName} ${timeAgo(existing.clippedAt)} — clipping again creates a duplicate. `;
    appendOpenLink(reclipWarning, existing.documentId, "Open existing");
    reclipWarning.hidden = false;
    clipButton.textContent = "Clip again";
  } catch {
    /* offline or endpoint unreachable — clip proceeds; the server still refuses duplicates */
  }
}

clipButton.addEventListener("click", () => {
  if (activeTabId === undefined) return;
  const projectId = projectSelect.value || undefined;
  if (projectId) {
    void chrome.storage.sync.set({ lastProjectId: projectId });
  }
  void chrome.runtime.sendMessage({
    type: "clip",
    tabId: activeTabId,
    title: titleInput.value,
    projectId,
    force: forceReclip,
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

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

/** "August 19, 2026 - 1:44 PM"; date-only values omit the time part. */
function formatDateTime(raw: string): string {
  // A bare date must parse as local, not UTC — new Date("2021-08-07") is UTC
  // midnight, which shifts a day west of Greenwich.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  const d = dateOnly
    ? new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3])
    : new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const date = d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  if (dateOnly || !/[T ]\d{2}[:.]/.test(raw)) return date;
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} - ${time}`;
}

/** A human-entered date back to the YYYY-MM-DD the server stores. */
function toServerDate(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || /^\d{4}(-\d{2}(-\d{2})?)?$/.test(trimmed)) return trimmed;
  const d = new Date(trimmed.replace(" - ", " "));
  if (Number.isNaN(d.getTime())) return trimmed; // let the server reject it
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Field key = the PATCH /clip/metadata body key.
const META_FIELDS: { key: string; label: string; multiline?: boolean }[] = [
  { key: "title", label: "Title" },
  { key: "author", label: "Author" },
  { key: "siteName", label: "Site" },
  { key: "publishedAt", label: "Published" },
  { key: "description", label: "Summary", multiline: true },
];

let clippedDocumentId: string | undefined;

/**
 * Editable preview of the metadata the capture extracted. Edits save back to
 * the document via PATCH /clip/metadata.
 */
function showMetaPreview(meta: Record<string, string | undefined>): void {
  const values: Record<string, string> = {
    title: meta.title ?? "",
    author: meta.byline ?? "",
    siteName: meta.siteName ?? "",
    publishedAt: meta.publishedAt ? formatDateTime(meta.publishedAt) : "",
    description: meta.description ?? "",
  };
  const saveButton = document.createElement("button");
  saveButton.id = "saveMeta";
  saveButton.textContent = "Save changes";
  saveButton.hidden = true;

  metaPreview.replaceChildren(
    ...META_FIELDS.flatMap(({ key, label, multiline }) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      const input = document.createElement(multiline ? "textarea" : "input");
      input.value = values[key];
      input.dataset.key = key;
      input.dataset.original = values[key];
      input.addEventListener("input", () => {
        saveButton.hidden = false;
        saveButton.textContent = "Save changes";
        saveButton.disabled = false;
      });
      dd.appendChild(input);
      return [dt, dd];
    }),
    saveButton
  );
  saveButton.addEventListener("click", () => void saveMetaEdits(saveButton));
  metaPreview.hidden = false;
}

/** PATCH only the fields the user actually changed. */
async function saveMetaEdits(saveButton: HTMLButtonElement): Promise<void> {
  if (!clippedDocumentId) return;
  const changes: Record<string, string> = {};
  const edited: (HTMLInputElement | HTMLTextAreaElement)[] = [];
  for (const input of metaPreview.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement
  >("input, textarea")) {
    if (input.value === input.dataset.original) continue;
    const key = input.dataset.key!;
    changes[key] =
      key === "publishedAt" ? toServerDate(input.value) : input.value;
    edited.push(input);
  }
  if (edited.length === 0) {
    saveButton.hidden = true;
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";
  const { endpoint } = await chrome.storage.sync.get(["endpoint"]);
  const { apiKey } = await chrome.storage.local.get(["apiKey"]);
  try {
    const res = await fetch(`${endpoint as string}/clip/metadata`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey as string}`,
      },
      body: JSON.stringify({ documentId: clippedDocumentId, ...changes }),
    });
    if (!res.ok) {
      const { error } = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(error ?? `HTTP ${res.status}`);
    }
    for (const input of edited) input.dataset.original = input.value;
    saveButton.textContent = "Saved ✓";
    setTimeout(() => {
      saveButton.hidden = true;
    }, 1500);
  } catch (e) {
    saveButton.disabled = false;
    saveButton.textContent = `Save failed: ${e instanceof Error ? e.message : "error"} — retry`;
  }
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
      clippedDocumentId = status.documentId;
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

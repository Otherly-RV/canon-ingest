"use client";

import React, { useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

type AssetBBox = { x: number; y: number; w: number; h: number };

type PageAsset = {
  assetId: string;
  url: string;
  bbox: AssetBBox;
  tags?: string[];
  tagRationale?: string;
};

type Manifest = {
  projectId: string;
  createdAt: string;
  status: "empty" | "uploaded" | "processed";
  sourcePdf?: { url: string; filename: string };
  extractedText?: { url: string };
  docAiJson?: { url: string };
  pages?: Array<{
    pageNumber: number;
    url: string;
    width: number;
    height: number;
    tags?: string[]; // legacy, not used
    assets?: PageAsset[];
  }>;
  settings: {
    aiRules: string;
    uiFieldsJson: string;
    taggingJson: string;
  };
};

type ProjectRow = {
  projectId: string;
  manifestUrl: string;
  createdAt: string;
  status: string;
  filename: string;
  pagesCount: number;
  hasText: boolean;
};

type PdfJsLib = {
  getDocument: (opts: { url: string; withCredentials?: boolean }) => PdfLoadingTask;
  GlobalWorkerOptions?: { workerSrc: string };
};

type PdfLoadingTask = { promise: Promise<unknown> };

type PdfDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
};

type PdfPage = {
  getViewport: (opts: { scale: number }) => PdfViewport;
  render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }) => { promise: Promise<void> };
};

type PdfViewport = { width: number; height: number };

async function readErrorText(res: Response) {
  try {
    const t = await res.text();
    return t || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

function setUrlParams(pid: string, m: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("pid", pid);
  url.searchParams.set("m", m);
  window.history.replaceState({}, "", url.toString());
}

function clearUrlParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete("pid");
  url.searchParams.delete("m");
  window.history.replaceState({}, "", url.toString());
}

function getUrlParams() {
  const url = new URL(window.location.href);
  return {
    pid: url.searchParams.get("pid") || "",
    m: url.searchParams.get("m") || ""
  };
}

function bust(url: string) {
  const u = new URL(url);
  u.searchParams.set("v", String(Date.now()));
  return u.toString();
}

function setPdfJsWorker(pdfjs: PdfJsLib) {
  if (!pdfjs.GlobalWorkerOptions) return;
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
}

function Chevron({ up }: { up: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={up ? "M6 14l6-6 6 6" : "M6 10l6 6 6-6"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function Trash() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M10 11v7M14 11v7M9 7l1-2h4l1 2M6 7l1 14h10l1-14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Refresh() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 12a9 9 0 10-3 6.7M21 12v-6m0 6h-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Tabs({
  value,
  onChange
}: {
  value: "ai" | "tagging";
  onChange: (v: "ai" | "tagging") => void;
}) {
  const tabStyle = (active: boolean): React.CSSProperties => ({
    border: "1px solid #000",
    background: active ? "#000" : "#fff",
    color: active ? "#fff" : "#000",
    borderRadius: 10,
    padding: "7px 10px",
    fontSize: 13,
    cursor: "pointer",
    whiteSpace: "nowrap"
  });

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <button type="button" onClick={() => onChange("ai")} style={tabStyle(value === "ai")}>
        AI Rules
      </button>
      <button type="button" onClick={() => onChange("tagging")} style={tabStyle(value === "tagging")}>
        Tagging JSON
      </button>
    </div>
  );
}

export default function Page() {
  const fileRef = useRef<HTMLInputElement>(null);
const [deletingAssets, setDeletingAssets] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [manifestUrl, setManifestUrl] = useState<string>("");
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [lastError, setLastError] = useState<string>("");

  const [cloudOpen, setCloudOpen] = useState(true);

  const [projectsOpen, setProjectsOpen] = useState(true);
  const [projectsBusy, setProjectsBusy] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[]>([]);

  const [settingsOpen, setSettingsOpen] = useState(true);
  const [settingsTab, setSettingsTab] = useState<"ai" | "tagging">("ai");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string>("");

  const [aiRulesDraft, setAiRulesDraft] = useState<string>("");
  const [taggingJsonDraft, setTaggingJsonDraft] = useState<string>("");

  const [assetsOpen, setAssetsOpen] = useState(true);

  const [rasterProgress, setRasterProgress] = useState({
    running: false,
    currentPage: 0,
    totalPages: 0,
    uploaded: 0
  });

  const [splitProgress, setSplitProgress] = useState({
    running: false,
    page: 0,
    totalPages: 0,
    assetsUploaded: 0
  });
async function deleteAsset(pageNumber: number, assetId: string, assetUrl: string) {
  if (!projectId || !manifestUrl) return;

  const key = `${pageNumber}-${assetId}`;
  if (deletingAssets[key]) return; // hard lock

  setDeletingAssets((m) => ({ ...m, [key]: true }));
  setLastError("");

  // Optimistic remove from UI immediately
  setManifest((prev) => {
    if (!prev?.pages) return prev;
    return {
      ...prev,
      pages: prev.pages.map((p) => {
        if (p.pageNumber !== pageNumber) return p;
        const assets = Array.isArray(p.assets) ? p.assets : [];
        return { ...p, assets: assets.filter((a) => a.assetId !== assetId) };
      })
    };
  });

  try {
    const r = await fetch("/api/projects/assets/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, manifestUrl, pageNumber, assetId, assetUrl })
    });

    const j = (await r.json().catch(() => null)) as { ok?: boolean; manifestUrl?: string; error?: string } | null;
    if (!r.ok || !j?.ok || !j.manifestUrl) throw new Error(j?.error || `Delete failed (${r.status})`);

    setManifestUrl(j.manifestUrl);
    setUrlParams(projectId, j.manifestUrl);
    await loadManifest(j.manifestUrl);
    await refreshProjects();
  } catch (e) {
    // If server failed, restore by reloading manifest (source of truth)
    setLastError(e instanceof Error ? e.message : String(e));
    await loadManifest(manifestUrl);
  } finally {
    setDeletingAssets((m) => {
      const copy = { ...m };
      delete copy[key];
      return copy;
    });
  }
}
async function loadManifest(url: string) {
  const mRes = await fetch("/api/projects/manifest/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifestUrl: url })
  });

  if (!mRes.ok) throw new Error(`Failed to read manifest: ${await readErrorText(mRes)}`);

  const payload = (await mRes.json()) as { ok: boolean; manifest?: Manifest; error?: string };
  if (!payload.ok || !payload.manifest) throw new Error(payload.error || "Bad manifest read response");

  const m = payload.manifest;
  setManifest(m);
  setAiRulesDraft(m.settings?.aiRules ?? "");
  setTaggingJsonDraft(m.settings?.taggingJson ?? "");
  return m;
}

  async function refreshProjects() {
    setProjectsBusy(true);
    try {
      const r = await fetch("/api/projects/list", { cache: "no-store" });
      if (!r.ok) throw new Error(await readErrorText(r));
      const j = (await r.json()) as { ok: boolean; projects?: ProjectRow[]; error?: string };
      if (!j.ok || !Array.isArray(j.projects)) throw new Error(j.error || "Bad /list response");
      setProjects(j.projects);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectsBusy(false);
    }
  }

  async function restoreProjectState(pid: string, murl: string): Promise<string> {
    const r = await fetch("/api/projects/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: pid, manifestUrl: murl })
    });
    if (!r.ok) throw new Error(await readErrorText(r));
    const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
    if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Restore failed (bad response)");
    return j.manifestUrl;
  }

  useEffect(() => {
    const { pid, m } = getUrlParams();
    if (pid && m) {
      setProjectId(pid);
      setManifestUrl(m);
      loadManifest(m).catch((e) => setLastError(e instanceof Error ? e.message : String(e)));
    }
    refreshProjects().catch(() => {});
  }, []);

  async function createProject() {
    const r = await fetch("/api/projects/create", { method: "POST" });
    if (!r.ok) throw new Error(`Create project failed: ${await readErrorText(r)}`);

    const j = (await r.json()) as { ok: boolean; projectId?: string; manifestUrl?: string; error?: string };
    if (!j.ok || !j.projectId || !j.manifestUrl) throw new Error(j.error || "Create project failed (bad response)");

    setProjectId(j.projectId);
    setManifestUrl(j.manifestUrl);
    setUrlParams(j.projectId, j.manifestUrl);

    await loadManifest(j.manifestUrl);
    await refreshProjects();

    return { projectId: j.projectId, manifestUrl: j.manifestUrl };
  }

  async function uploadSource(file: File) {
    setLastError("");
    setBusy("Uploading SOURCE...");

    try {
      const p = projectId && manifestUrl ? { projectId, manifestUrl } : await createProject();

      const form = new FormData();
      form.append("file", file);
      form.append("projectId", p.projectId);
      form.append("manifestUrl", p.manifestUrl);

      const r = await fetch("/api/projects/upload-source", { method: "POST", body: form });
      if (!r.ok) throw new Error(`Upload failed: ${await readErrorText(r)}`);

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Upload failed (bad response)");

      setManifestUrl(j.manifestUrl);
      setUrlParams(p.projectId, j.manifestUrl);

      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } finally {
      setBusy("");
    }
  }

  async function processPdf() {
    setLastError("");

    if (!projectId || !manifestUrl) return setLastError("Missing projectId/manifestUrl");
    if (!manifest?.sourcePdf?.url) return setLastError("No source PDF");
    if (busy) return;

    setBusy("Processing...");

    try {
      const r = await fetch("/api/projects/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });

      if (!r.ok) throw new Error(await readErrorText(r));

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Process failed (bad response)");

      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);

      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } finally {
      setBusy("");
    }
  }

  async function recordPage(pageNumber: number, url: string, width: number, height: number) {
    const r = await fetch("/api/projects/pages/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, manifestUrl, pageNumber, url, width, height })
    });

    if (!r.ok) throw new Error(await readErrorText(r));

    const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
    if (!j.ok || !j.manifestUrl) throw new Error(j.error || `Record page ${pageNumber} failed (bad response)`);

    setManifestUrl(j.manifestUrl);
    setUrlParams(projectId, j.manifestUrl);

    await loadManifest(j.manifestUrl);
  }

  async function rasterizeToPngs() {
    setLastError("");

    if (!projectId || !manifestUrl) return setLastError("Missing projectId/manifestUrl");
    if (!manifest?.sourcePdf?.url) return setLastError("No source PDF");
    if (busy || rasterProgress.running) return;

    setBusy("Rasterizing...");
    setRasterProgress({ running: true, currentPage: 0, totalPages: 0, uploaded: 0 });

    try {
      const pdfjsImport = (await import("pdfjs-dist")) as unknown;
      const pdfjs = pdfjsImport as PdfJsLib;
      setPdfJsWorker(pdfjs);

      const loadingTask = pdfjs.getDocument({ url: manifest.sourcePdf.url, withCredentials: false });
      const pdfUnknown = await loadingTask.promise;
      const pdf = pdfUnknown as PdfDocument;

      const totalPages = Number(pdf.numPages) || 0;
      setRasterProgress((p) => ({ ...p, totalPages }));

      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
        setRasterProgress((p) => ({ ...p, currentPage: pageNumber }));

        const page = await pdf.getPage(pageNumber);
        const scale = 1.5;
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Cannot create canvas 2D context");

        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));

        await page.render({ canvasContext: ctx, viewport }).promise;

        const pngBlob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/png");
        });

        const file = new File([pngBlob], `page-${pageNumber}.png`, { type: "image/png" });

        const blob = await upload(`projects/${projectId}/pages/page-${pageNumber}.png`, file, {
          access: "public",
          handleUploadUrl: "/api/blob"
        });

        await recordPage(pageNumber, blob.url, canvas.width, canvas.height);

        setRasterProgress((p) => ({ ...p, uploaded: p.uploaded + 1 }));
      }

      await refreshProjects();
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
      setRasterProgress((p) => ({ ...p, running: false }));
    }
  }

  async function recordAsset(pageNumber: number, assetId: string, url: string, bbox: AssetBBox) {
    const r = await fetch("/api/projects/assets/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, manifestUrl, pageNumber, assetId, url, bbox })
    });

    if (!r.ok) throw new Error(await readErrorText(r));

    const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
    if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Record asset failed (bad response)");

    setManifestUrl(j.manifestUrl);
    setUrlParams(projectId, j.manifestUrl);
    await loadManifest(j.manifestUrl);
  }
async function recordAssetsBulk(pageNumber: number, assets: Array<{ assetId: string; url: string; bbox: AssetBBox }>) {
  const r = await fetch("/api/projects/assets/record-bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, manifestUrl, pageNumber, assets })
  });

  if (!r.ok) throw new Error(await readErrorText(r));

  const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
  if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Record bulk failed (bad response)");

  setManifestUrl(j.manifestUrl);
  setUrlParams(projectId, j.manifestUrl);
  await loadManifest(j.manifestUrl);
}
async function splitImages() {
  setLastError("");

  if (!projectId || !manifestUrl) return setLastError("Missing projectId/manifestUrl");
  if (!manifest?.docAiJson?.url) return setLastError("No DocAI JSON");
  if (!manifest.pages?.length) return setLastError("No page PNGs");
  if (busy || splitProgress.running) return;

  setBusy("Splitting...");
  setSplitProgress({ running: true, page: 0, totalPages: manifest.pages.length, assetsUploaded: 0 });

  try {
    const detectRes = await fetch("/api/projects/assets/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, manifestUrl })
    });

    if (!detectRes.ok) throw new Error(await readErrorText(detectRes));

    const detected = (await detectRes.json()) as {
      ok: boolean;
      pages?: Array<{ pageNumber: number; boxes: AssetBBox[] }>;
      error?: string;
    };

    if (!detected.ok || !Array.isArray(detected.pages)) throw new Error(detected.error || "Detect failed (bad response)");

    const byPage = new Map<number, AssetBBox[]>();
    for (const p of detected.pages) {
      byPage.set(p.pageNumber, Array.isArray(p.boxes) ? p.boxes : []);
    }

    // Use the current manifest state for page URLs/sizes
    const pages = manifest.pages;

    for (const page of pages) {
      setSplitProgress((s) => ({ ...s, page: page.pageNumber }));

      const boxes = byPage.get(page.pageNumber) ?? [];
      if (boxes.length === 0) continue;

      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.crossOrigin = "anonymous";
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error(`Failed to load page image p${page.pageNumber}`));
        el.src = bust(page.url);
      });

      const uploadedForPage: Array<{ assetId: string; url: string; bbox: AssetBBox }> = [];

      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Cannot create canvas 2D context");

        canvas.width = Math.max(1, Math.floor(b.w));
        canvas.height = Math.max(1, Math.floor(b.h));

        ctx.drawImage(img, b.x, b.y, b.w, b.h, 0, 0, canvas.width, canvas.height);

        const pngBlob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((bb) => (bb ? resolve(bb) : reject(new Error("toBlob returned null"))), "image/png");
        });

        const assetId = `p${page.pageNumber}-img${String(i + 1).padStart(2, "0")}`;
        const file = new File([pngBlob], `${assetId}.png`, { type: "image/png" });

        const uploaded = await upload(`projects/${projectId}/assets/p${page.pageNumber}/${assetId}.png`, file, {
          access: "public",
          handleUploadUrl: "/api/blob"
        });

        uploadedForPage.push({ assetId, url: uploaded.url, bbox: b });

        setSplitProgress((s) => ({ ...s, assetsUploaded: s.assetsUploaded + 1 }));
      }

      // ✅ single manifest write per page
      if (uploadedForPage.length > 0) {
        await recordAssetsBulk(page.pageNumber, uploadedForPage);
      }
    }

    await refreshProjects();
  } catch (e) {
    setLastError(e instanceof Error ? e.message : String(e));
  } finally {
    setBusy("");
    setSplitProgress((s) => ({ ...s, running: false }));
  }
}

  async function tagImages() {
    setLastError("");

    if (!projectId || !manifestUrl) return setLastError("Missing projectId/manifestUrl");
    if (!manifest?.docAiJson?.url) return setLastError("No DocAI JSON");
    if (!manifest?.pages?.length) return setLastError("No pages/assets");
    if (busy) return;

    setBusy("Tagging...");

    try {
      const r = await fetch("/api/projects/assets/tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });

      if (!r.ok) throw new Error(await readErrorText(r));

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Tagging failed (bad response)");

      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);

      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function deleteProject(targetProjectId: string) {
    const ok = window.confirm(`Delete project ${targetProjectId}?`);
    if (!ok) return;

    setLastError("");
    setProjectsBusy(true);

    try {
      const r = await fetch("/api/projects/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: targetProjectId })
      });

      if (!r.ok) throw new Error(await readErrorText(r));

      if (targetProjectId === projectId) {
        setProjectId("");
        setManifestUrl("");
        setManifest(null);
        setAiRulesDraft("");
        setTaggingJsonDraft("");
        clearUrlParams();
      }

      await refreshProjects();
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectsBusy(false);
    }
  }

  async function openProject(p: ProjectRow) {
    setLastError("");
    setProjectId(p.projectId);
    setManifestUrl(p.manifestUrl);
    setUrlParams(p.projectId, p.manifestUrl);

    try {
      // Restore previous state automatically (pages/assets from Blob)
      const restoredManifestUrl = await restoreProjectState(p.projectId, p.manifestUrl);

      setManifestUrl(restoredManifestUrl);
      setUrlParams(p.projectId, restoredManifestUrl);

      await loadManifest(restoredManifestUrl);
      await refreshProjects();
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveSettings() {
    setSettingsError("");
    if (!projectId || !manifestUrl) {
      setSettingsError("No active project.");
      return;
    }

    try {
      JSON.parse(taggingJsonDraft);
    } catch {
      setSettingsError("Invalid JSON.");
      return;
    }

    setSettingsBusy(true);
    try {
      const r = await fetch("/api/projects/settings/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl, aiRules: aiRulesDraft, taggingJson: taggingJsonDraft })
      });

      if (!r.ok) throw new Error(await readErrorText(r));

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Save failed (bad response)");

      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);
      await loadManifest(j.manifestUrl);

      await refreshProjects();
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSettingsBusy(false);
    }
  }

  const pagesCount = manifest?.pages?.length ?? 0;

  const totalAssetsCount =
    (manifest?.pages ?? []).reduce((acc, p) => acc + ((p.assets ?? []).length), 0) ?? 0;

  const taggedAssetsCount =
    (manifest?.pages ?? []).reduce(
      (acc, p) => acc + ((p.assets ?? []).filter((a) => (a.tags ?? []).length > 0).length),
      0
    ) ?? 0;

  const assetsFlat: Array<{ pageNumber: number; asset: PageAsset }> = [];
  for (const p of manifest?.pages ?? []) {
    for (const a of p.assets ?? []) assetsFlat.push({ pageNumber: p.pageNumber, asset: a });
  }

  return (
    <div style={{ minHeight: "100vh", padding: 28 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.3 }}>OTHERLY — Ingest 1.0</div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => fileRef.current?.click()}
            style={{ border: "1px solid #000", background: "#fff", padding: "10px 12px", borderRadius: 12 }}
          >
            Upload SOURCE
          </button>

          <button
            type="button"
            disabled={!manifest?.sourcePdf?.url || !!busy}
            onClick={() => void processPdf()}
            style={{
              border: "1px solid #000",
              background: manifest?.sourcePdf?.url && !busy ? "#000" : "#fff",
              color: manifest?.sourcePdf?.url && !busy ? "#fff" : "#000",
              padding: "10px 12px",
              borderRadius: 12,
              opacity: manifest?.sourcePdf?.url && !busy ? 1 : 0.4
            }}
          >
            Process Text
          </button>

          <button
            type="button"
            disabled={!manifest?.sourcePdf?.url || !!busy || rasterProgress.running}
            onClick={() => void rasterizeToPngs()}
            style={{
              border: "1px solid #000",
              background: manifest?.sourcePdf?.url && !busy ? "#000" : "#fff",
              color: manifest?.sourcePdf?.url && !busy ? "#fff" : "#000",
              padding: "10px 12px",
              borderRadius: 12,
              opacity: manifest?.sourcePdf?.url && !busy ? 1 : 0.4
            }}
          >
            Rasterize PNGs
          </button>

          <button
            type="button"
            disabled={!manifest?.docAiJson?.url || !manifest?.pages?.length || !!busy || splitProgress.running}
            onClick={() => void splitImages()}
            style={{
              border: "1px solid #000",
              background: manifest?.docAiJson?.url && manifest?.pages?.length && !busy ? "#000" : "#fff",
              color: manifest?.docAiJson?.url && manifest?.pages?.length && !busy ? "#fff" : "#000",
              padding: "10px 12px",
              borderRadius: 12,
              opacity: manifest?.docAiJson?.url && manifest?.pages?.length && !busy ? 1 : 0.4
            }}
          >
            Split images
          </button>

          <button
            type="button"
            disabled={!manifest?.docAiJson?.url || !manifest?.pages?.length || !!busy}
            onClick={() => void tagImages()}
            style={{
              border: "1px solid #000",
              background: manifest?.docAiJson?.url && manifest?.pages?.length && !busy ? "#000" : "#fff",
              color: manifest?.docAiJson?.url && manifest?.pages?.length && !busy ? "#fff" : "#000",
              padding: "10px 12px",
              borderRadius: 12,
              opacity: manifest?.docAiJson?.url && manifest?.pages?.length && !busy ? 1 : 0.4
            }}
          >
            Tag images
          </button>
         <button
  type="button"
  disabled={!manifestUrl || !projectId || !!busy}
  onClick={async () => {
    setLastError("");
    if (!projectId || !manifestUrl) return;

    setBusy("Pruning missing assets...");
    try {
      const r = await fetch("/api/projects/assets/prune-missing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });
      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!r.ok || !j.ok || !j.manifestUrl) throw new Error(j.error || "Prune failed");

      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);
      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }}
  style={{
    border: "1px solid #000",
    background: "#fff",
    padding: "10px 12px",
    borderRadius: 12,
    opacity: !manifestUrl || !projectId || busy ? 0.4 : 1
  }}
>
  Prune assets
</button>
          <button
  type="button"
  disabled={!manifestUrl || !projectId || !!busy}
  onClick={async () => {
    setLastError("");
    if (!projectId || !manifestUrl) return;

    setBusy("Rebuilding assets...");
    try {
      const r = await fetch("/api/projects/assets/rebuild-index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!r.ok || !j.ok || !j.manifestUrl) throw new Error(j.error || `Rebuild failed (${r.status})`);

      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);
      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }}
  style={{
    border: "1px solid #000",
    background: "#fff",
    padding: "10px 12px",
    borderRadius: 12,
    opacity: !manifestUrl || !projectId || busy ? 0.4 : 1
  }}
>
  Rebuild assets
</button>
        </div>
      </div>

      {!!busy && (
        <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 800 }}>Working</div>
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.8 }}>{busy}</div>

          {rasterProgress.totalPages > 0 && (
            <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
              Raster: {rasterProgress.currentPage}/{rasterProgress.totalPages} · {rasterProgress.uploaded}/
              {rasterProgress.totalPages}
            </div>
          )}

          {splitProgress.totalPages > 0 && (
            <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
              Split: {splitProgress.page}/{splitProgress.totalPages} · {splitProgress.assetsUploaded}
            </div>
          )}
        </div>
      )}

      {!!lastError && (
        <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 800 }}>Error</div>
          <div style={{ marginTop: 6, fontSize: 13, whiteSpace: "pre-wrap" }}>{lastError}</div>
        </div>
      )}

      <div style={{ marginTop: 18, borderTop: "1px solid rgba(0,0,0,0.2)" }} />

      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>Assets</div>
          <button
            type="button"
            aria-label={assetsOpen ? "Collapse assets" : "Expand assets"}
            onClick={() => setAssetsOpen((v) => !v)}
            style={{
              border: "1px solid #000",
              background: "#fff",
              width: 36,
              height: 30,
              borderRadius: 10,
              display: "grid",
              placeItems: "center"
            }}
          >
            <Chevron up={assetsOpen} />
          </button>
        </div>
{assetsOpen && (
  <div style={{ padding: "0 14px 14px 14px" }}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
      {assetsFlat.map(({ pageNumber, asset }) => {
        const tags = Array.isArray(asset.tags) ? asset.tags : [];
        return (
          <div
            key={`${pageNumber}-${asset.assetId}`}
            style={{
              position: "relative",
              border: "1px solid rgba(0,0,0,0.25)",
              borderRadius: 12,
              overflow: "hidden",
              background: "#fff"
            }}
          >
            <button
              type="button"
              aria-label={`Delete ${asset.assetId}`}
              disabled={!!busy || !!deletingAssets[`${pageNumber}-${asset.assetId}`]}
              onClick={() => void deleteAsset(pageNumber, asset.assetId, asset.url)}
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                border: "1px solid rgba(0,0,0,0.35)",
                background: "#fff",
                width: 28,
                height: 24,
                borderRadius: 10,
                display: "grid",
                placeItems: "center",
                opacity: busy ? 0.5 : 1,
                cursor: busy ? "not-allowed" : "pointer",
                zIndex: 2
              }}
            >
              <XIcon />
            </button>

            <div style={{ aspectRatio: "1 / 1", background: "rgba(0,0,0,0.03)" }}>
              <img
                src={bust(asset.url)}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
              />
            </div>

            <div style={{ padding: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 800 }}>
                p{pageNumber} · {asset.assetId}
              </div>

              {tags.length > 0 && (
                <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {tags.map((t) => (
                    <span
                      key={t}
                      style={{
                        fontSize: 12,
                        padding: "4px 8px",
                        border: "1px solid rgba(0,0,0,0.25)",
                        borderRadius: 999
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  </div>
)}
      </div>

      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>Settings</div>
          <button
            type="button"
            aria-label={settingsOpen ? "Collapse settings" : "Expand settings"}
            onClick={() => setSettingsOpen((v) => !v)}
            style={{
              border: "1px solid #000",
              background: "#fff",
              width: 36,
              height: 30,
              borderRadius: 10,
              display: "grid",
              placeItems: "center"
            }}
          >
            <Chevron up={settingsOpen} />
          </button>
        </div>

        {settingsOpen && (
          <div style={{ padding: "0 14px 14px 14px", overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <Tabs value={settingsTab} onChange={setSettingsTab} />

              <button
                type="button"
                disabled={settingsBusy || !projectId || !manifestUrl}
                onClick={() => void saveSettings()}
                style={{
                  border: "1px solid #000",
                  background: "#000",
                  color: "#fff",
                  padding: "8px 10px",
                  borderRadius: 10,
                  opacity: settingsBusy || !projectId || !manifestUrl ? 0.5 : 1,
                  cursor: settingsBusy || !projectId || !manifestUrl ? "not-allowed" : "pointer",
                  fontSize: 13,
                  fontWeight: 800,
                  whiteSpace: "nowrap"
                }}
              >
                {settingsBusy ? "Saving..." : "Save"}
              </button>
            </div>

            {settingsError && (
              <div style={{ marginTop: 10, border: "1px solid #000", borderRadius: 12, padding: 10 }}>
                <div style={{ fontWeight: 800, fontSize: 13 }}>Error</div>
                <div style={{ marginTop: 6, fontSize: 13, whiteSpace: "pre-wrap" }}>{settingsError}</div>
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              {settingsTab === "ai" ? (
                <textarea
                  value={aiRulesDraft}
                  onChange={(e) => setAiRulesDraft(e.target.value)}
                  style={{
                    width: "100%",
                    maxWidth: "100%",
                    boxSizing: "border-box",
                    display: "block",
                    minHeight: 180,
                    border: "1px solid rgba(0,0,0,0.35)",
                    borderRadius: 12,
                    padding: 12,
                    fontSize: 13,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                  }}
                />
              ) : (
                <textarea
                  value={taggingJsonDraft}
                  onChange={(e) => setTaggingJsonDraft(e.target.value)}
                  style={{
                    width: "100%",
                    maxWidth: "100%",
                    boxSizing: "border-box",
                    display: "block",
                    minHeight: 180,
                    border: "1px solid rgba(0,0,0,0.35)",
                    borderRadius: 12,
                    padding: 12,
                    fontSize: 13,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                  }}
                />
              )}
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>Projects</div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              aria-label="Refresh projects"
              disabled={projectsBusy}
              onClick={() => void refreshProjects()}
              style={{
                border: "1px solid #000",
                background: "#fff",
                width: 36,
                height: 30,
                borderRadius: 10,
                display: "grid",
                placeItems: "center",
                opacity: projectsBusy ? 0.5 : 1
              }}
            >
              <Refresh />
            </button>

            <button
              type="button"
              aria-label={projectsOpen ? "Collapse projects" : "Expand projects"}
              onClick={() => setProjectsOpen((v) => !v)}
              style={{
                border: "1px solid #000",
                background: "#fff",
                width: 36,
                height: 30,
                borderRadius: 10,
                display: "grid",
                placeItems: "center"
              }}
            >
              <Chevron up={projectsOpen} />
            </button>
          </div>
        </div>

        {projectsOpen && (
          <div style={{ padding: "0 14px 14px 14px" }}>
            <div style={{ display: "grid", gap: 8 }}>
              {projects.map((p) => {
                const active = p.projectId === projectId;
                return (
                  <div
                    key={p.projectId}
                    style={{
                      border: "1px solid rgba(0,0,0,0.25)",
                      borderRadius: 12,
                      padding: 10,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                      background: active ? "rgba(0,0,0,0.04)" : "#fff"
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => void openProject(p)}
                      style={{
                        textAlign: "left",
                        flex: 1,
                        border: "none",
                        background: "transparent",
                        padding: 0,
                        cursor: "pointer"
                      }}
                    >
                      <div style={{ fontWeight: 800, fontSize: 13, lineHeight: "18px" }}>
                        {p.filename || "(no source)"}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                        id: {p.projectId} · {p.status} · pages: {p.pagesCount} · text: {p.hasText ? "yes" : "no"}
                      </div>
                    </button>

                    <button
                      type="button"
                      aria-label={`Delete project ${p.projectId}`}
                      disabled={projectsBusy}
                      onClick={() => void deleteProject(p.projectId)}
                      style={{
                        border: "1px solid #000",
                        background: "#fff",
                        width: 36,
                        height: 30,
                        borderRadius: 10,
                        display: "grid",
                        placeItems: "center",
                        opacity: projectsBusy ? 0.5 : 1
                      }}
                    >
                      <Trash />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>Cloud state</div>

          <button
            type="button"
            aria-label={cloudOpen ? "Collapse cloud state" : "Expand cloud state"}
            onClick={() => setCloudOpen((v) => !v)}
            style={{
              border: "1px solid #000",
              background: "#fff",
              width: 36,
              height: 30,
              borderRadius: 10,
              display: "grid",
              placeItems: "center"
            }}
          >
            <Chevron up={cloudOpen} />
          </button>
        </div>

        {cloudOpen && (
          <div style={{ padding: "0 14px 14px 14px", fontSize: 13 }}>
            <div>
              <span style={{ opacity: 0.7 }}>projectId:</span> {projectId || "—"}
            </div>

            <div style={{ marginTop: 6 }}>
              <span style={{ opacity: 0.7 }}>status:</span> {manifest?.status || "—"}
            </div>

            <div style={{ marginTop: 10 }}>
              <span style={{ opacity: 0.7 }}>manifestUrl:</span>
            </div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>{manifestUrl || "—"}</div>

            <div style={{ marginTop: 10 }}>
              <span style={{ opacity: 0.7 }}>sourcePdf:</span>
            </div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>{manifest?.sourcePdf?.url || "—"}</div>

            <div style={{ marginTop: 10 }}>
              <span style={{ opacity: 0.7 }}>extractedText:</span>
            </div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>{manifest?.extractedText?.url || "—"}</div>

            <div style={{ marginTop: 10 }}>
              <span style={{ opacity: 0.7 }}>docAiJson:</span>
            </div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>{manifest?.docAiJson?.url || "—"}</div>

            <div style={{ marginTop: 10 }}>
              <span style={{ opacity: 0.7 }}>pages:</span> {pagesCount}
            </div>

            <div style={{ marginTop: 6 }}>
              <span style={{ opacity: 0.7 }}>assets:</span> {taggedAssetsCount}/{totalAssetsCount}
            </div>
          </div>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/pdf"
        style={{ display: "none" }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try {
            await uploadSource(f);
          } catch (err) {
            setLastError(err instanceof Error ? err.message : String(err));
          }
        }}
      />
    </div>
  );
}

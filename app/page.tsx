"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
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
  formattedText?: { url: string };
  docAiJson?: { url: string };
  schemaResults?: { url: string };
  pages?: Array<{
    pageNumber: number;
    url: string;
    width: number;
    height: number;
    tags?: string[];
    assets?: PageAsset[];
    deletedAssetIds?: string[];
  }>;
  settings: {
    aiRules: string;
    uiFieldsJson: string;
    taggingJson: string;
    schemaJson: string;
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
  GlobalWorkerOptions: { workerSrc: string };
};

type PdfLoadingTask = { promise: Promise<PdfDocument> };

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

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Tabs({
  value,
  onChange
}: {
  value: "ai" | "tagging" | "schema";
  onChange: (v: "ai" | "tagging" | "schema") => void;
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
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
        minWidth: 0,
        flex: 1,
        overflow: "hidden"
      }}
    >
      <button type="button" onClick={() => onChange("ai")} style={tabStyle(value === "ai")}>
        AI Rules
      </button>
      <button type="button" onClick={() => onChange("schema")} style={tabStyle(value === "schema")}>
        Schema JSON
      </button>
      <button type="button" onClick={() => onChange("tagging")} style={tabStyle(value === "tagging")}>
        Tagging JSON
      </button>
    </div>
  );
}

export default function Page() {
  const fileRef = useRef<HTMLInputElement>(null);

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
  const [settingsTab, setSettingsTab] = useState<"ai" | "tagging" | "schema">("ai");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string>("");

  const [aiRulesDraft, setAiRulesDraft] = useState<string>("");
  const [taggingJsonDraft, setTaggingJsonDraft] = useState<string>("");
  const [schemaJsonDraft, setSchemaJsonDraft] = useState<string>("");

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

  const [taggingProgress, setTaggingProgress] = useState({
    running: false,
    total: 0,
    tagged: 0
  });

  const [assetsOpen, setAssetsOpen] = useState(true);
  const [deletingAssets, setDeletingAssets] = useState<Record<string, boolean>>({});

  const [textPanelOpen, setTextPanelOpen] = useState(false);
  const [extractedText, setExtractedText] = useState<string>("");
  const [formattedText, setFormattedText] = useState<string>("");
  const [textLoading, setTextLoading] = useState(false);

  const [debugLogOpen, setDebugLogOpen] = useState(false);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  // Schema filling state
  const [schemaResultsOpen, setSchemaResultsOpen] = useState(false);
  const [schemaResults, setSchemaResults] = useState<string>("");
  const [schemaResultsDraft, setSchemaResultsDraft] = useState<string>("");
  const [schemaFillBusy, setSchemaFillBusy] = useState(false);
  const [schemaSaveBusy, setSchemaSaveBusy] = useState(false);

  function log(msg: string) {
    const ts = new Date().toLocaleTimeString();
    setDebugLog((prev) => [...prev.slice(-99), `[${ts}] ${msg}`]);
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
    setSchemaJsonDraft(m.settings?.schemaJson ?? "");

    // Load cached formatted text if available
    if (m.formattedText?.url) {
      try {
        const res = await fetch(m.formattedText.url);
        if (res.ok) {
          const text = await res.text();
          setFormattedText(text);
        }
      } catch {
        // Ignore errors loading cached text
      }
    }

    // Load cached extracted text if available
    if (m.extractedText?.url) {
      try {
        const res = await fetch(m.extractedText.url);
        if (res.ok) {
          const text = await res.text();
          setExtractedText(text);
        }
      } catch {
        // Ignore errors loading extracted text
      }
    }

    // Load cached schema results if available
    if (m.schemaResults?.url) {
      try {
        const res = await fetch(m.schemaResults.url);
        if (res.ok) {
          const text = await res.text();
          setSchemaResults(text);
          setSchemaResultsDraft(text);
        }
      } catch {
        // Ignore errors loading schema results
      }
    } else {
      setSchemaResults("");
      setSchemaResultsDraft("");
    }

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
      // Always create a new project for each upload
      const p = await createProject();

      // Use client-side upload to bypass serverless function size limits
      const blob = await upload(`projects/${p.projectId}/source/source.pdf`, file, {
        access: "public",
        handleUploadUrl: "/api/blob"
      });

      // Record the PDF URL in the manifest
      const r = await fetch("/api/projects/record-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: p.projectId,
          manifestUrl: p.manifestUrl,
          sourcePdfUrl: blob.url,
          filename: file.name
        })
      });
      if (!r.ok) throw new Error(`Record source failed: ${await readErrorText(r)}`);

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Record source failed (bad response)");

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
    log("Starting DocAI processing...");

    try {
      const r = await fetch("/api/projects/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });

      if (!r.ok) throw new Error(await readErrorText(r));

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Process failed (bad response)");

      log("DocAI processing complete");
      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);

      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Process error: ${msg}`);
      setLastError(msg);
    } finally {
      setBusy("");
    }
  }

  async function recordPage(pageNumber: number, url: string, width: number, height: number, currentManifestUrl: string): Promise<string> {
    const r = await fetch("/api/projects/pages/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, manifestUrl: currentManifestUrl, pageNumber, url, width, height })
    });

    if (!r.ok) throw new Error(await readErrorText(r));

    const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
    if (!j.ok || !j.manifestUrl) throw new Error(j.error || `Record page ${pageNumber} failed (bad response)`);

    setManifestUrl(j.manifestUrl);
    setUrlParams(projectId, j.manifestUrl);
    return j.manifestUrl;
  }

  async function rasterizeToPngs() {
    setLastError("");

    if (!projectId || !manifestUrl) return setLastError("Missing projectId/manifestUrl");
    if (!manifest?.sourcePdf?.url) return setLastError("No source PDF");
    if (busy || rasterProgress.running) return;

    setBusy("Rasterizing...");
    setRasterProgress({ running: true, currentPage: 0, totalPages: 0, uploaded: 0 });
    log("Starting rasterization...");

    try {
      const pdfjsImport = (await import("pdfjs-dist")) as unknown as PdfJsLib;
      setPdfJsWorker(pdfjsImport);

      const loadingTask = pdfjsImport.getDocument({ url: manifest.sourcePdf.url, withCredentials: false });
      const pdf = await loadingTask.promise;

      const totalPages = Number(pdf.numPages) || 0;
      setRasterProgress((p) => ({ ...p, totalPages }));
      log(`PDF has ${totalPages} pages`);

      // Collect all page data first, then save in one batch at the end
      const allPages: Array<{ pageNumber: number; url: string; width: number; height: number }> = [];

      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
        setRasterProgress((p) => ({ ...p, currentPage: pageNumber }));

        const page = await pdf.getPage(pageNumber);
        const scale = 1.25;
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

        // Collect page data instead of saving one by one
        allPages.push({
          pageNumber,
          url: blob.url,
          width: canvas.width,
          height: canvas.height
        });

        setRasterProgress((p) => ({ ...p, uploaded: p.uploaded + 1 }));
        log(`Uploaded page ${pageNumber}/${totalPages}`);
      }

      // Now save all pages in one bulk operation to avoid race conditions
      log(`Saving ${allPages.length} pages to manifest...`);
      const r = await fetch("/api/projects/pages/record-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl, pages: allPages })
      });

      if (!r.ok) throw new Error(await readErrorText(r));

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Record bulk pages failed");

      log(`All ${allPages.length} pages saved successfully`);
      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);

      // Load final manifest at the end
      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Rasterization error: ${msg}`);
      setLastError(msg);
    } finally {
      setBusy("");
      setRasterProgress((p) => ({ ...p, running: false }));
    }
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
    if (!manifest?.pages?.length) return setLastError("No page PNGs - run Rasterize first");
    if (busy || splitProgress.running) return;

    const pages = manifest.pages;

    setBusy("Detecting images...");
    setSplitProgress({ running: true, page: 0, totalPages: pages.length, assetsUploaded: 0 });
    log("Starting image detection with Gemini...");

    try {
      for (const page of pages) {
        setSplitProgress((s) => ({ ...s, page: page.pageNumber }));
        log(`Detecting images on page ${page.pageNumber}...`);

        // Use Gemini to detect images on this page
        const detectRes = await fetch("/api/projects/assets/detect-gemini", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pageUrl: page.url,
            pageWidth: page.width,
            pageHeight: page.height
          })
        });

        if (!detectRes.ok) {
          log(`Detection failed for page ${page.pageNumber}: ${await readErrorText(detectRes)}`);
          continue;
        }

        const detected = (await detectRes.json()) as { boxes?: Array<{ x: number; y: number; width: number; height: number }>; error?: string };
        const boxes = detected.boxes ?? [];
        log(`Found ${boxes.length} images on page ${page.pageNumber}`);

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
          // Convert from {x, y, width, height} to {x, y, w, h}
          const bbox: AssetBBox = { x: b.x, y: b.y, w: b.width, h: b.height };

          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Cannot create canvas 2D context");

          canvas.width = Math.max(1, Math.floor(bbox.w));
          canvas.height = Math.max(1, Math.floor(bbox.h));

          ctx.drawImage(img, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, canvas.width, canvas.height);

          const pngBlob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((bb) => (bb ? resolve(bb) : reject(new Error("toBlob returned null"))), "image/png");
          });

          const assetId = `p${page.pageNumber}-img${String(i + 1).padStart(2, "0")}`;
          const file = new File([pngBlob], `${assetId}.png`, { type: "image/png" });

          const uploaded = await upload(`projects/${projectId}/assets/p${page.pageNumber}/${assetId}.png`, file, {
            access: "public",
            handleUploadUrl: "/api/blob"
          });

          uploadedForPage.push({ assetId, url: uploaded.url, bbox });

          setSplitProgress((s) => ({ ...s, assetsUploaded: s.assetsUploaded + 1 }));
          log(`Uploaded asset ${assetId}`);
        }

        if (uploadedForPage.length > 0) {
          await recordAssetsBulk(page.pageNumber, uploadedForPage);
        }
      }

      log("Detection complete");
      await refreshProjects();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Detection error: ${msg}`);
      setLastError(msg);
    } finally {
      setBusy("");
      setSplitProgress((s) => ({ ...s, running: false }));
    }
  }

  async function rebuildAssets() {
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
  }

  async function restoreFromBlob() {
    setLastError("");
    if (!projectId || !manifestUrl) return;

    setBusy("Restoring from blob storage...");
    log("Starting restore from blob storage...");
    try {
      const r = await fetch("/api/projects/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });

      const j = (await r.json()) as { 
        ok: boolean; 
        manifestUrl?: string; 
        error?: string;
        pagesFound?: number;
        assetsFound?: number;
        pagesInManifest?: number;
      };
      if (!r.ok || !j.ok || !j.manifestUrl) throw new Error(j.error || `Restore failed (${r.status})`);

      log(`Restore complete: ${j.pagesFound} page blobs, ${j.assetsFound} asset blobs, ${j.pagesInManifest} pages in manifest`);
      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);
      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Restore error: ${msg}`);
      setLastError(msg);
    } finally {
      setBusy("");
    }
  }

  async function tagAssets() {
    setLastError("");
    if (!projectId || !manifestUrl) return;
    if (!manifest?.pages?.length) {
      setLastError("No pages to tag.");
      return;
    }

    // Count total assets
    let totalAssets = 0;
    for (const p of manifest.pages) {
      totalAssets += (p.assets ?? []).length;
    }

    if (totalAssets === 0) {
      log("No assets to tag.");
      return;
    }

    setBusy("Tagging assets...");
    setTaggingProgress({ running: true, total: totalAssets, tagged: 0 });
    log(`Starting tagging of ${totalAssets} assets (overwrite mode)...`);

    try {
      const r = await fetch("/api/projects/assets/tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl, overwrite: true })
      });

      const j = (await r.json()) as {
        ok: boolean;
        manifestUrl?: string;
        error?: string;
        considered?: number;
        tagged?: number;
      };

      if (!r.ok || !j.ok || !j.manifestUrl) throw new Error(j.error || `Tagging failed (${r.status})`);

      log(`Tagging complete: ${j.tagged} assets tagged out of ${j.considered} considered`);
      setTaggingProgress((s) => ({ ...s, tagged: j.tagged ?? 0 }));

      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);
      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Tagging error: ${msg}`);
      setLastError(msg);
    } finally {
      setBusy("");
      setTaggingProgress((s) => ({ ...s, running: false }));
    }
  }

  async function fillSchema() {
    setLastError("");
    if (!projectId || !manifestUrl) return;

    setSchemaFillBusy(true);
    setBusy("Filling schema with AI...");
    log("Starting schema fill...");

    try {
      const r = await fetch("/api/projects/schema/fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });

      const j = (await r.json()) as {
        ok: boolean;
        results?: string;
        error?: string;
      };

      if (!r.ok || !j.ok || !j.results) throw new Error(j.error || `Schema fill failed (${r.status})`);

      log("Schema fill complete");
      setSchemaResultsDraft(j.results);
      setSchemaResultsOpen(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Schema fill error: ${msg}`);
      setLastError(msg);
    } finally {
      setBusy("");
      setSchemaFillBusy(false);
    }
  }

  async function saveSchemaResults() {
    setLastError("");
    if (!projectId || !manifestUrl) return;

    setSchemaSaveBusy(true);
    log("Saving schema results...");

    try {
      const r = await fetch("/api/projects/schema/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl, results: schemaResultsDraft })
      });

      const j = (await r.json()) as {
        ok: boolean;
        manifestUrl?: string;
        error?: string;
      };

      if (!r.ok || !j.ok || !j.manifestUrl) throw new Error(j.error || `Schema save failed (${r.status})`);

      log("Schema results saved");
      setSchemaResults(schemaResultsDraft);
      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);
      await loadManifest(j.manifestUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Schema save error: ${msg}`);
      setLastError(msg);
    } finally {
      setSchemaSaveBusy(false);
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
      await loadManifest(p.manifestUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg);
      await refreshProjects();
    }
  }

  async function saveSettings() {
    setSettingsError("");
    if (!projectId || !manifestUrl) {
      setSettingsError("No active project.");
      return;
    }

    // Validate taggingJson is valid JSON
    try {
      JSON.parse(taggingJsonDraft);
    } catch {
      setSettingsError("Tagging JSON is invalid.");
      return;
    }

    // Validate schemaJson is valid JSON (if not empty)
    if (schemaJsonDraft.trim()) {
      try {
        JSON.parse(schemaJsonDraft);
      } catch {
        setSettingsError("Schema JSON is invalid.");
        return;
      }
    }

    setSettingsBusy(true);
    try {
      const r = await fetch("/api/projects/settings/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          manifestUrl,
          aiRules: aiRulesDraft,
          taggingJson: taggingJsonDraft,
          schemaJson: schemaJsonDraft
        })
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

  async function loadExtractedText() {
    if (!manifest?.extractedText?.url) {
      setLastError("No extracted text available. Run 'Process Text' first.");
      return;
    }

    setTextLoading(true);
    log("Loading extracted text...");

    try {
      // Load raw extracted text
      const res = await fetch(manifest.extractedText.url);
      if (!res.ok) throw new Error(`Failed to fetch text: ${res.status}`);
      const raw = await res.text();
      setExtractedText(raw);
      log(`Loaded ${raw.length} chars of extracted text`);

      // Check if we have cached formatted text
      if (manifest.formattedText?.url) {
        log("Loading cached formatted text...");
        const cachedRes = await fetch(manifest.formattedText.url);
        if (cachedRes.ok) {
          const cachedText = await cachedRes.text();
          setFormattedText(cachedText);
          log("Loaded cached formatted text");
          setTextPanelOpen(true);
          return;
        }
        log("Failed to load cached text, re-formatting...");
      }

      // Format with Gemini and cache the result
      log("Formatting with Gemini...");
      const fRes = await fetch("/api/projects/format-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl, text: raw })
      });

      if (!fRes.ok) {
        log("Gemini formatting failed, showing raw text");
        setFormattedText(raw);
      } else {
        const fj = (await fRes.json()) as { ok: boolean; formatted?: string; manifestUrl?: string; error?: string };
        if (fj.ok && fj.formatted) {
          setFormattedText(fj.formatted);
          log("Text formatted and cached successfully");
          // Update manifest URL if it changed (due to caching)
          if (fj.manifestUrl) {
            setManifestUrl(fj.manifestUrl);
            setUrlParams(projectId, fj.manifestUrl);
            await loadManifest(fj.manifestUrl);
          }
        } else {
          log(fj.error || "Format failed, showing raw");
          setFormattedText(raw);
        }
      }

      setTextPanelOpen(true);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
      log(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTextLoading(false);
    }
  }

  async function deleteAsset(pageNumber: number, assetId: string) {
    if (!projectId || !manifestUrl) return;

    const key = `${pageNumber}-${assetId}`;
    if (deletingAssets[key]) return;

    setDeletingAssets((m) => ({ ...m, [key]: true }));
    setLastError("");

    setManifest((prev) => {
      if (!prev?.pages) return prev;
      return {
        ...prev,
        pages: prev.pages.map((p) => {
          if (p.pageNumber !== pageNumber) return p;
          const assets = Array.isArray(p.assets) ? p.assets : [];
          const deleted = Array.isArray(p.deletedAssetIds) ? p.deletedAssetIds : [];
          const nextDeleted = deleted.includes(assetId) ? deleted : [...deleted, assetId];
          return { ...p, assets: assets.filter((a) => a.assetId !== assetId), deletedAssetIds: nextDeleted };
        })
      };
    });

    try {
      const r = await fetch("/api/projects/assets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl, pageNumber, assetId })
      });

      const j = (await r.json().catch(() => null)) as { ok?: boolean; manifestUrl?: string; error?: string } | null;
      if (!r.ok || !j?.ok || !j.manifestUrl) throw new Error(j?.error || `Delete failed (${r.status})`);

      setManifestUrl(j.manifestUrl);
      setUrlParams(projectId, j.manifestUrl);
      await loadManifest(j.manifestUrl);
      await refreshProjects();
    } catch (e) {
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

  const pagesCount = manifest?.pages?.length ?? 0;

  const totalAssetsCount =
    (manifest?.pages ?? []).reduce((acc, p) => acc + (Array.isArray(p.assets) ? p.assets.length : 0), 0) ?? 0;

  const assetsFlat = useMemo(() => {
    const out: Array<{ pageNumber: number; asset: PageAsset }> = [];
    for (const p of manifest?.pages ?? []) {
      for (const a of p.assets ?? []) out.push({ pageNumber: p.pageNumber, asset: a });
    }
    return out;
  }, [manifest]);

  const taggedAssetsCount = useMemo(() => {
    let n = 0;
    for (const p of manifest?.pages ?? []) {
      for (const a of p.assets ?? []) {
        if (Array.isArray(a.tags) && a.tags.length > 0) n += 1;
      }
    }
    return n;
  }, [manifest]);

  const assetCard = (pageNumber: number, asset: PageAsset) => {
    const tags = Array.isArray(asset.tags) ? asset.tags : [];
    const delKey = `${pageNumber}-${asset.assetId}`;
    const delBusy = !!deletingAssets[delKey] || !!busy;

    return (
      <div
        key={`${pageNumber}-${asset.assetId}`}
        style={{
          border: "1px solid rgba(0,0,0,0.25)",
          borderRadius: 12,
          overflow: "hidden",
          background: "#fff",
          position: "relative"
        }}
      >
        <button
          type="button"
          aria-label="Delete asset"
          disabled={delBusy}
          onClick={() => void deleteAsset(pageNumber, asset.assetId)}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            width: 28,
            height: 28,
            borderRadius: 10,
            border: "1px solid #000",
            background: "#fff",
            display: "grid",
            placeItems: "center",
            opacity: delBusy ? 0.4 : 1,
            cursor: delBusy ? "not-allowed" : "pointer",
            zIndex: 2
          }}
        >
          <XIcon />
        </button>

        <div style={{ aspectRatio: "1 / 1", background: "rgba(0,0,0,0.03)" }}>
          <img
            src={bust(asset.url)}
            alt=""
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
          />
        </div>

        <div style={{ padding: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 800 }}>
            p{pageNumber} · {asset.assetId}
          </div>

          {tags.length > 0 && (
            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
              {tags.slice(0, 20).map((t) => (
                <span
                  key={t}
                  style={{
                    border: "1px solid rgba(0,0,0,0.25)",
                    borderRadius: 999,
                    padding: "3px 8px",
                    fontSize: 12
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
  };

  return (
    <div style={{ minHeight: "100vh", padding: 28 }}>
      {/* Row 1: App name */}
      <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.3 }}>OTHERLY — Ingest 1.0</div>

      {/* Row 2: Main workflow buttons */}
      <div style={{ marginTop: 18, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => fileRef.current?.click()}
          style={{ border: "1px solid #000", background: "#fff", padding: "10px 12px", borderRadius: 12 }}
        >
          1. Load Source
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
          2. Process Text
        </button>

        <button
          type="button"
          disabled={!manifest?.extractedText?.url || !!busy || textLoading}
          onClick={() => void loadExtractedText()}
          style={{
            border: "1px solid #000",
            background: manifest?.extractedText?.url && !busy ? "#000" : "#fff",
            color: manifest?.extractedText?.url && !busy ? "#fff" : "#000",
            padding: "10px 12px",
            borderRadius: 12,
            opacity: manifest?.extractedText?.url && !busy ? 1 : 0.4
          }}
        >
          {textLoading ? "Loading..." : "3. View Text"}
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
          4. Rasterize PNGs
        </button>

        <button
          type="button"
          disabled={!manifest?.pages?.length || !!busy || splitProgress.running}
          onClick={() => void splitImages()}
          style={{
            border: "1px solid #000",
            background: manifest?.pages?.length && !busy ? "#000" : "#fff",
            color: manifest?.pages?.length && !busy ? "#fff" : "#000",
            padding: "10px 12px",
            borderRadius: 12,
            opacity: manifest?.pages?.length && !busy ? 1 : 0.4
          }}
        >
          5. Detect Images
        </button>

        <button
          type="button"
          disabled={!totalAssetsCount || !!busy || taggingProgress.running}
          onClick={() => void tagAssets()}
          style={{
            border: "1px solid #000",
            background: totalAssetsCount && !busy ? "#000" : "#fff",
            color: totalAssetsCount && !busy ? "#fff" : "#000",
            padding: "10px 12px",
            borderRadius: 12,
            opacity: totalAssetsCount && !busy ? 1 : 0.4
          }}
        >
          6. Tag Assets
        </button>

        <button
          type="button"
          disabled={!manifestUrl || !!busy || schemaFillBusy}
          onClick={() => void fillSchema()}
          style={{
            border: "1px solid #000",
            background: manifestUrl && !busy && !schemaFillBusy ? "#000" : "#fff",
            color: manifestUrl && !busy && !schemaFillBusy ? "#fff" : "#000",
            padding: "10px 12px",
            borderRadius: 12,
            opacity: manifestUrl && !busy && !schemaFillBusy ? 1 : 0.4
          }}
        >
          7. Fill Schema
        </button>
      </div>

      {/* Row 3: Utility buttons aligned right */}
      <div style={{ marginTop: 12, display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button
          type="button"
          disabled={!manifestUrl || !projectId || !!busy}
          onClick={() => void rebuildAssets()}
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

        <button
          type="button"
          disabled={!manifestUrl || !projectId || !!busy}
          onClick={() => void restoreFromBlob()}
          style={{
            border: "1px solid #000",
            background: "#fff",
            padding: "10px 12px",
            borderRadius: 12,
            opacity: !manifestUrl || !projectId || busy ? 0.4 : 1
          }}
        >
          Restore
        </button>
      </div>

      {/* Working Panel */}
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
              Detect: {splitProgress.page}/{splitProgress.totalPages} · {splitProgress.assetsUploaded} assets
            </div>
          )}

          {taggingProgress.running && (
            <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
              Tagging: {taggingProgress.tagged}/{taggingProgress.total} assets
            </div>
          )}
        </div>
      )}

      {/* Error Panel */}
      {!!lastError && (
        <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 800 }}>Error</div>
          <div style={{ marginTop: 6, fontSize: 13, whiteSpace: "pre-wrap" }}>{lastError}</div>
        </div>
      )}

      {/* Debug Log Panel */}
      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>Debug Log ({debugLog.length})</div>
          <button
            type="button"
            aria-label={debugLogOpen ? "Collapse log" : "Expand log"}
            onClick={() => setDebugLogOpen((v) => !v)}
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
            <Chevron up={debugLogOpen} />
          </button>
        </div>

        {debugLogOpen && (
          <div style={{ padding: "0 14px 14px 14px" }}>
            {debugLog.length > 0 ? (
              <div
                style={{
                  fontSize: 11,
                  fontFamily: "monospace",
                  whiteSpace: "pre-wrap",
                  maxHeight: 200,
                  overflow: "auto",
                  background: "#1a1a1a",
                  color: "#0f0",
                  padding: 10,
                  borderRadius: 6
                }}
              >
                {debugLog.join("\n")}
              </div>
            ) : (
              <div style={{ fontSize: 13, opacity: 0.6 }}>No log entries yet.</div>
            )}
            <button
              type="button"
              onClick={() => setDebugLog([])}
              style={{
                marginTop: 8,
                border: "1px solid #000",
                background: "#fff",
                padding: "6px 10px",
                borderRadius: 8,
                fontSize: 12
              }}
            >
              Clear Log
            </button>
          </div>
        )}
      </div>

      {/* Cloud State Panel */}
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
              <span style={{ opacity: 0.7 }}>assets:</span> {totalAssetsCount}
            </div>
          </div>
        )}
      </div>

      {/* Settings Panel */}
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
          <div style={{ padding: "0 14px 14px 14px", overflow: "hidden", width: "100%", boxSizing: "border-box" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", overflow: "hidden", width: "100%" }}>
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
              {settingsTab === "ai" && (
                <textarea
                  value={aiRulesDraft}
                  onChange={(e) => setAiRulesDraft(e.target.value)}
                  placeholder="Enter AI rules for analysis..."
                  style={{
                    width: "100%",
                    maxWidth: "100%",
                    minHeight: 180,
                    border: "1px solid rgba(0,0,0,0.35)",
                    borderRadius: 12,
                    padding: 12,
                    fontSize: 13,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    boxSizing: "border-box",
                    display: "block"
                  }}
                />
              )}
              {settingsTab === "schema" && (
                <textarea
                  value={schemaJsonDraft}
                  onChange={(e) => setSchemaJsonDraft(e.target.value)}
                  placeholder='{"levels": {"L1": {...}, "L2": {...}, "L3": {...}}, "categories": ["OVERVIEW", "CHARACTERS", "WORLD", "LORE", "STYLE", "STORY"]}'
                  style={{
                    width: "100%",
                    maxWidth: "100%",
                    minHeight: 180,
                    border: "1px solid rgba(0,0,0,0.35)",
                    borderRadius: 12,
                    padding: 12,
                    fontSize: 13,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    boxSizing: "border-box",
                    display: "block"
                  }}
                />
              )}
              {settingsTab === "tagging" && (
                <textarea
                  value={taggingJsonDraft}
                  onChange={(e) => setTaggingJsonDraft(e.target.value)}
                  placeholder='{"tags": [...]}'
                  style={{
                    width: "100%",
                    maxWidth: "100%",
                    minHeight: 180,
                    border: "1px solid rgba(0,0,0,0.35)",
                    borderRadius: 12,
                    padding: 12,
                    fontSize: 13,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    boxSizing: "border-box",
                    display: "block"
                  }}
                />
              )}
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 18, borderTop: "1px solid rgba(0,0,0,0.2)" }} />

      {/* Extracted Text Panel */}
      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>Extracted Text</div>
          <button
            type="button"
            aria-label={textPanelOpen ? "Collapse text" : "Expand text"}
            onClick={() => setTextPanelOpen((v) => !v)}
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
            <Chevron up={textPanelOpen} />
          </button>
        </div>

        {textPanelOpen && (
          <div style={{ padding: "0 14px 14px 14px" }}>
            {formattedText ? (
              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  maxHeight: 400,
                  overflow: "auto",
                  background: "#f9f9f9",
                  padding: 12,
                  borderRadius: 8,
                  border: "1px solid #ddd"
                }}
              >
                {formattedText}
              </div>
            ) : (
              <div style={{ fontSize: 13, opacity: 0.6 }}>
                Click &quot;View Text&quot; to load and format extracted text.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Projects Panel */}
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
            {projects.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.7 }}>No projects found.</div>
            ) : (
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
            )}
          </div>
        )}
      </div>

      {/* Schema Results Panel */}
      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>
            Schema Results
            {schemaResultsDraft && schemaResultsDraft !== schemaResults && (
              <span style={{ marginLeft: 8, fontSize: 12, color: "#c60", fontWeight: 400 }}>(unsaved)</span>
            )}
          </div>

          <button
            type="button"
            aria-label={schemaResultsOpen ? "Collapse schema results" : "Expand schema results"}
            onClick={() => setSchemaResultsOpen((v) => !v)}
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
            <Chevron up={schemaResultsOpen} />
          </button>
        </div>

        {schemaResultsOpen && (
          <div style={{ padding: "0 14px 14px 14px" }}>
            {schemaResultsDraft ? (
              <>
                <textarea
                  value={schemaResultsDraft}
                  onChange={(e) => setSchemaResultsDraft(e.target.value)}
                  style={{
                    width: "100%",
                    minHeight: 300,
                    fontFamily: "monospace",
                    fontSize: 12,
                    padding: 10,
                    border: "1px solid #ccc",
                    borderRadius: 6,
                    resize: "vertical",
                    boxSizing: "border-box",
                    display: "block",
                    maxWidth: "100%"
                  }}
                />
                <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
                  <button
                    type="button"
                    disabled={schemaSaveBusy || schemaResultsDraft === schemaResults}
                    onClick={() => void saveSchemaResults()}
                    style={{
                      border: "1px solid #000",
                      background: schemaResultsDraft !== schemaResults ? "#000" : "#fff",
                      color: schemaResultsDraft !== schemaResults ? "#fff" : "#000",
                      padding: "8px 16px",
                      borderRadius: 8,
                      opacity: schemaSaveBusy || schemaResultsDraft === schemaResults ? 0.4 : 1
                    }}
                  >
                    {schemaSaveBusy ? "Saving..." : "Save Results"}
                  </button>
                  <button
                    type="button"
                    disabled={schemaResultsDraft === schemaResults}
                    onClick={() => setSchemaResultsDraft(schemaResults)}
                    style={{
                      border: "1px solid #000",
                      background: "#fff",
                      padding: "8px 16px",
                      borderRadius: 8,
                      opacity: schemaResultsDraft === schemaResults ? 0.4 : 1
                    }}
                  >
                    Revert
                  </button>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, opacity: 0.7 }}>
                No schema results yet. Click &quot;7. Fill Schema&quot; to generate.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Assets Panel */}
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
            <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 10 }}>
              {taggedAssetsCount} tagged / {totalAssetsCount} total
            </div>

            {assetsFlat.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.7 }}>—</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
                {assetsFlat.map(({ pageNumber, asset }) => assetCard(pageNumber, asset))}
              </div>
            )}
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

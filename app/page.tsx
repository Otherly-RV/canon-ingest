"use client";

import React, { useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

type Manifest = {
  projectId: string;
  createdAt: string;
  status: "empty" | "uploaded" | "processed";
  sourcePdf?: { url: string; filename: string };
  extractedText?: { url: string };
  pages?: Array<{ pageNumber: number; url: string; width: number; height: number; tags?: string[] }>;
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
    cursor: "pointer"
  });

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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

  const [rasterProgress, setRasterProgress] = useState<{
    running: boolean;
    currentPage: number;
    totalPages: number;
    uploaded: number;
  }>({ running: false, currentPage: 0, totalPages: 0, uploaded: 0 });

  async function loadManifest(url: string) {
    const mRes = await fetch(bust(url), { cache: "no-store" });
    if (!mRes.ok) throw new Error(`Failed to fetch manifest: ${await readErrorText(mRes)}`);
    const m = (await mRes.json()) as Manifest;
    setManifest(m);

    // Load settings drafts from manifest (so UI edits are based on persisted state)
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
    setBusy("Uploading SOURCE (PDF) to Blob...");

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

      const m = await loadManifest(j.manifestUrl);
      if (!m.sourcePdf?.url) throw new Error("Upload finished but manifest has no sourcePdf.url (unexpected).");

      await refreshProjects();
    } finally {
      setBusy("");
    }
  }

  async function processPdf() {
    setLastError("");

    if (!projectId || !manifestUrl) return setLastError("Missing projectId/manifestUrl (upload a PDF first).");
    if (!manifest?.sourcePdf?.url) return setLastError("No source PDF in manifest (upload a PDF first).");
    if (busy) return;

    setBusy("Processing PDF with Document AI...");

    try {
      const r = await fetch("/api/projects/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });

      if (!r.ok) throw new Error(`Process failed (${r.status}): ${await readErrorText(r)}`);

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

    if (!r.ok) throw new Error(`Record page ${pageNumber} failed: ${await readErrorText(r)}`);

    const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
    if (!j.ok || !j.manifestUrl) throw new Error(j.error || `Record page ${pageNumber} failed (bad response)`);

    setManifestUrl(j.manifestUrl);
    setUrlParams(projectId, j.manifestUrl);

    await loadManifest(j.manifestUrl);
  }

  async function rasterizeToPngs() {
    setLastError("");

    if (!projectId || !manifestUrl) return setLastError("Missing projectId/manifestUrl (upload a PDF first).");
    if (!manifest?.sourcePdf?.url) return setLastError("No source PDF in manifest (upload a PDF first).");
    if (busy || rasterProgress.running) return;

    setBusy("Rasterizing PDF pages to PNG (client-side) and uploading directly to Blob...");
    setRasterProgress({ running: true, currentPage: 0, totalPages: 0, uploaded: 0 });

    try {
      const pdfjsImport = (await import("pdfjs-dist")) as unknown;
      const pdfjs = pdfjsImport as PdfJsLib;
      setPdfJsWorker(pdfjs);

      const loadingTask = pdfjs.getDocument({ url: manifest.sourcePdf.url, withCredentials: false });
      const pdf = await loadingTask.promise;

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

  async function deleteProject(targetProjectId: string) {
    const ok = window.confirm(`Delete project ${targetProjectId}? This deletes its PDF, text, pages, manifest.`);
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

      const lower = msg.toLowerCase();
      const looksLike404 = msg.includes("404") || lower.includes("not found");

      if (looksLike404) {
        await refreshProjects();
        setProjectId("");
        setManifestUrl("");
        setManifest(null);
        setAiRulesDraft("");
        setTaggingJsonDraft("");
        clearUrlParams();
      }
    }
  }

  async function saveSettings() {
    setSettingsError("");
    if (!projectId || !manifestUrl) {
      setSettingsError("No active project selected.");
      return;
    }

    // Validate taggingJson before sending
    try {
      JSON.parse(taggingJsonDraft);
    } catch {
      setSettingsError("Tagging JSON is not valid JSON.");
      return;
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
          taggingJson: taggingJsonDraft
        })
      });

      if (!r.ok) throw new Error(await readErrorText(r));

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Save settings failed (bad response)");

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
  const taggedCount = (manifest?.pages ?? []).filter((p) => Array.isArray(p.tags) && p.tags.length > 0).length;

  return (
    <div style={{ minHeight: "100vh", padding: 28 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.3 }}>OTHERLY — Ingest 1.0</div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
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
  disabled={!manifest?.extractedText?.url || !(manifest?.pages?.length && manifest.pages.length > 0) || !!busy}
  onClick={async () => {
    setLastError("");
    if (!projectId || !manifestUrl) return setLastError("Missing projectId/manifestUrl");
    setBusy("Tagging images...");
    try {
      const r = await fetch("/api/projects/tag-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });
      if (!r.ok) throw new Error(await readErrorText(r));
      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Tag images failed (bad response)");

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
    background:
      manifest?.extractedText?.url && manifest?.pages?.length && !busy ? "#000" : "#fff",
    color:
      manifest?.extractedText?.url && manifest?.pages?.length && !busy ? "#fff" : "#000",
    padding: "10px 12px",
    borderRadius: 12,
    opacity:
      manifest?.extractedText?.url && manifest?.pages?.length && !busy ? 1 : 0.4
  }}
>
  Tag images
</button>
        </div>
      </div>

      {!!busy && (
        <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 800 }}>Working</div>
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.8 }}>{busy}</div>
          {rasterProgress.totalPages > 0 && (
            <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
              Raster: page {rasterProgress.currentPage}/{rasterProgress.totalPages} — uploaded {rasterProgress.uploaded}/
              {rasterProgress.totalPages}
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

      {/* Settings panel */}
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
          <div style={{ padding: "0 14px 14px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
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
                  fontWeight: 800
                }}
              >
                {settingsBusy ? "Saving..." : "Save"}
              </button>
            </div>

            {settingsError && (
              <div style={{ marginTop: 10, border: "1px solid #000", borderRadius: 12, padding: 10 }}>
                <div style={{ fontWeight: 800, fontSize: 13 }}>Settings error</div>
                <div style={{ marginTop: 6, fontSize: 13, whiteSpace: "pre-wrap" }}>{settingsError}</div>
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              {settingsTab === "ai" ? (
                <>
                  <textarea
                    value={aiRulesDraft}
                    onChange={(e) => setAiRulesDraft(e.target.value)}
                    placeholder="Write global AI rules..."
                    style={{
                      width: "100%",
                      minHeight: 180,
                      border: "1px solid rgba(0,0,0,0.35)",
                      borderRadius: 12,
                      padding: 12,
                      fontSize: 13,
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                    }}
                  />
                </>
              ) : (
                <>
                  <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 6 }}>
                    Must be valid JSON. This will directly influence image tagging behavior (Step 7.2).
                  </div>
                  <textarea
                    value={taggingJsonDraft}
                    onChange={(e) => setTaggingJsonDraft(e.target.value)}
                    placeholder='{"rules":[...]}'
                    style={{
                      width: "100%",
                      minHeight: 180,
                      border: "1px solid rgba(0,0,0,0.35)",
                      borderRadius: 12,
                      padding: 12,
                      fontSize: 13,
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                    }}
                  />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Projects panel */}
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

      {/* Cloud state panel */}
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
              <span style={{ opacity: 0.7 }}>pages (PNGs):</span> {pagesCount}
            </div>

            <div style={{ marginTop: 6 }}>
              <span style={{ opacity: 0.7 }}>tagged pages:</span> {taggedCount}/{pagesCount}
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

"use client";

import React, { useEffect, useRef, useState } from "react";

type Manifest = {
  projectId: string;
  createdAt: string;
  status: "empty" | "uploaded" | "processed";
  sourcePdf?: { url: string; filename: string };
  extractedText?: { url: string };
  pages?: Array<{ pageNumber: number; url: string; width: number; height: number }>;
};

type PdfJsLib = {
  getDocument: (opts: { url: string; withCredentials?: boolean }) => PdfLoadingTask;
  GlobalWorkerOptions?: { workerSrc: string };
};

type PdfLoadingTask = {
  promise: Promise<PdfDocument>;
};

type PdfDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
};

type PdfPage = {
  getViewport: (opts: { scale: number }) => PdfViewport;
  render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }) => { promise: Promise<void> };
};

type PdfViewport = {
  width: number;
  height: number;
};

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

export default function Page() {
  const fileRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [manifestUrl, setManifestUrl] = useState<string>("");
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [lastError, setLastError] = useState<string>("");

  const [cloudOpen, setCloudOpen] = useState(true);

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
    return m;
  }

  useEffect(() => {
    const { pid, m } = getUrlParams();
    if (pid && m) {
      setProjectId(pid);
      setManifestUrl(m);
      loadManifest(m).catch((e) => setLastError(e instanceof Error ? e.message : String(e)));
    }
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
    } finally {
      setBusy("");
    }
  }

  async function rasterizeToPngs() {
    setLastError("");

    if (!projectId || !manifestUrl) return setLastError("Missing projectId/manifestUrl (upload a PDF first).");
    if (!manifest?.sourcePdf?.url) return setLastError("No source PDF in manifest (upload a PDF first).");
    if (busy || rasterProgress.running) return;

    setBusy("Rasterizing PDF pages to PNG (client-side) and uploading...");
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

        const scale = 2.0; // adjust if you want higher/lower res
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

        const form = new FormData();
        form.append("file", file);
        form.append("projectId", projectId);
        form.append("manifestUrl", manifestUrl);
        form.append("pageNumber", String(pageNumber));
        form.append("width", String(canvas.width));
        form.append("height", String(canvas.height));

        const r = await fetch("/api/projects/pages/upload", { method: "POST", body: form });
        if (!r.ok) throw new Error(`Upload page ${pageNumber} failed: ${await readErrorText(r)}`);

        const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
        if (!j.ok || !j.manifestUrl) throw new Error(j.error || `Upload page ${pageNumber} failed (bad response)`);

        setManifestUrl(j.manifestUrl);
        setUrlParams(projectId, j.manifestUrl);
        await loadManifest(j.manifestUrl);

        setRasterProgress((p) => ({ ...p, uploaded: p.uploaded + 1 }));
      }
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
      setRasterProgress((p) => ({ ...p, running: false }));
    }
  }

  const pagesCount = manifest?.pages?.length ?? 0;

  return (
    <div style={{ minHeight: "100vh", padding: 28 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.3 }}>OTHERLY — Ingest</div>
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.75 }}>
            Step 6: Rasterize PDF → PNG pages → store online in Blob → update manifest
          </div>
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

      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
          <div style={{ fontWeight: 800 }}>Cloud state</div>
          <button
            type="button"
            onClick={() => setCloudOpen((v) => !v)}
            style={{ border: "1px solid #000", background: "#fff", padding: "6px 10px", borderRadius: 10 }}
          >
            {cloudOpen ? "Collapse" : "Expand"}
          </button>
        </div>

        {cloudOpen && (
          <div style={{ padding: "0 14px 14px 14px", fontSize: 13 }}>
            <div><span style={{ opacity: 0.7 }}>projectId:</span> {projectId || "—"}</div>
            <div style={{ marginTop: 6 }}><span style={{ opacity: 0.7 }}>status:</span> {manifest?.status || "—"}</div>

            <div style={{ marginTop: 10 }}><span style={{ opacity: 0.7 }}>manifestUrl:</span></div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>{manifestUrl || "—"}</div>

            <div style={{ marginTop: 10 }}><span style={{ opacity: 0.7 }}>sourcePdf:</span></div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>{manifest?.sourcePdf?.url || "—"}</div>

            <div style={{ marginTop: 10 }}><span style={{ opacity: 0.7 }}>extractedText:</span></div>
            <div style={{ fontSize: 12, wordBreak: "break-all" }}>{manifest?.extractedText?.url || "—"}</div>

            <div style={{ marginTop: 10 }}>
              <span style={{ opacity: 0.7 }}>pages (PNGs):</span> {pagesCount}
            </div>

            {pagesCount > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ opacity: 0.7, marginBottom: 6 }}>First 3 page URLs:</div>
                {(manifest?.pages ?? []).slice(0, 3).map((p) => (
                  <div key={p.pageNumber} style={{ fontSize: 12, wordBreak: "break-all", marginBottom: 6 }}>
                    p{p.pageNumber}: {p.url}
                  </div>
                ))}
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

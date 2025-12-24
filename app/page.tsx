"use client";

import React, { useRef, useState } from "react";

type Manifest = {
  projectId: string;
  createdAt: string;
  status: "empty" | "uploaded" | "processed";
  sourcePdf?: { url: string; filename: string };
  extractedText?: { url: string };
};

async function readErrorText(res: Response) {
  try {
    const t = await res.text();
    return t || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export default function Page() {
  const fileRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [manifestUrl, setManifestUrl] = useState<string>("");
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [lastError, setLastError] = useState<string>("");

  async function loadManifest(url: string) {
    const mRes = await fetch(url, { cache: "no-store" });
    if (!mRes.ok) {
      const t = await readErrorText(mRes);
      throw new Error(`Failed to fetch manifest: ${t}`);
    }
    const m = (await mRes.json()) as Manifest;
    setManifest(m);
    return m;
  }

  async function createProject() {
    const r = await fetch("/api/projects/create", { method: "POST" });
    if (!r.ok) {
      const t = await readErrorText(r);
      throw new Error(`Create project failed: ${t}`);
    }
    const j = (await r.json()) as { ok: boolean; projectId?: string; manifestUrl?: string; error?: string };
    if (!j.ok || !j.projectId || !j.manifestUrl) {
      throw new Error(j.error || "Create project failed (bad response).");
    }

    setProjectId(j.projectId);
    setManifestUrl(j.manifestUrl);
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
      if (!r.ok) {
        const t = await readErrorText(r);
        throw new Error(`Upload failed: ${t}`);
      }

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; sourcePdfUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Upload failed (bad response).");

      setManifestUrl(j.manifestUrl);
      await loadManifest(j.manifestUrl);
    } finally {
      setBusy("");
    }
  }

  async function processPdf() {
    setLastError("");

    if (!projectId || !manifestUrl) {
      setLastError("Missing projectId/manifestUrl (upload a PDF first).");
      return;
    }
    if (!manifest?.sourcePdf) {
      setLastError("No source PDF found in manifest (upload a PDF first).");
      return;
    }
    if (busy) return;

    setBusy("Processing PDF with Document AI...");

    try {
      // Force POST (fixes your 405 if something was calling it as GET)
      const r = await fetch("/api/projects/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });

      if (!r.ok) {
        const t = await readErrorText(r);
        throw new Error(`Process failed (${r.status}): ${t}`);
      }

      const j = (await r.json()) as { ok: boolean; manifestUrl?: string; error?: string };
      if (!j.ok || !j.manifestUrl) throw new Error(j.error || "Process failed (bad response).");

      setManifestUrl(j.manifestUrl);
      await loadManifest(j.manifestUrl);
    } finally {
      setBusy("");
    }
  }

  return (
    <div style={{ minHeight: "100vh", padding: 28 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.3 }}>OTHERLY — Ingest</div>
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.75 }}>
            Upload SOURCE → Process (Document AI) → store extracted text online
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={!!busy}
            style={{
              border: "1px solid #000",
              background: "#fff",
              padding: "10px 12px",
              borderRadius: 12,
              opacity: busy ? 0.6 : 1
            }}
          >
            Upload SOURCE
          </button>

          <button
            onClick={processPdf}
            disabled={!manifest?.sourcePdf || !!busy}
            style={{
              border: "1px solid #000",
              background: manifest?.sourcePdf && !busy ? "#000" : "#fff",
              color: manifest?.sourcePdf && !busy ? "#fff" : "#000",
              padding: "10px 12px",
              borderRadius: 12,
              opacity: manifest?.sourcePdf && !busy ? 1 : 0.4
            }}
          >
            Process
          </button>
        </div>
      </div>

      {!!busy && (
        <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 800 }}>Working</div>
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.8 }}>{busy}</div>
        </div>
      )}

      {!!lastError && (
        <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 800 }}>Error</div>
          <div style={{ marginTop: 6, fontSize: 13, whiteSpace: "pre-wrap" }}>{lastError}</div>
        </div>
      )}

      <div style={{ marginTop: 18, borderTop: "1px solid rgba(0,0,0,0.2)" }} />

      <div style={{ marginTop: 18, border: "1px solid #000", borderRadius: 12, padding: 14 }}>
        <div style={{ fontWeight: 800 }}>Cloud state</div>

        <div style={{ marginTop: 10, fontSize: 13 }}>
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
        </div>
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

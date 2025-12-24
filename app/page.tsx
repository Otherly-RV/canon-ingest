"use client";

import React, { useRef, useState } from "react";

type Manifest = {
  projectId: string;
  createdAt: string;
  status: "empty" | "uploaded" | "processed";
  sourcePdf?: { url: string; filename: string };
  extractedText?: { url: string };
};

export default function Page() {
  const fileRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [manifestUrl, setManifestUrl] = useState<string>("");
  const [manifest, setManifest] = useState<Manifest | null>(null);

  async function createProject() {
    const r = await fetch("/api/projects/create", { method: "POST" });
    const j = await r.json();
    if (!j.ok) throw new Error("Create project failed");

    setProjectId(j.projectId);
    setManifestUrl(j.manifestUrl);

    const mRes = await fetch(j.manifestUrl, { cache: "no-store" });
    const m = (await mRes.json()) as Manifest;
    setManifest(m);

    return { projectId: j.projectId as string, manifestUrl: j.manifestUrl as string };
  }

  async function uploadSource(file: File) {
    setBusy("Uploading SOURCE (PDF) to Blob...");

    try {
      const p = projectId && manifestUrl ? { projectId, manifestUrl } : await createProject();

      const form = new FormData();
      form.append("file", file);
      form.append("projectId", p.projectId);
      form.append("manifestUrl", p.manifestUrl);

      const r = await fetch("/api/projects/upload-source", { method: "POST", body: form });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Upload failed");

      setManifestUrl(j.manifestUrl);

      const mRes = await fetch(j.manifestUrl, { cache: "no-store" });
      const m = (await mRes.json()) as Manifest;
      setManifest(m);
    } finally {
      setBusy("");
    }
  }

  async function processPdf() {
    if (!projectId || !manifestUrl) return;
    if (!manifest?.sourcePdf) return;

    setBusy("Processing PDF with Document AI...");

    try {
      const r = await fetch("/api/projects/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, manifestUrl })
      });

      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Process failed");

      setManifestUrl(j.manifestUrl);

      const mRes = await fetch(j.manifestUrl, { cache: "no-store" });
      const m = (await mRes.json()) as Manifest;
      setManifest(m);
    } finally {
      setBusy("");
    }
  }

  return (
    <div style={{ minHeight: "100vh", padding: 28 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.3 }}>
            OTHERLY — Ingest
          </div>
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.75 }}>
            Step 4: Process SOURCE PDF → Document AI text → store online in Blob
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={() => fileRef.current?.click()}
            style={{
              border: "1px solid #000",
              background: "#fff",
              padding: "10px 12px",
              borderRadius: 12
            }}
          >
            Upload SOURCE
          </button>

          <button
            disabled={!manifest?.sourcePdf || busy !== ""}
            onClick={processPdf}
            style={{
              border: "1px solid #000",
              background: manifest?.sourcePdf ? "#000" : "#fff",
              color: manifest?.sourcePdf ? "#fff" : "#000",
              padding: "10px 12px",
              borderRadius: 12,
              opacity: manifest?.sourcePdf ? 1 : 0.4
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
          await uploadSource(f);
        }}
      />
    </div>
  );
}

import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { newManifest, saveManifest, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function baseUrl(u: string) {
  const url = new URL(u);
  return `${url.origin}${url.pathname}`;
}

async function fetchManifestIfExists(manifestUrlRaw: string): Promise<ProjectManifest | null> {
  const trimmed = manifestUrlRaw.trim();
  if (!trimmed) return null;

  try {
    const url = baseUrl(trimmed);
    const res = await fetch(`${url}?v=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" }
    });

    // IMPORTANT: treat 404/anything non-200 as "missing"
    if (!res.ok) return null;

    const j = (await res.json()) as ProjectManifest;
    if (!j?.projectId) return null;
    return j;
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  const form = await req.formData();

  const file = form.get("file");
  const projectId = String(form.get("projectId") || "").trim();
  const manifestUrlRaw = String(form.get("manifestUrl") || "").trim();

  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "Missing file" }, { status: 400 });
  }
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "Missing projectId" }, { status: 400 });
  }

  // 1) Upload PDF (overwrite stable path)
  const ab = await file.arrayBuffer();
  const source = await put(`projects/${projectId}/source/source.pdf`, ab, {
    access: "public",
    contentType: "application/pdf",
    addRandomSuffix: false
  });

  // 2) Load manifest if it exists; otherwise recreate
  const existing = await fetchManifestIfExists(manifestUrlRaw);
  const manifest: ProjectManifest = existing ?? newManifest(projectId);

  // 3) Update + save manifest
  manifest.sourcePdf = { url: source.url, filename: file.name };
  manifest.status = "uploaded";

  const newUrl = await saveManifest(manifest);

  return NextResponse.json({ ok: true, manifestUrl: newUrl, sourcePdfUrl: source.url });
}

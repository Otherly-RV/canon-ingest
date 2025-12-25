import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { saveManifest, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function baseUrl(u: string) {
  const url = new URL(u);
  return `${url.origin}${url.pathname}`;
}

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  const projectId = String(form.get("projectId") || "");
  const manifestUrlRaw = String(form.get("manifestUrl") || "");

  if (!projectId || !manifestUrlRaw) {
    return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "Missing file" }, { status: 400 });
  }

  // Always fetch manifest with cache-bust
  const manifestUrl = baseUrl(manifestUrlRaw);
  const mRes = await fetch(`${manifestUrl}?v=${Date.now()}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" }
  });

  if (!mRes.ok) {
    return NextResponse.json({ ok: false, error: `Cannot fetch manifest (${mRes.status})` }, { status: 400 });
  }

  const manifest = (await mRes.json()) as ProjectManifest;

  // Store SOURCE PDF in Blob
  const ab = await file.arrayBuffer();
  const pdfBlob = await put(`projects/${projectId}/source/${file.name}`, ab, {
    access: "public",
    contentType: "application/pdf",
    addRandomSuffix: false
  });

  manifest.sourcePdf = { url: pdfBlob.url, filename: file.name };
  manifest.status = "uploaded";

  const newManifestUrl = await saveManifest(manifest);

  return NextResponse.json({
    ok: true,
    sourcePdfUrl: pdfBlob.url,
    manifestUrl: newManifestUrl
  });
}

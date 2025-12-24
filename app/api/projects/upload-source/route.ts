import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { saveManifest, type ProjectManifest } from "@/app/lib/manifest";

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  const projectId = String(form.get("projectId") || "");
  const manifestUrl = String(form.get("manifestUrl") || "");

  if (!projectId || !manifestUrl) {
    return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "Missing file" }, { status: 400 });
  }

  // Load manifest from Blob
  const mRes = await fetch(manifestUrl, { cache: "no-store" });
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

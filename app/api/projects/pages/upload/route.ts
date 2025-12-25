import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { saveManifest, type ProjectManifest, type PageImage } from "@/app/lib/manifest";

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
  const pageNumberStr = String(form.get("pageNumber") || "");
  const widthStr = String(form.get("width") || "");
  const heightStr = String(form.get("height") || "");

  if (!projectId || !manifestUrlRaw || !pageNumberStr) {
    return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl/pageNumber" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "Missing file" }, { status: 400 });
  }

  const pageNumber = Number(pageNumberStr);
  const width = Number(widthStr);
  const height = Number(heightStr);

  if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid pageNumber" }, { status: 400 });
  }

  // Upload PNG
  const ab = await file.arrayBuffer();
  const pngBlob = await put(`projects/${projectId}/pages/page-${pageNumber}.png`, ab, {
    access: "public",
    contentType: "image/png",
    addRandomSuffix: false
  });

  // Fetch manifest (cache-bust)
  const manifestUrl = baseUrl(manifestUrlRaw);
  const mRes = await fetch(`${manifestUrl}?v=${Date.now()}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" }
  });
  if (!mRes.ok) {
    return NextResponse.json({ ok: false, error: `Cannot fetch manifest (${mRes.status})` }, { status: 400 });
  }
  const manifest = (await mRes.json()) as ProjectManifest;

  const pages = Array.isArray(manifest.pages) ? manifest.pages.slice() : [];

  const entry: PageImage = {
    pageNumber,
    url: pngBlob.url,
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0
  };

  const idx = pages.findIndex((p) => p.pageNumber === pageNumber);
  if (idx >= 0) pages[idx] = entry;
  else pages.push(entry);

  pages.sort((a, b) => a.pageNumber - b.pageNumber);

  manifest.pages = pages;

  const newManifestUrl = await saveManifest(manifest);

  return NextResponse.json({
    ok: true,
    pageNumber,
    pageUrl: pngBlob.url,
    manifestUrl: newManifestUrl
  });
}

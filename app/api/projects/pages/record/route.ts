import { NextResponse } from "next/server";
import { saveManifest, type ProjectManifest, type PageImage } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  projectId?: string;
  manifestUrl?: string;
  pageNumber?: number;
  url?: string;
  width?: number;
  height?: number;
};

function baseUrl(u: string) {
  const url = new URL(u);
  return `${url.origin}${url.pathname}`;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = body.projectId;
  const manifestUrlRaw = body.manifestUrl;
  const pageNumber = body.pageNumber;
  const url = body.url;

  if (!projectId || !manifestUrlRaw || !pageNumber || !url) {
    return NextResponse.json(
      { ok: false, error: "Missing projectId/manifestUrl/pageNumber/url" },
      { status: 400 }
    );
  }

  const width = Number(body.width ?? 0);
  const height = Number(body.height ?? 0);

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
    url,
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0
  };

  const idx = pages.findIndex((p) => p.pageNumber === pageNumber);
  if (idx >= 0) pages[idx] = entry;
  else pages.push(entry);

  pages.sort((a, b) => a.pageNumber - b.pageNumber);

  manifest.pages = pages;

  const newManifestUrl = await saveManifest(manifest);

  return NextResponse.json({ ok: true, manifestUrl: newManifestUrl, pageNumber, url });
}

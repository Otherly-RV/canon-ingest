import { NextResponse } from "next/server";
import { saveManifest, type ProjectManifest } from "@/app/lib/manifest";

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

async function fetchManifest(manifestUrlRaw: string): Promise<ProjectManifest> {
  const url = baseUrl(manifestUrlRaw);
  const res = await fetch(`${url}?v=${Date.now()}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" }
  });
  if (!res.ok) throw new Error(`Cannot fetch manifest (${res.status})`);
  return (await res.json()) as ProjectManifest;
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = String(body.projectId || "").trim();
  const manifestUrl = String(body.manifestUrl || "").trim();
  const pageNumber = Number(body.pageNumber || 0);
  const url = String(body.url || "").trim();
  const width = Number(body.width || 0);
  const height = Number(body.height || 0);

  if (!projectId || !manifestUrl || !pageNumber || !url || !width || !height) {
    return NextResponse.json({ ok: false, error: "Missing fields" }, { status: 400 });
  }

  const manifest = await fetchManifest(manifestUrl);
  if (manifest.projectId !== projectId) {
    return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
  }

  if (!Array.isArray(manifest.pages)) manifest.pages = [];

  const idx = manifest.pages.findIndex((p) => p.pageNumber === pageNumber);
  const page = { pageNumber, url, width, height };

  if (idx >= 0) manifest.pages[idx] = { ...manifest.pages[idx], ...page };
  else manifest.pages.push(page);

  manifest.pages.sort((a, b) => a.pageNumber - b.pageNumber);

  const newManifestUrl = await saveManifest(manifest);
  return NextResponse.json({ ok: true, manifestUrl: newManifestUrl });
}

import { NextResponse } from "next/server";
import { saveManifest, fetchManifestDirect, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AssetBBox = { x: number; y: number; w: number; h: number };

type Body = {
  projectId?: string;
  manifestUrl?: string;
  pageNumber?: number;
  assetId?: string;
  url?: string;
  bbox?: AssetBBox;
};

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
  const assetId = String(body.assetId || "").trim();
  const url = String(body.url || "").trim();
  const bbox = body.bbox;

  if (!projectId || !manifestUrl || !pageNumber || !assetId || !url || !bbox) {
    return NextResponse.json({ ok: false, error: "Missing fields" }, { status: 400 });
  }

  // Re-fetch latest manifest before saving to avoid resurrecting deleted assets
  const latest = await fetchManifestDirect(manifestUrl);
  if (latest.projectId !== projectId) {
    return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
  }
  if (!Array.isArray(latest.pages)) {
    return NextResponse.json({ ok: false, error: "Manifest has no pages[]" }, { status: 400 });
  }
  const page = latest.pages.find((p) => p.pageNumber === pageNumber);
  if (!page) {
    return NextResponse.json({ ok: false, error: `Page ${pageNumber} not found` }, { status: 400 });
  }
  // Respect tombstones: never resurrect a deleted assetId.
  if (Array.isArray(page.deletedAssetIds) && page.deletedAssetIds.includes(assetId)) {
    return NextResponse.json({ ok: true, manifestUrl });
  }
  if (!Array.isArray(page.assets)) page.assets = [];
  const idx = page.assets.findIndex((a) => a.assetId === assetId);
  const asset = { assetId, url, bbox };
  if (idx >= 0) page.assets[idx] = asset;
  else page.assets.push(asset);
  // Final filter: never keep assets with tombstoned assetIds
  if (Array.isArray(page.deletedAssetIds)) {
    const deleted = new Set(page.deletedAssetIds);
    page.assets = page.assets.filter((a) => !deleted.has(a.assetId));
  }
  const newManifestUrl = await saveManifest(latest);
  return NextResponse.json({ ok: true, manifestUrl: newManifestUrl });
}

import { NextResponse } from "next/server";
import { list } from "@vercel/blob";
import { saveManifest, fetchManifestDirect, type ProjectManifest, type PageImage, type PageAsset, type AssetBBox } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  projectId?: string;
  manifestUrl?: string;
};

function baseUrl(u: string) {
  const url = new URL(u);
  return `${url.origin}${url.pathname}`;
}

async function readErrorText(res: Response) {
  try {
    const t = await res.text();
    return t || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

type ListResult = {
  blobs: Array<{ url: string; pathname: string }>;
  cursor?: string;
};

async function listAll(prefix: string): Promise<Array<{ url: string; pathname: string }>> {
  const out: Array<{ url: string; pathname: string }> = [];
  let cursor: string | undefined = undefined;

  for (;;) {
    const page = (await list({ prefix, limit: 1000, cursor })) as unknown;
    const p = page as ListResult;

    if (Array.isArray(p.blobs)) {
      for (const b of p.blobs) {
        if (b && typeof b.url === "string" && typeof b.pathname === "string") out.push(b);
      }
    }

    if (!p.cursor) break;
    cursor = p.cursor;
  }

  return out;
}

function parsePageNumberFromPath(pathname: string): number | null {
  // projects/{id}/pages/page-12.png
  const m = pathname.match(/\/pages\/page-(\d+)\.png$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseAssetFromPath(pathname: string): { pageNumber: number; assetId: string } | null {
  // projects/{id}/assets/p12/p12-img03.png
  const m = pathname.match(/\/assets\/p(\d+)\/(p\d+-img\d+)\.png$/i);
  if (!m) return null;
  const pageNumber = Number(m[1]);
  const assetId = String(m[2]);
  if (!Number.isFinite(pageNumber) || pageNumber <= 0) return null;
  return { pageNumber, assetId };
}

const ZERO_BBOX: AssetBBox = { x: 0, y: 0, w: 0, h: 0 };

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as Body;
    const projectId = String(body.projectId || "").trim();
    const manifestUrl = String(body.manifestUrl || "").trim();

    if (!projectId || !manifestUrl) {
      return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl" }, { status: 400 });
    }

    const manifest = await fetchManifest(manifestUrl);

    if (manifest.projectId !== projectId) {
      return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
    }

    const pagesPrefix = `projects/${projectId}/pages/`;
    const assetsPrefix = `projects/${projectId}/assets/`;

    const pageBlobs = await listAll(pagesPrefix);
    const assetBlobs = await listAll(assetsPrefix);

    const pagesByNumber = new Map<number, PageImage>();

    // Start from existing manifest pages (if any)
    if (Array.isArray(manifest.pages)) {
      for (const p of manifest.pages) {
        if (p && Number.isFinite(p.pageNumber)) {
          pagesByNumber.set(p.pageNumber, p);
        }
      }
    }

    // Ensure pages exist for each page PNG blob
    for (const b of pageBlobs) {
      const pageNumber = parsePageNumberFromPath(b.pathname);
      if (!pageNumber) continue;

      const existing = pagesByNumber.get(pageNumber);
      if (existing) {
        // If url missing, set it
        if (!existing.url) existing.url = b.url;
      } else {
        pagesByNumber.set(pageNumber, {
          pageNumber,
          url: b.url,
          width: 0,
          height: 0,
          assets: []
        });
      }
    }

    // Add assets if missing, but never re-add tombstoned assetIds
    for (const b of assetBlobs) {
      const parsed = parseAssetFromPath(b.pathname);
      if (!parsed) continue;

      // Check tombstone
      const page = pagesByNumber.get(parsed.pageNumber);
      const deleted = page && Array.isArray(page.deletedAssetIds) ? new Set(page.deletedAssetIds) : new Set();
      if (deleted.has(parsed.assetId)) continue;

      if (!page) {
        pagesByNumber.set(parsed.pageNumber, {
          pageNumber: parsed.pageNumber,
          url: "",
          width: 0,
          height: 0,
          assets: [{ assetId: parsed.assetId, url: b.url, bbox: { ...ZERO_BBOX } }],
          deletedAssetIds: []
        });
        continue;
      }

      if (!Array.isArray(page.assets)) page.assets = [];

      const already = page.assets.some((a: PageAsset) => a.assetId === parsed.assetId);
      if (!already) {
        page.assets.push({
          assetId: parsed.assetId,
          url: b.url,
          bbox: { ...ZERO_BBOX }
        });
      } else {
        // If exists but url missing, repair url
        const idx = page.assets.findIndex((a: PageAsset) => a.assetId === parsed.assetId);
        if (idx >= 0 && page.assets[idx] && !page.assets[idx].url) page.assets[idx].url = b.url;
      }
    }

    // Re-fetch latest manifest to avoid race conditions
    const latest = await fetchManifestDirect(manifestUrl);
    if (latest.projectId !== projectId) {
      return NextResponse.json({ ok: false, error: "projectId does not match manifest on re-fetch" }, { status: 400 });
    }

    // Merge restored assets into latest manifest
    const latestPagesByNumber = new Map<number, PageImage>();
    if (Array.isArray(latest.pages)) {
      for (const p of latest.pages) latestPagesByNumber.set(p.pageNumber, p);
    } else {
      latest.pages = [];
    }

    for (const [pageNumber, p] of pagesByNumber) {
      let latestPage = latestPagesByNumber.get(pageNumber);
      if (!latestPage) {
        latestPage = {
          pageNumber,
          url: p.url,
          width: p.width,
          height: p.height,
          assets: [],
          deletedAssetIds: []
        };
        latest.pages.push(latestPage);
        latestPagesByNumber.set(pageNumber, latestPage);
      }

      if (!Array.isArray(latestPage.assets)) latestPage.assets = [];
      const deleted = new Set(Array.isArray(latestPage.deletedAssetIds) ? latestPage.deletedAssetIds : []);

      // Only add assets that are NOT in the latest tombstone list
      if (Array.isArray(p.assets)) {
        for (const a of p.assets) {
          if (deleted.has(a.assetId)) continue;
          
          const existingIdx = latestPage.assets.findIndex((x) => x.assetId === a.assetId);
          if (existingIdx >= 0) {
             // Update existing
             if (!latestPage.assets[existingIdx].url) latestPage.assets[existingIdx].url = a.url;
          } else {
             // Add new
             latestPage.assets.push(a);
          }
        }
      }
    }
    
    latest.pages.sort((a, b) => a.pageNumber - b.pageNumber);

    // Add debug log
    if (!Array.isArray(latest.debugLog)) latest.debugLog = [];
    const timestamp = new Date().toISOString();
    latest.debugLog.unshift(`[${timestamp}] RESTORE: Restored assets. Found ${assetBlobs.length} blobs.`);
    if (latest.debugLog.length > 50) latest.debugLog = latest.debugLog.slice(0, 50);

    const newManifestUrl = await saveManifest(latest);

    return NextResponse.json({
      ok: true,
      manifestUrl: newManifestUrl,
      pagesFound: pageBlobs.length,
      assetsFound: assetBlobs.length,
      pagesInManifest: latest.pages?.length ?? 0
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

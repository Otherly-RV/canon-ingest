import { NextResponse } from "next/server";
import { list } from "@vercel/blob"; 
import { saveManifest, type ProjectManifest, type PageAsset } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  projectId?: string;
  manifestUrl?: string;
};

type ListResult = {
  blobs: Array<{ url: string; pathname?: string }>;
  cursor?: string | null;
};

/**
 * FIX 1: Direct Origin Read
 * Instead of SDK 'get', we use fetch with headers that force Vercel 
 * to bypass the Edge Network and hit the blob storage directly.
 */
async function fetchManifestDirect(url: string): Promise<ProjectManifest> {
  const cacheBuster = `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`;
  
  const res = await fetch(cacheBuster, { 
    cache: "no-store",
    headers: {
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to read manifest directly: ${res.statusText}`);
  }
  
  return (await res.json()) as ProjectManifest;
}

function parseAssetPath(pathname: string) {
  const m = pathname.match(/^projects\/[^/]+\/assets\/p(\d+)\/(p\d+-img\d+)/);
  if (!m) return null;
  const pageNumber = Number(m[1]);
  const assetId = m[2];
  return { pageNumber, assetId };
}

export async function POST(req: Request): Promise<Response> {
  try {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const projectId = (body.projectId || "").trim();
    const manifestUrl = (body.manifestUrl || "").trim();

    if (!projectId || !manifestUrl) {
      return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl" }, { status: 400 });
    }

    // Use the direct fetch to avoid CDN ghosting
    const manifest = await fetchManifestDirect(manifestUrl);
    
    if (manifest.projectId !== projectId) {
      return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
    }

    if (!Array.isArray(manifest.pages)) manifest.pages = [];
    const prefix = `projects/${projectId}/assets/`;
    const found = new Map<string, { pageNumber: number; assetId: string; url: string }>();

    let cursor: string | undefined = undefined;
    for (;;) {
      const page = (await list({ prefix, limit: 1000, cursor })) as unknown as ListResult;

      for (const b of page.blobs) {
        const pathname = b.pathname || "";
        const parsed = parseAssetPath(pathname);
        if (!parsed) continue;

        const url = b.url || "";
        if (!url) continue;

        const key = `${parsed.pageNumber}::${parsed.assetId}`;
        const prev = found.get(key);
        if (!prev) found.set(key, { pageNumber: parsed.pageNumber, assetId: parsed.assetId, url });
        else {
          const pick = url.length >= prev.url.length ? url : prev.url;
          found.set(key, { pageNumber: parsed.pageNumber, assetId: parsed.assetId, url: pick });
        }
      }

      const next = page.cursor ?? undefined;
      cursor = typeof next === "string" && next.length > 0 ? next : undefined;
      if (!cursor) break;
    }

    const foundByPage = new Map<number, Array<{ assetId: string; url: string }>>();
    for (const item of found.values()) {
      const arr = foundByPage.get(item.pageNumber) ?? [];
      arr.push({ assetId: item.assetId, url: item.url });
      foundByPage.set(item.pageNumber, arr);
    }

    // Re-fetch latest manifest to avoid race conditions
    const latest = await fetchManifest(manifestUrl);
    if (latest.projectId !== projectId) {
      return NextResponse.json({ ok: false, error: "projectId does not match manifest on re-fetch" }, { status: 400 });
    }

    if (!Array.isArray(latest.pages)) latest.pages = [];

    // Ensure pages exist in latest manifest
    for (const pageNumber of foundByPage.keys()) {
      if (!latest.pages.find(p => p.pageNumber === pageNumber)) {
        latest.pages.push({ pageNumber, url: "", width: 0, height: 0, assets: [] });
      }
    }

    latest.pages.sort((a, b) => a.pageNumber - b.pageNumber);

    for (const p of latest.pages) {
      const blobAssetsAll = foundByPage.get(p.pageNumber) ?? [];
      const deleted = new Set<string>(Array.isArray(p.deletedAssetIds) ? p.deletedAssetIds : []);

      // Verify assets exist and strictly filter out tombstoned assetIds
      const verifiedAssets = [];
      for (const ba of blobAssetsAll) {
        if (deleted.has(ba.assetId)) continue;
        // We already verified HEAD in the previous loop? No, we didn't.
        // Wait, the previous code did HEAD check inside the loop over manifest.pages.
        // We should do it here too.
        const check = await fetch(ba.url, { method: 'HEAD', cache: 'no-store' });
        if (check.status !== 404) {
          verifiedAssets.push(ba);
        }
      }

      const existingById = new Map<string, PageAsset>();
      for (const a of (p.assets || [])) existingById.set(a.assetId, a);

      // Final filter: never re-add tombstoned assetIds
      p.assets = verifiedAssets
        .filter((ba) => !deleted.has(ba.assetId))
        .map((ba) => {
          const prev = existingById.get(ba.assetId);
          return {
            assetId: ba.assetId,
            url: ba.url,
            bbox: prev?.bbox ?? { x: 0, y: 0, w: 0, h: 0 },
            tags: prev?.tags
          };
        })
        .sort((a, b) => a.assetId.localeCompare(b.assetId));
    }

    const newManifestUrl = await saveManifest(latest);

    return NextResponse.json({
      ok: true,
      manifestUrl: newManifestUrl
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

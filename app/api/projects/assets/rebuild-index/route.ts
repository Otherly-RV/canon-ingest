import { NextResponse } from "next/server";
import { list, get } from "@vercel/blob"; // Added 'get' for direct origin reads
import { saveManifest, type ProjectManifest, type PageAsset, type AssetBBox } from "@/app/lib/manifest";

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
 * FIX 1: Bypass the CDN/Edge Cache.
 * Reading directly from the storage origin ensures we don't start with 
 * a stale version of the manifest.
 */
async function fetchManifestDirect(url: string): Promise<ProjectManifest> {
  try {
    const { body } = await get(url); // Direct SDK read from Blob origin
    const content = await new Response(body).json();
    return content as ProjectManifest;
  } catch (error) {
    throw new Error(`Failed to read manifest directly from Blob storage: ${error}`);
  }
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

    // Use the direct fetch instead of URL fetch to avoid CDN ghosting
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

    for (const pageNumber of foundByPage.keys()) {
      if (!manifest.pages.find(p => p.pageNumber === pageNumber)) {
        manifest.pages.push({ pageNumber, url: "", width: 0, height: 0, assets: [] });
      }
    }

    manifest.pages.sort((a, b) => a.pageNumber - b.pageNumber);

    let pagesTouched = 0;
    let totalAssetsAfter = 0;

    for (const p of manifest.pages) {
      const blobAssetsAll = foundByPage.get(p.pageNumber) ?? [];
      const deleted = new Set<string>(Array.isArray(p.deletedAssetIds) ? p.deletedAssetIds : []);

      /**
       * FIX 2: Verify Assets with HEAD Requests.
       * Even if 'list()' finds the file, the CDN might still be propagating the deletion.
       * Checking the status ensures we don't re-index a file that is actually gone.
       */
      const verifiedAssets = [];
      for (const ba of blobAssetsAll) {
        if (deleted.has(ba.assetId)) continue;

        // Fast HEAD request to verify file existence
        const check = await fetch(ba.url, { method: 'HEAD', cache: 'no-store' });
        if (check.status !== 404) {
          verifiedAssets.push(ba);
        }
      }

      const existingById = new Map<string, PageAsset>();
      for (const a of (p.assets || [])) existingById.set(a.assetId, a);

      p.assets = verifiedAssets
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

      pagesTouched += 1;
      totalAssetsAfter += p.assets.length;
    }

    const newManifestUrl = await saveManifest(manifest);

    return NextResponse.json({
      ok: true,
      manifestUrl: newManifestUrl,
      pagesTouched,
      totalAssetsAfter
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

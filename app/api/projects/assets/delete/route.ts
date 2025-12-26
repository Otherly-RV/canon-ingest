import { NextResponse } from "next/server";
import { del, list } from "@vercel/blob";
import { saveManifest, fetchManifestDirect, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  projectId?: string;
  manifestUrl?: string;
  pageNumber?: number;
  assetId?: string; // e.g. "p13-img05"
};

type ListResult = {
  blobs: Array<{ url: string; pathname?: string }>;
  cursor?: string | null;
};

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
    const assetId = (body.assetId || "").trim();
    const pageNumber = Number(body.pageNumber);

    if (!projectId || !manifestUrl || !assetId || !Number.isFinite(pageNumber)) {
      return NextResponse.json(
        { ok: false, error: "Missing projectId/manifestUrl/pageNumber/assetId" },
        { status: 400 }
      );
    }

    // Use direct fetch to avoid cache
    const manifest = await fetchManifestDirect(manifestUrl);
    if (manifest.projectId !== projectId) {
      return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
    }

    const urlsToDelete: string[] = [];

    // 1) Delete the exact URL referenced by the manifest (covers .png/.jpg/etc).
    // This is the most reliable deletion path.
    const pageEntry = Array.isArray(manifest.pages)
      ? manifest.pages.find((x) => x.pageNumber === pageNumber)
      : undefined;
    const assetEntry = pageEntry?.assets?.find((a) => a.assetId === assetId);
    if (assetEntry?.url) urlsToDelete.push(assetEntry.url);

    // 2) Also delete any variants under the folder (handles duplicates / random suffixes)
    const prefix = `projects/${projectId}/assets/p${pageNumber}/`;

    let cursor: string | undefined = undefined;
    for (;;) {
      const page = (await list({ prefix, limit: 1000, cursor })) as unknown as ListResult;

      for (const b of page.blobs) {
        const pathname = typeof b.pathname === "string" ? b.pathname : "";
        // match: .../p13-img05*.(png|jpg|jpeg|webp) or any extension.
        // We intentionally do NOT filter by extension to avoid "delete then resurrect".
        if (pathname.includes(`/${assetId}`)) {
          if (typeof b.url === "string" && b.url) urlsToDelete.push(b.url);
        }
      }

      const next = page.cursor ?? undefined;
      cursor = typeof next === "string" && next.length > 0 ? next : undefined;
      if (!cursor) break;
    }

    // De-dupe URLs before delete
    const uniqUrls = Array.from(new Set(urlsToDelete));
    if (uniqUrls.length > 0) await del(uniqUrls);

    // Re-fetch latest manifest to avoid race conditions
    const latest = await fetchManifestDirect(manifestUrl);
    if (latest.projectId !== projectId) {
      throw new Error("projectId does not match manifest on re-fetch");
    }

    // Add debug log
    if (!Array.isArray(latest.debugLog)) latest.debugLog = [];
    const timestamp = new Date().toISOString();
    
    // Remove from manifest + tombstone it (prevents later background saves from resurrecting it)
    let foundPage = false;
    let foundAsset = false;
    let tombstoneAdded = false;

    if (Array.isArray(latest.pages)) {
      const p = latest.pages.find((x) => x.pageNumber === pageNumber);
      if (p) {
        foundPage = true;
        if (Array.isArray(p.assets)) {
           const initialLen = p.assets.length;
           p.assets = p.assets.filter((a) => a.assetId !== assetId);
           if (p.assets.length < initialLen) foundAsset = true;
        }
        if (!Array.isArray(p.deletedAssetIds)) p.deletedAssetIds = [];
        if (!p.deletedAssetIds.includes(assetId)) {
          p.deletedAssetIds.push(assetId);
          tombstoneAdded = true;
        }
      }
    }

    latest.debugLog.unshift(`[${timestamp}] DELETE ${assetId} (p${pageNumber}). Blobs: ${uniqUrls.length}. PageFound: ${foundPage}. AssetFound: ${foundAsset}. Tombstone: ${tombstoneAdded}.`);
    // Keep log size manageable
    if (latest.debugLog.length > 50) latest.debugLog = latest.debugLog.slice(0, 50);

    const newManifestUrl = await saveManifest(latest);

    return NextResponse.json({
      ok: true,
      manifestUrl: newManifestUrl,
      deletedCount: uniqUrls.length
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

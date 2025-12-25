import { NextResponse } from "next/server";
import { list } from "@vercel/blob";
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

async function fetchManifest(manifestUrlRaw: string): Promise<ProjectManifest> {
  const url = `${baseUrl(manifestUrlRaw)}?v=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Cannot fetch manifest (${res.status}): ${await readErrorText(res)}`);
  return (await res.json()) as ProjectManifest;
}

function parseAssetPath(pathname: string) {
  // projects/{pid}/assets/p{N}/p{N}-imgXX*.png  -> assetId = p{N}-imgXX
  const m = pathname.match(/^projects\/[^/]+\/assets\/p(\d+)\/(p\d+-img\d+)/);
  if (!m) return null;
  const pageNumber = Number(m[1]);
  const assetId = m[2];
  if (!Number.isFinite(pageNumber)) return null;
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

    const manifest = await fetchManifest(manifestUrl);
    if (manifest.projectId !== projectId) {
      return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
    }

    if (!Array.isArray(manifest.pages)) manifest.pages = [];

    const prefix = `projects/${projectId}/assets/`;

    // Build authoritative map from Blob: (pageNumber::assetId) -> url
    const found = new Map<string, { pageNumber: number; assetId: string; url: string }>();

    let cursor: string | undefined = undefined;
    for (;;) {
      const page = (await list({ prefix, limit: 1000, cursor })) as unknown as ListResult;

      for (const b of page.blobs) {
        const pathname = typeof b.pathname === "string" ? b.pathname : "";
        const parsed = parseAssetPath(pathname);
        if (!parsed) continue;

        const url = typeof b.url === "string" ? b.url : "";
        if (!url) continue;

        const key = `${parsed.pageNumber}::${parsed.assetId}`;

        // choose a deterministic winner if duplicates exist
        const prev = found.get(key);
        if (!prev) found.set(key, { pageNumber: parsed.pageNumber, assetId: parsed.assetId, url });
        else {
          const pick =
            url.length > prev.url.length ? url : url.length < prev.url.length ? prev.url : url > prev.url ? url : prev.url;
          found.set(key, { pageNumber: parsed.pageNumber, assetId: parsed.assetId, url: pick });
        }
      }

      const next = page.cursor ?? undefined;
      cursor = typeof next === "string" && next.length > 0 ? next : undefined;
      if (!cursor) break;
    }

    // pageNumber -> [{assetId,url}]
    const foundByPage = new Map<number, Array<{ assetId: string; url: string }>>();
    for (const item of found.values()) {
      const arr = foundByPage.get(item.pageNumber) ?? [];
      arr.push({ assetId: item.assetId, url: item.url });
      foundByPage.set(item.pageNumber, arr);
    }

    // Ensure manifest has page entries for any pages that exist in Blob
    const existingPages = new Set<number>(manifest.pages.map((p) => p.pageNumber));
    for (const pageNumber of foundByPage.keys()) {
      if (!existingPages.has(pageNumber)) {
        manifest.pages.push({ pageNumber, url: "", width: 0, height: 0, assets: [] });
      }
    }

    // Keep pages sorted
    manifest.pages.sort((a, b) => a.pageNumber - b.pageNumber);

    // Replace assets for EVERY page (authoritative). If Blob has none -> assets becomes []
    let pagesTouched = 0;
    let removedStale = 0;
    let totalAssetsAfter = 0;

    for (const p of manifest.pages) {
      const blobAssets = foundByPage.get(p.pageNumber) ?? [];

      const existing = Array.isArray(p.assets) ? p.assets : [];
      const existingById = new Map<string, PageAsset>();
      for (const a of existing) existingById.set(a.assetId, a);

      const nextAssets: PageAsset[] = blobAssets
        .map((ba) => {
          const prev = existingById.get(ba.assetId);
          const bbox: AssetBBox = prev?.bbox ?? { x: 0, y: 0, w: 0, h: 0 };
          const tags = Array.isArray(prev?.tags) ? prev!.tags : undefined;
          return { assetId: ba.assetId, url: ba.url, bbox, tags };
        })
        .sort((a, b) => a.assetId.localeCompare(b.assetId));

      // count stale removals (manifest had more than blob)
      if (existing.length > nextAssets.length) removedStale += existing.length - nextAssets.length;

      p.assets = nextAssets;
      pagesTouched += 1;
      totalAssetsAfter += nextAssets.length;
    }

    const newManifestUrl = await saveManifest(manifest);

    return NextResponse.json({
      ok: true,
      manifestUrl: newManifestUrl,
      foundKeys: found.size,
      pagesTouched,
      removedStale,
      totalAssetsAfter
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { list } from "@vercel/blob";
import {
  saveManifest,
  type ProjectManifest,
  type PageAsset,
} from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  projectId?: string;
  manifestUrl?: string;
  pngOnly?: boolean; // optional, default true
};

type ListResult = {
  blobs: Array<{ url: string; pathname?: string }>;
  cursor?: string | null;
};

// Extend your page shape locally to include tombstones safely without `any`
type ManifestPageWithDeletes = ProjectManifest["pages"][number] & {
  deletedAssetIds?: string[];
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

/**
 * Read manifest with no-store + cachebuster.
 * NOTE: this avoids Next/browsers caching; it does not guarantee bypassing edge caches.
 */
async function readManifest(manifestUrl: string): Promise<ProjectManifest> {
  const url = `${manifestUrl}${manifestUrl.includes("?") ? "&" : "?"}v=${Date.now()}`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to read manifest: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as ProjectManifest;
}

function parseAssetPath(pathname: string) {
  // projects/{projectId}/assets/p{page}/p{page}-img{n}.png
  const m = pathname.match(
    /^projects\/[^/]+\/assets\/p(\d+)\/(p\d+-img\d+)(\.[a-zA-Z0-9]+)?$/
  );
  if (!m) return null;
  return {
    pageNumber: Number(m[1]),
    assetId: m[2],
    ext: (m[3] || "").toLowerCase(), // ".png" etc
  };
}

function pickPreferredUrl(a: string, b: string) {
  // stable deterministic choice for duplicates
  return a >= b ? a : b;
}

export async function POST(req: Request): Promise<Response> {
  try {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const projectId = (body.projectId || "").trim();
    const manifestUrl = (body.manifestUrl || "").trim();
    const pngOnly = body.pngOnly ?? true;

    if (!projectId || !manifestUrl) {
      return jsonError("Missing projectId/manifestUrl", 400);
    }

    const manifest = await readManifest(manifestUrl);

    if ((manifest.projectId || "").trim() !== projectId) {
      return jsonError("projectId does not match manifest", 400);
    }

    if (!Array.isArray(manifest.pages)) manifest.pages = [];

    // --- 1) List blobs and build a map page->assetId->url ---
    const prefix = `projects/${projectId}/assets/`;
    const found = new Map<
      string,
      { pageNumber: number; assetId: string; url: string }
    >();

    let cursor: string | undefined = undefined;
    for (;;) {
      const page = (await list({ prefix, limit: 1000, cursor })) as unknown as ListResult;

      for (const b of page.blobs) {
        const pathname = b.pathname || "";
        const parsed = parseAssetPath(pathname);
        if (!parsed) continue;

        if (pngOnly && parsed.ext && parsed.ext !== ".png") continue;

        const url = b.url || "";
        if (!url) continue;

        const key = `${parsed.pageNumber}::${parsed.assetId}`;
        const prev = found.get(key);
        if (!prev) {
          found.set(key, { pageNumber: parsed.pageNumber, assetId: parsed.assetId, url });
        } else {
          found.set(key, {
            pageNumber: parsed.pageNumber,
            assetId: parsed.assetId,
            url: pickPreferredUrl(prev.url, url),
          });
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

    // --- 2) Ensure manifest has page entries for found pages ---
    for (const pageNumber of foundByPage.keys()) {
      if (!manifest.pages.some((p) => p.pageNumber === pageNumber)) {
        // create a minimal page entry; include deletedAssetIds explicitly
        manifest.pages.push({
          pageNumber,
          url: "",
          width: 0,
          height: 0,
          assets: [],
          deletedAssetIds: [],
        } as ManifestPageWithDeletes);
      }
    }

    manifest.pages.sort((a, b) => a.pageNumber - b.pageNumber);

    // --- 3) Rebuild each page while respecting tombstones and preserving bbox/tags ---
    manifest.pages = manifest.pages.map((rawPage) => {
      const p = rawPage as ManifestPageWithDeletes;

      const blobAssetsAll = foundByPage.get(p.pageNumber) ?? [];

      const deletedAssetIds = Array.isArray(p.deletedAssetIds) ? p.deletedAssetIds : [];
      const deleted = new Set<string>(deletedAssetIds);

      const existingById = new Map<string, PageAsset>();
      for (const a of p.assets || []) existingById.set(a.assetId, a);

      const blobAssets = blobAssetsAll.filter((ba) => !deleted.has(ba.assetId));

      const rebuiltAssets: PageAsset[] = blobAssets
        .map((ba) => {
          const prev = existingById.get(ba.assetId);
          const nextAsset: PageAsset = {
            assetId: ba.assetId,
            url: ba.url,
            bbox: prev?.bbox ?? { x: 0, y: 0, w: 0, h: 0 },
            tags: prev?.tags,
          };
          return nextAsset;
        })
        .sort((a, b) => a.assetId.localeCompare(b.assetId));

      return {
        ...p,
        assets: rebuiltAssets,
        deletedAssetIds: Array.from(deleted).sort(),
      };
    });

    const newManifestUrl = await saveManifest(manifest);

    return NextResponse.json({ ok: true, manifestUrl: newManifestUrl });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

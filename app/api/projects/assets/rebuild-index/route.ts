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
  // expected:
  // projects/{pid}/assets/p{N}/p{N}-imgXX*.png
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

    // (pageNumber::assetId) -> url
    const found = new Map<string, { pageNumber: number; assetId: string; url: string }>();

    let cursor: string | undefined = undefined;
    for (;;) {
      const page = (await list({ prefix, limit: 1000, cursor })) as unknown as ListResult;

      for (const b of page.blobs) {
        const pathname = typeof b.pathname === "string" ? b.pathname : "";
        const parsed = parseAssetPath(pathname);
        if (!parsed) continue;

        const key = `${parsed.pageNumber}::${parsed.assetId}`;
        const url = typeof b.url === "string" ? b.url : "";
        if (!url) continue;

        // Keep the "latest" deterministically (good enough). We just need a stable pick.
        const prev = found.get(key);
        if (!prev || url > prev.url) found.set(key, { pageNumber: parsed.pageNumber, assetId: parsed.assetId, url });
      }

      const next = page.cursor ?? undefined;
      cursor = typeof next === "string" && next.length > 0 ? next : undefined;
      if (!cursor) break;
    }

    const pagesByNumber = new Map<number, (typeof manifest.pages)[number]>();
    for (const p of manifest.pages) pagesByNumber.set(p.pageNumber, p);

    let added = 0;

    // Merge results into manifest.pages[].assets
    for (const item of found.values()) {
      let p = pagesByNumber.get(item.pageNumber);

      // If pages array doesn’t have that page (shouldn’t happen), create minimal entry.
      if (!p) {
        p = { pageNumber: item.pageNumber, url: "", width: 0, height: 0, assets: [] };
        manifest.pages.push(p);
        pagesByNumber.set(item.pageNumber, p);
      }

      const existing = Array.isArray(p.assets) ? p.assets : [];
      const byId = new Map<string, PageAsset>();
      for (const a of existing) byId.set(a.assetId, a);

      if (!byId.has(item.assetId)) {
        const bbox: AssetBBox = { x: 0, y: 0, w: 0, h: 0 }; // unknown when rebuilding
        byId.set(item.assetId, { assetId: item.assetId, url: item.url, bbox });
        added += 1;
      } else {
        // Ensure URL is updated if it differs
        const prev = byId.get(item.assetId)!;
        if (prev.url !== item.url) byId.set(item.assetId, { ...prev, url: item.url });
      }

      p.assets = Array.from(byId.values()).sort((a, b) => a.assetId.localeCompare(b.assetId));
    }

    const newManifestUrl = await saveManifest(manifest);

    return NextResponse.json({
      ok: true,
      manifestUrl: newManifestUrl,
      foundInBlob: found.size,
      addedToManifest: added
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

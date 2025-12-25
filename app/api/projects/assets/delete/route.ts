import { NextResponse } from "next/server";
import { del, list } from "@vercel/blob";
import { saveManifest, type ProjectManifest } from "@/app/lib/manifest";

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
  const url = baseUrl(manifestUrlRaw);
  const res = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Cannot fetch manifest (${res.status}): ${await readErrorText(res)}`);
  return (await res.json()) as ProjectManifest;
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
    const assetId = (body.assetId || "").trim();
    const pageNumber = Number(body.pageNumber);

    if (!projectId || !manifestUrl || !assetId || !Number.isFinite(pageNumber)) {
      return NextResponse.json(
        { ok: false, error: "Missing projectId/manifestUrl/pageNumber/assetId" },
        { status: 400 }
      );
    }

    const manifest = await fetchManifest(manifestUrl);
    if (manifest.projectId !== projectId) {
      return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
    }

    // ✅ Delete ALL blob objects for this assetId (handles duplicates / random suffixes)
    const prefix = `projects/${projectId}/assets/p${pageNumber}/`;
    const urlsToDelete: string[] = [];

    let cursor: string | undefined = undefined;
    for (;;) {
      const page = (await list({ prefix, limit: 1000, cursor })) as unknown as ListResult;

      for (const b of page.blobs) {
        const pathname = typeof b.pathname === "string" ? b.pathname : "";
        // match: .../p13-img05*.png (including random suffix variants)
        if (pathname.includes(`/${assetId}`) && pathname.endsWith(".png")) {
          if (typeof b.url === "string" && b.url) urlsToDelete.push(b.url);
        }
      }

      const next = page.cursor ?? undefined;
      cursor = typeof next === "string" && next.length > 0 ? next : undefined;
      if (!cursor) break;
    }

    if (urlsToDelete.length > 0) {
      await del(urlsToDelete);
    }

    // Remove from manifest (so UI stops referencing it)
    if (Array.isArray(manifest.pages)) {
      const p = manifest.pages.find((x) => x.pageNumber === pageNumber);
      if (p && Array.isArray(p.assets)) {
        p.assets = p.assets.filter((a) => a.assetId !== assetId);
      }
    }

    const newManifestUrl = await saveManifest(manifest);

    return NextResponse.json({
      ok: true,
      manifestUrl: newManifestUrl,
      deletedCount: urlsToDelete.length
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

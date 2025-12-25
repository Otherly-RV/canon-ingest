import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { saveManifest, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  projectId?: string;
  manifestUrl?: string;
  pageNumber?: number;
  assetId?: string;
  assetUrl?: string;
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
    const body = (await req.json()) as Body;

    const projectId = (body.projectId || "").trim();
    const manifestUrl = (body.manifestUrl || "").trim();
    const assetId = (body.assetId || "").trim();
    const assetUrl = (body.assetUrl || "").trim();
    const pageNumber = Number(body.pageNumber);

    if (!projectId || !manifestUrl || !assetId || !assetUrl || !Number.isFinite(pageNumber)) {
      return NextResponse.json(
        { ok: false, error: "Missing projectId/manifestUrl/pageNumber/assetId/assetUrl" },
        { status: 400 }
      );
    }

    const manifest = await fetchManifest(manifestUrl);

    if (manifest.projectId !== projectId) {
      return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
    }

    await del([assetUrl]);

    if (Array.isArray(manifest.pages)) {
      const p = manifest.pages.find((x) => x.pageNumber === pageNumber);
      if (p && Array.isArray(p.assets)) {
        p.assets = p.assets.filter((a) => a.assetId !== assetId);
      }
    }

    const newManifestUrl = await saveManifest(manifest);
    return NextResponse.json({ ok: true, manifestUrl: newManifestUrl });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

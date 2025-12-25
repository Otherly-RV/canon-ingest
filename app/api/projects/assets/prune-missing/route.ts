import { NextResponse } from "next/server";
import { saveManifest, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { projectId?: string; manifestUrl?: string };

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

async function exists(url: string): Promise<boolean> {
  const u = `${baseUrl(url)}?v=${Date.now()}`;

  // HEAD (fast)
  try {
    const h = await fetch(u, { method: "HEAD", cache: "no-store" });
    if (h.ok) return true;
    if (h.status === 404) return false;
  } catch {
    // ignore
  }

  // GET range fallback
  try {
    const g = await fetch(u, { method: "GET", cache: "no-store", headers: { Range: "bytes=0-0" } });
    if (g.ok) return true;
    if (g.status === 404) return false;
  } catch {
    // if network fails, don’t delete aggressively
    return true;
  }

  return true;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as Body;
    const projectId = (body.projectId || "").trim();
    const manifestUrl = (body.manifestUrl || "").trim();
    if (!projectId || !manifestUrl) {
      return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl" }, { status: 400 });
    }

    const manifest = await fetchManifest(manifestUrl);
    if (manifest.projectId !== projectId) {
      return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
    }

    let checked = 0;
    let removed = 0;

    if (Array.isArray(manifest.pages)) {
      for (const p of manifest.pages) {
        if (!Array.isArray(p.assets) || p.assets.length === 0) continue;

        const keep: typeof p.assets = [];
        for (const a of p.assets) {
          checked += 1;
          const ok = await exists(a.url);
          if (ok) keep.push(a);
          else removed += 1;
        }
        p.assets = keep;
      }
    }

    const newManifestUrl = await saveManifest(manifest);
    return NextResponse.json({ ok: true, manifestUrl: newManifestUrl, checked, removed });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

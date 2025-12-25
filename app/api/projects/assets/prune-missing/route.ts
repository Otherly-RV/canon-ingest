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
  const url = `${baseUrl(manifestUrlRaw)}?v=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Cannot fetch manifest (${res.status}): ${await readErrorText(res)}`);
  return (await res.json()) as ProjectManifest;
}

async function existsDefinitely(url: string): Promise<"exists" | "missing" | "unknown"> {
  const u = `${baseUrl(url)}?v=${Date.now()}`;
  try {
    const res = await fetch(u, { method: "GET", cache: "no-store" });
    if (res.status === 404) return "missing";
    if (res.ok) return "exists";
    return "unknown";
  } catch {
    return "unknown";
  }
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

    let checked = 0;
    let removed = 0;
    let unknown = 0;

    if (Array.isArray(manifest.pages)) {
      for (const p of manifest.pages) {
        if (!Array.isArray(p.assets) || p.assets.length === 0) continue;

        const keep: typeof p.assets = [];
        for (const a of p.assets) {
          checked += 1;
          const st = await existsDefinitely(a.url);
          if (st === "missing") removed += 1;
          else {
            if (st === "unknown") unknown += 1;
            keep.push(a);
          }
        }
        p.assets = keep;
      }
    }

    const newManifestUrl = await saveManifest(manifest);
    return NextResponse.json({ ok: true, manifestUrl: newManifestUrl, checked, removed, unknown });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

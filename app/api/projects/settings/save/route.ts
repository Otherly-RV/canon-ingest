import { NextResponse } from "next/server";
import { saveManifest, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  projectId?: string;
  manifestUrl?: string;
  aiRules?: string;
  taggingJson?: string;
};

function baseUrl(u: string) {
  const url = new URL(u);
  return `${url.origin}${url.pathname}`;
}

async function fetchManifest(manifestUrlRaw: string): Promise<ProjectManifest> {
  const url = baseUrl(manifestUrlRaw);
  const res = await fetch(`${url}?v=${Date.now()}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" }
  });
  if (!res.ok) {
    throw new Error(`Cannot fetch manifest (${res.status})`);
  }
  return (await res.json()) as ProjectManifest;
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = String(body.projectId || "").trim();
  const manifestUrlRaw = String(body.manifestUrl || "").trim();

  if (!projectId || !manifestUrlRaw) {
    return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl" }, { status: 400 });
  }

  // If provided, enforce taggingJson is valid JSON before saving
  if (typeof body.taggingJson === "string") {
    try {
      JSON.parse(body.taggingJson);
    } catch {
      return NextResponse.json({ ok: false, error: "taggingJson is not valid JSON" }, { status: 400 });
    }
  }

  let manifest: ProjectManifest;
  try {
    manifest = await fetchManifest(manifestUrlRaw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }

  if (manifest.projectId !== projectId) {
    return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
  }

  // Re-fetch latest manifest to avoid race conditions
  const latest = await fetchManifest(manifestUrlRaw);
  if (latest.projectId !== projectId) {
    return NextResponse.json({ ok: false, error: "projectId does not match manifest on re-fetch" }, { status: 400 });
  }

  if (!latest.settings) {
    latest.settings = { aiRules: "", uiFieldsJson: "{}", taggingJson: "{}" };
  }

  if (typeof body.aiRules === "string") latest.settings.aiRules = body.aiRules;
  if (typeof body.taggingJson === "string") latest.settings.taggingJson = body.taggingJson;

  const newManifestUrl = await saveManifest(latest);

  return NextResponse.json({ ok: true, manifestUrl: newManifestUrl });
}

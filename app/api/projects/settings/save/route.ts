import { NextResponse } from "next/server";
import { saveManifest, fetchManifestDirect, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  projectId?: string;
  manifestUrl?: string;
  aiRules?: string;
  taggingJson?: string;
  schemaJson?: string;
};

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

  // If provided and non-empty, enforce schemaJson is valid JSON before saving
  if (typeof body.schemaJson === "string" && body.schemaJson.trim()) {
    try {
      JSON.parse(body.schemaJson);
    } catch {
      return NextResponse.json({ ok: false, error: "schemaJson is not valid JSON" }, { status: 400 });
    }
  }

  let manifest: ProjectManifest;
  try {
    manifest = await fetchManifestDirect(manifestUrlRaw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }

  if (manifest.projectId !== projectId) {
    return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
  }

  // Re-fetch latest manifest to avoid race conditions
  const latest = await fetchManifestDirect(manifestUrlRaw);
  if (latest.projectId !== projectId) {
    return NextResponse.json({ ok: false, error: "projectId does not match manifest on re-fetch" }, { status: 400 });
  }

  if (!latest.settings) {
    latest.settings = { aiRules: "", uiFieldsJson: "{}", taggingJson: "{}", schemaJson: "{}" };
  }

  if (typeof body.aiRules === "string") latest.settings.aiRules = body.aiRules;
  if (typeof body.taggingJson === "string") latest.settings.taggingJson = body.taggingJson;
  if (typeof body.schemaJson === "string") latest.settings.schemaJson = body.schemaJson;

  const newManifestUrl = await saveManifest(latest);

  return NextResponse.json({ ok: true, manifestUrl: newManifestUrl });
}

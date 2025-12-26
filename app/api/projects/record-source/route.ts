import { NextResponse } from "next/server";
import { newManifest, saveManifest, fetchManifestDirect, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  projectId?: string;
  manifestUrl?: string;
  sourcePdfUrl?: string;
  filename?: string;
};

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = String(body.projectId || "").trim();
  const manifestUrl = String(body.manifestUrl || "").trim();
  const sourcePdfUrl = String(body.sourcePdfUrl || "").trim();
  const filename = String(body.filename || "source.pdf").trim();

  if (!projectId || !manifestUrl || !sourcePdfUrl) {
    return NextResponse.json({ ok: false, error: "Missing projectId, manifestUrl, or sourcePdfUrl" }, { status: 400 });
  }

  // Fetch existing manifest or create new one
  let manifest: ProjectManifest;
  try {
    manifest = await fetchManifestDirect(manifestUrl);
  } catch {
    manifest = newManifest(projectId);
  }

  // Update manifest with source PDF
  manifest.sourcePdf = { url: sourcePdfUrl, filename };
  manifest.status = "uploaded";

  const newUrl = await saveManifest(manifest);

  return NextResponse.json({ ok: true, manifestUrl: newUrl, sourcePdfUrl });
}

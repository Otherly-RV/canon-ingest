import { NextResponse } from "next/server";
import { newManifest, saveManifest } from "@/app/lib/manifest";

export async function POST() {
  const projectId = crypto.randomUUID();
  const manifest = newManifest(projectId);
  const manifestUrl = await saveManifest(manifest);
  return NextResponse.json({ ok: true, projectId, manifestUrl });
}

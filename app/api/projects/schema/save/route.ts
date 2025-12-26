import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { fetchManifestDirect, saveManifest } from "@/app/lib/manifest";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      projectId?: string;
      manifestUrl?: string;
      results?: string;
    };

    const { projectId, manifestUrl, results } = body;

    if (!projectId || !manifestUrl) {
      return NextResponse.json({ ok: false, error: "Missing projectId or manifestUrl" }, { status: 400 });
    }

    if (!results) {
      return NextResponse.json({ ok: false, error: "Missing results" }, { status: 400 });
    }

    // Load manifest
    const manifest = await fetchManifestDirect(manifestUrl);

    // Validate that results is valid JSON (optional but recommended)
    try {
      JSON.parse(results);
    } catch {
      // Allow saving even if not valid JSON - user might be editing
    }

    // Save schema results to blob storage
    const schemaResultsPath = `projects/${projectId}/schema-results.json`;
    const blob = await put(schemaResultsPath, results, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false
    });

    // Update manifest with schema results URL
    manifest.schemaResults = { url: blob.url };

    // Save updated manifest
    const newManifestUrl = await saveManifest(manifest);

    return NextResponse.json({
      ok: true,
      manifestUrl: newManifestUrl,
      schemaResultsUrl: blob.url
    });
  } catch (err) {
    console.error("Schema save error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

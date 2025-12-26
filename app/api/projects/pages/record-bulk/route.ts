import { NextResponse } from "next/server";
import { saveManifest, fetchManifestDirect, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageData = {
  pageNumber: number;
  url: string;
  width: number;
  height: number;
};

type Body = {
  projectId?: string;
  manifestUrl?: string;
  pages?: PageData[];
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
  const pages = body.pages;

  if (!projectId || !manifestUrl) {
    return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl" }, { status: 400 });
  }

  if (!Array.isArray(pages) || pages.length === 0) {
    return NextResponse.json({ ok: false, error: "Missing or empty pages array" }, { status: 400 });
  }

  // Validate each page entry
  for (const p of pages) {
    if (!p.pageNumber || !p.url || !p.width || !p.height) {
      return NextResponse.json({ ok: false, error: `Invalid page entry: ${JSON.stringify(p)}` }, { status: 400 });
    }
  }

  try {
    // Fetch the latest manifest
    const manifest = await fetchManifestDirect(manifestUrl);
    
    if (manifest.projectId !== projectId) {
      return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
    }

    if (!Array.isArray(manifest.pages)) manifest.pages = [];

    // Add or update all pages
    for (const pageData of pages) {
      const idx = manifest.pages.findIndex((p) => p.pageNumber === pageData.pageNumber);
      const page = {
        pageNumber: pageData.pageNumber,
        url: pageData.url,
        width: pageData.width,
        height: pageData.height
      };

      if (idx >= 0) {
        manifest.pages[idx] = { ...manifest.pages[idx], ...page };
      } else {
        manifest.pages.push(page);
      }
    }

    // Sort pages by page number
    manifest.pages.sort((a, b) => a.pageNumber - b.pageNumber);

    // Add debug log
    if (!Array.isArray(manifest.debugLog)) manifest.debugLog = [];
    const timestamp = new Date().toISOString();
    manifest.debugLog.unshift(`[${timestamp}] RECORD-BULK-PAGES: Added ${pages.length} pages`);
    if (manifest.debugLog.length > 50) manifest.debugLog = manifest.debugLog.slice(0, 50);

    const newManifestUrl = await saveManifest(manifest);
    return NextResponse.json({ ok: true, manifestUrl: newManifestUrl, pagesRecorded: pages.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

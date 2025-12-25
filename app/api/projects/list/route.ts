import { NextResponse } from "next/server";
import { list } from "@vercel/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProjectRow = {
  projectId: string;
  manifestUrl: string;
  createdAt: string;
  status: string;
  filename: string;
  pagesCount: number;
  hasText: boolean;
};

type Manifest = {
  projectId: string;
  createdAt: string;
  status: string;
  sourcePdf?: { url: string; filename: string };
  extractedText?: { url: string };
  pages?: Array<{ pageNumber: number; url: string }>;
};

async function safeFetchManifest(url: string): Promise<Manifest | null> {
  try {
    const res = await fetch(`${url}?v=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" }
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Manifest;
    if (!j?.projectId) return null;
    return j;
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  // Collect all manifest.json blobs under projects/
  const manifestBlobs: Array<{ url: string; pathname: string }> = [];

  let cursor: string | undefined = undefined;
  for (;;) {
    const page = await list({
      prefix: "projects/",
      limit: 1000,
      cursor
    });

    for (const b of page.blobs) {
      if (typeof b.pathname === "string" && b.pathname.endsWith("/manifest.json")) {
        manifestBlobs.push({ url: b.url, pathname: b.pathname });
      }
    }

    cursor = page.cursor ?? undefined;
    if (!cursor) break;
  }

  // Fetch manifests to show human info
  const rows: ProjectRow[] = [];
  for (const mb of manifestBlobs) {
    const m = await safeFetchManifest(mb.url);
    if (!m) continue;

    rows.push({
      projectId: m.projectId,
      manifestUrl: mb.url,
      createdAt: m.createdAt || "",
      status: m.status || "",
      filename: m.sourcePdf?.filename || "(no source)",
      pagesCount: Array.isArray(m.pages) ? m.pages.length : 0,
      hasText: !!m.extractedText?.url
    });
  }

  // Sort newest first (fallback to manifestUrl if createdAt missing)
  rows.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return NextResponse.json({ ok: true, projects: rows });
}

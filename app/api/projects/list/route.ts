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

type ListResult = {
  blobs: Array<{ url: string; pathname?: string }>;
  cursor?: string | null;
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
  const manifestBlobs: Array<{ url: string; pathname: string }> = [];

  let cursor: string | undefined = undefined;

  for (;;) {
    const page = (await list({
      prefix: "projects/",
      limit: 1000,
      cursor
    })) as unknown as ListResult;

    for (const b of page.blobs) {
      const pathname = typeof b.pathname === "string" ? b.pathname : "";
      if (pathname.endsWith("/manifest.json")) {
        manifestBlobs.push({ url: b.url, pathname });
      }
    }

    const next = page.cursor ?? undefined;
    cursor = typeof next === "string" && next.length > 0 ? next : undefined;

    if (!cursor) break;
  }

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

  rows.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return NextResponse.json({ ok: true, projects: rows });
}

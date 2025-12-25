
import { NextResponse } from "next/server";
import { type ProjectManifest, type AssetBBox } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { projectId?: string; manifestUrl?: string };

type DetectResult = {
  ok: true;
  pages: Array<{ pageNumber: number; boxes: AssetBBox[] }>;
};

function baseUrl(u: string) {
  const url = new URL(u);
  return `${url.origin}${url.pathname}`;
}

async function fetchJson(urlRaw: string): Promise<unknown> {
  const url = baseUrl(urlRaw);
  const res = await fetch(`${url}?v=${Date.now()}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" }
  });
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  return (await res.json()) as unknown;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function bboxFromPoly(
  poly: unknown,
  pageW: number,
  pageH: number
): AssetBBox | null {
  if (!poly || typeof poly !== "object") return null;

  const o = poly as {
    normalizedVertices?: Array<{ x?: number; y?: number }>;
    vertices?: Array<{ x?: number; y?: number }>;
  };

  const verts = Array.isArray(o.normalizedVertices) ? o.normalizedVertices : Array.isArray(o.vertices) ? o.vertices : null;
  if (!verts || verts.length === 0) return null;

  const xs: number[] = [];
  const ys: number[] = [];

  for (const v of verts) {
    const x = typeof v.x === "number" ? v.x : 0;
    const y = typeof v.y === "number" ? v.y : 0;

    // If normalizedVertices, scale up. If vertices, treat as pixels.
    const px = Array.isArray(o.normalizedVertices) ? x * pageW : x;
    const py = Array.isArray(o.normalizedVertices) ? y * pageH : y;

    xs.push(px);
    ys.push(py);
  }

  if (xs.length === 0 || ys.length === 0) return null;

  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  const x = clamp(Math.floor(minX), 0, pageW - 1);
  const y = clamp(Math.floor(minY), 0, pageH - 1);
  const w = clamp(Math.ceil(maxX - minX), 1, pageW - x);
  const h = clamp(Math.ceil(maxY - minY), 1, pageH - y);

  return { x, y, w, h };
}

function area(b: AssetBBox) {
  return b.w * b.h;
}

function iou(a: AssetBBox, b: AssetBBox) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, x2 - x1);
  const ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  const union = area(a) + area(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

function dedupe(boxes: AssetBBox[]): AssetBBox[] {
  const kept: AssetBBox[] = [];
  for (const b of boxes) {
    let overlaps = false;
    for (const k of kept) {
      if (iou(b, k) > 0.85) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) kept.push(b);
  }
  return kept;
}

// Extract likely "image" boxes from DocAI JSON.
// We try visualElements first; if missing, we fall back to scanning any objects that have layout.boundingPoly.
function extractBoxesForDocAiPage(docPage: unknown, pageW: number, pageH: number): AssetBBox[] {
  const boxes: AssetBBox[] = [];

  // 1) visualElements
  if (docPage && typeof docPage === "object") {
    const p = docPage as { visualElements?: unknown };
    if (Array.isArray(p.visualElements)) {
      for (const ve of p.visualElements) {
        if (!ve || typeof ve !== "object") continue;
        const veObj = ve as { layout?: { boundingPoly?: unknown }; type?: unknown };
        const poly = veObj.layout?.boundingPoly;
        const b = bboxFromPoly(poly, pageW, pageH);
        if (b) boxes.push(b);
      }
    }
  }

  // 2) Fallback scan: shallow-walk a few known arrays commonly present in DocAI
  const knownArrays = ["blocks", "paragraphs", "lines", "tokens"];
  if (boxes.length === 0 && docPage && typeof docPage === "object") {
    const p = docPage as Record<string, unknown>;
    for (const key of knownArrays) {
      const arr = p[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const it = item as { layout?: { boundingPoly?: unknown } };
        const b = bboxFromPoly(it.layout?.boundingPoly, pageW, pageH);
        if (b) boxes.push(b);
      }
    }
  }

  // Filter out tiny + near-full-page boxes
  const pageArea = pageW * pageH;
  const filtered = boxes.filter((b) => {
    const a = area(b);
    if (a < pageArea * 0.02) return false;  // too small
    if (a > pageArea * 0.92) return false;  // basically whole page
    if (b.w < 50 || b.h < 50) return false; // too small in absolute terms
    return true;
  });

  // Sort big first, dedupe overlaps, cap count
  filtered.sort((a, b) => area(b) - area(a));
  return dedupe(filtered).slice(0, 25);
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

  const manifest = (await fetchJson(manifestUrlRaw)) as ProjectManifest;
  if (manifest.projectId !== projectId) {
    return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
  }

  if (!manifest.docAiJson?.url) {
    return NextResponse.json({ ok: false, error: "No docAiJson found. Run Process Text first." }, { status: 400 });
  }

  const pages = manifest.pages ?? [];
  if (!Array.isArray(pages) || pages.length === 0) {
    return NextResponse.json({ ok: false, error: "No page PNGs found. Run Rasterize PNGs first." }, { status: 400 });
  }

  const doc = await fetchJson(manifest.docAiJson.url);

  // DocAI "document" shape varies. We try common nesting:
  // { document: { pages: [...] } } or { pages: [...] }
  const docPages =
    (doc && typeof doc === "object" && Array.isArray((doc as { pages?: unknown }).pages) && (doc as { pages?: unknown }).pages) ||
    (doc && typeof doc === "object" && (doc as { document?: unknown }).document && typeof (doc as { document?: unknown }).document === "object"
      && Array.isArray(((doc as { document?: { pages?: unknown } }).document?.pages))
      && (doc as { document?: { pages?: unknown } }).document?.pages) ||
    [];

  const resultPages: Array<{ pageNumber: number; boxes: AssetBBox[] }> = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const docPage = Array.isArray(docPages) ? docPages[i] : null;
    const boxes = docPage ? extractBoxesForDocAiPage(docPage, page.width, page.height) : [];
    resultPages.push({ pageNumber: page.pageNumber, boxes });
  }

  const out: DetectResult = { ok: true, pages: resultPages };
  return NextResponse.json(out);
}

import { NextResponse } from "next/server";
import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";
import { fetchManifestDirect, type AssetBBox, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Max boxes per page to control cost/noise
const MAX_BOXES = 25;
const MIN_AREA_RATIO = 0.02; // filter tiny boxes
const MAX_AREA_RATIO = 0.92; // filter nearly full page boxes

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing ${name}`);
  return String(v).trim();
}

function optEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
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

function safeParseJson(text: string): unknown {
  const t = text.trim();
  if (!t) return null;

  const fenced = t.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // ignore
    }
  }

  const firstObj = t.match(/\{[\s\S]*\}/);
  if (firstObj?.[0]) {
    try {
      return JSON.parse(firstObj[0]);
    } catch {
      // ignore
    }
  }

  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function buildPrompt(pageNumber: number, maxBoxes: number) {
  return [
    `You will receive a PDF page as an image. Detect visual regions that are photos/figures/diagrams (not plain text).`,
    `Return ONLY JSON: an array of objects [{"x": number, "y": number, "w": number, "h": number}] with values normalized 0-1 relative to width/height.`,
    `Rules:`,
    `- Up to ${maxBoxes} boxes`,
    `- Omit boxes smaller than 2% of page area`,
    `- Omit boxes covering ~full page`,
    `- Do not include text-only blocks`,
    `- Respond with JSON only, no markdown, no prose`,
    `Context: pageNumber ${pageNumber}`
  ].join("\n");
}

async function fetchPngAsBase64(url: string): Promise<{ base64: string; buffer: Buffer }>
{
  const res = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch page image (${res.status})`);
  const ab = await res.arrayBuffer();
  const buffer = Buffer.from(ab);
  return { base64: buffer.toString("base64"), buffer };
}

async function detectWithGemini(model: GenerativeModel, pageNumber: number, pngBase64: string, pageW: number, pageH: number): Promise<AssetBBox[]> {
  const prompt = buildPrompt(pageNumber, MAX_BOXES);

  const res = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { data: pngBase64, mimeType: "image/png" } }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 400
    }
  });

  const text = res.response.text?.() ?? "";
  const parsed = safeParseJson(text);
  const arr = Array.isArray(parsed) ? parsed : [];

  const boxes: AssetBBox[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
    const x = Number(o.x);
    const y = Number(o.y);
    const w = Number(o.w);
    const h = Number(o.h);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    if (w <= 0 || h <= 0) continue;

    const px = x * pageW;
    const py = y * pageH;
    const pw = w * pageW;
    const ph = h * pageH;

    const box: AssetBBox = {
      x: clamp(Math.floor(px), 0, pageW - 1),
      y: clamp(Math.floor(py), 0, pageH - 1),
      w: clamp(Math.ceil(pw), 1, pageW),
      h: clamp(Math.ceil(ph), 1, pageH)
    };
    const a = area(box);
    const pageArea = pageW * pageH;
    if (a < pageArea * MIN_AREA_RATIO) continue;
    if (a > pageArea * MAX_AREA_RATIO) continue;
    boxes.push(box);
  }

  boxes.sort((a, b) => area(b) - area(a));
  return dedupe(boxes).slice(0, MAX_BOXES);
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { projectId?: string; manifestUrl?: string; limitPages?: number };
    const projectId = String(body.projectId || "").trim();
    const manifestUrl = String(body.manifestUrl || "").trim();
    const limitPages = Number.isFinite(body.limitPages) ? Number(body.limitPages) : 0;

    if (!projectId || !manifestUrl) {
      return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl" }, { status: 400 });
    }

    const GEMINI_API_KEY = mustEnv("GEMINI_API_KEY");
    const GEMINI_MODEL = optEnv("GEMINI_DETECT_MODEL", optEnv("GEMINI_MODEL", "gemini-3-pro-preview"));

    const manifest = await fetchManifestDirect(manifestUrl);
    if (manifest.projectId !== projectId) {
      return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
    }
    if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
      return NextResponse.json({ ok: false, error: "No pages in manifest" }, { status: 400 });
    }

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

    const pages: ProjectManifest["pages"] = manifest.pages.slice(0, limitPages && limitPages > 0 ? limitPages : manifest.pages.length);

    const results: Array<{ pageNumber: number; boxes: AssetBBox[] }> = [];

    for (const page of pages) {
      if (!page.url || !page.width || !page.height) continue;

      const { base64 } = await fetchPngAsBase64(page.url);
      const boxes = await detectWithGemini(model, page.pageNumber, base64, page.width, page.height);
      results.push({ pageNumber: page.pageNumber, boxes });
    }

    return NextResponse.json({ ok: true, pages: results, model: GEMINI_MODEL });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

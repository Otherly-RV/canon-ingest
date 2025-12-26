import { NextResponse } from "next/server";
import { saveManifest, fetchManifestDirect, type ProjectManifest, type PageImage } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  projectId?: string;
  manifestUrl?: string;
};

type TaggingConfig = {
  max_tags_per_image?: number;
  min_word_len?: number;
  banned?: string[];
  required?: string[];
};

function baseUrl(u: string) {
  const url = new URL(u);
  return `${url.origin}${url.pathname}`;
}

async function fetchExtractedText(textUrlRaw: string): Promise<string> {
  const url = baseUrl(textUrlRaw);
  const res = await fetch(`${url}?v=${Date.now()}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" }
  });
  if (!res.ok) throw new Error(`Cannot fetch extractedText (${res.status})`);

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = (await res.json()) as unknown;
    if (typeof j === "string") return j;
    if (typeof j === "object" && j) {
      const obj = j as { text?: unknown; extractedText?: unknown; content?: unknown };
      if (typeof obj.text === "string") return obj.text;
      if (typeof obj.extractedText === "string") return obj.extractedText;
      if (typeof obj.content === "string") return obj.content;
    }
    return JSON.stringify(j);
  }

  return await res.text();
}

function safeParseTaggingJson(raw: string): TaggingConfig {
  try {
    const j = JSON.parse(raw) as unknown;
    if (!j || typeof j !== "object") return {};
    const o = j as TaggingConfig;
    return {
      max_tags_per_image: typeof o.max_tags_per_image === "number" ? o.max_tags_per_image : undefined,
      min_word_len: typeof o.min_word_len === "number" ? o.min_word_len : undefined,
      banned: Array.isArray(o.banned) ? o.banned.filter((s) => typeof s === "string") : undefined,
      required: Array.isArray(o.required) ? o.required.filter((s) => typeof s === "string") : undefined
    };
  } catch {
    return {};
  }
}

const STOP = new Set<string>([
  "a","an","the","and","or","but","if","then","else","of","to","in","on","at","for","from","by","with","as",
  "is","are","was","were","be","been","being","it","this","that","these","those","i","you","he","she","we","they",
  "him","her","them","my","your","our","their","me","us","not","no","yes","do","does","did","doing",
  "can","could","may","might","must","should","would","will","just","very","so","than","too","into","over","under",
  "up","down","out","about","again","once","here","there","when","where","why","how"
]);

function normalizeToken(s: string) {
  return s
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-z0-9_ -]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function sliceForPage(fullText: string, pageNumber: number, totalPages: number): string {
  if (totalPages <= 1) return fullText;
  const len = fullText.length;
  const start = Math.floor(((pageNumber - 1) / totalPages) * len);
  const end = Math.floor((pageNumber / totalPages) * len);
  const slice = fullText.slice(start, Math.max(start, end));
  return slice;
}

function extractTags(text: string, cfg: TaggingConfig): string[] {
  const maxTags = Math.max(1, Math.min(200, cfg.max_tags_per_image ?? 25));
  const minLen = Math.max(2, Math.min(30, cfg.min_word_len ?? 3));

  const banned = new Set((cfg.banned ?? []).map((s) => normalizeToken(s)).filter(Boolean));

  const cleaned = normalizeToken(text);
  const parts = cleaned.split(" ");

  const freq = new Map<string, number>();

  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (t.length < minLen) continue;
    if (STOP.has(t)) continue;
    if (banned.has(t)) continue;
    if (/^\d+$/.test(t)) continue;

    freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  const sorted = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);

  const tags: string[] = [];
  for (const r of cfg.required ?? []) {
    const t = normalizeToken(r);
    if (t && !tags.includes(t)) tags.push(t);
  }

  for (const t of sorted) {
    if (tags.length >= maxTags) break;
    if (!tags.includes(t)) tags.push(t);
  }

  return tags.slice(0, maxTags);
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

  // Re-fetch latest manifest before saving to avoid resurrecting deleted assets
  let manifest: ProjectManifest;
  try {
    manifest = await fetchManifestDirect(manifestUrlRaw);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  if (manifest.projectId !== projectId) {
    return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
  }
  const textUrl = manifest.extractedText?.url;
  if (!textUrl) {
    return NextResponse.json({ ok: false, error: "No extractedText found. Run Process Text first." }, { status: 400 });
  }
  const pages = (manifest.pages ?? []) as PageImage[];
  if (!Array.isArray(pages) || pages.length === 0) {
    return NextResponse.json({ ok: false, error: "No PNG pages found. Run Rasterize PNGs first." }, { status: 400 });
  }
  const taggingRaw = manifest.settings?.taggingJson ?? "{}";
  const cfg = safeParseTaggingJson(taggingRaw);
  let fullText = "";
  try {
    fullText = await fetchExtractedText(textUrl);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  const totalPages = pages.length;
  // Add tags per page (stored on pages[n] as "tags")
  const newTagsByPage = new Map<number, string[]>();
  for (const p of pages) {
    const pageText = sliceForPage(fullText, p.pageNumber, totalPages);
    const tags = extractTags(pageText, cfg);
    newTagsByPage.set(p.pageNumber, tags);
  }

  // Re-fetch latest manifest to avoid race conditions
  const latest = await fetchManifestDirect(manifestUrlRaw);
  if (latest.projectId !== projectId) {
    return NextResponse.json({ ok: false, error: "projectId does not match manifest on re-fetch" }, { status: 400 });
  }

  let taggedCount = 0;

  if (Array.isArray(latest.pages)) {
    for (const p of latest.pages) {
      const tags = newTagsByPage.get(p.pageNumber);
      if (tags) {
        p.tags = tags;
        // Also apply to all assets on this page
        if (Array.isArray(p.assets)) {
          for (const a of p.assets) {
             // Union with existing tags
             const existing = new Set(a.tags || []);
             for (const t of tags) existing.add(t);
             a.tags = Array.from(existing);
             taggedCount++;
          }
        }
      }
      // Final filter: never keep assets with tombstoned assetIds
      if (Array.isArray(p.deletedAssetIds) && Array.isArray(p.assets)) {
        const deleted = new Set(p.deletedAssetIds);
        p.assets = p.assets.filter((a) => !deleted.has(a.assetId));
      }
    }
  }

  // Add debug log
  if (!Array.isArray(latest.debugLog)) latest.debugLog = [];
  const timestamp = new Date().toISOString();
  latest.debugLog.unshift(`[${timestamp}] TAG-IMAGES: Tagged ${taggedCount} assets across ${newTagsByPage.size} pages.`);
  if (latest.debugLog.length > 50) latest.debugLog = latest.debugLog.slice(0, 50);

  const newManifestUrl = await saveManifest(latest);
  return NextResponse.json({
    ok: true,
    manifestUrl: newManifestUrl,
    totalPages,
    taggedPages: newTagsByPage.size
  });
}

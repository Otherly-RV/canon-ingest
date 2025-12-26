import { NextResponse } from "next/server";
import { saveManifest, fetchManifestDirect, type ProjectManifest, type PageAsset } from "@/app/lib/manifest";
import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  projectId?: string;
  manifestUrl?: string;
  overwrite?: boolean;
  limitAssets?: number; // optional safety
};

type TagUpdate = { pageNumber: number; assetId: string; tags: string[]; rationale: string };

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing ${name}`);
  return String(v).trim();
}

function optEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

function baseUrl(u: string) {
  const url = new URL(u);
  return `${url.origin}${url.pathname}`;
}

async function readErrorText(res: Response) {
  try {
    const t = await res.text();
    return t || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(`${baseUrl(url)}?v=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${await readErrorText(res)}`);
  return (await res.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(`${baseUrl(url)}?v=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${await readErrorText(res)}`);
  return await res.text();
}

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function safeParseJsonFromText(raw: string): unknown {
  const t = raw.trim();
  if (!t) return null;

  // 1) ```json ... ```
  const fence = t.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }

  // 2) first {...} block
  const firstObj = t.match(/\{[\s\S]*\}/);
  if (firstObj?.[0]) {
    try {
      return JSON.parse(firstObj[0]);
    } catch {
      // fall through
    }
  }

  // 3) try whole text
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function uniqCleanTags(tags: unknown, maxTags: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  if (!Array.isArray(tags)) return out;

  for (const v of tags) {
    if (typeof v !== "string") continue;
    const s = v.trim().replace(/\s+/g, " ");
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= maxTags) break;
  }

  return out;
}

function getPageTextFallback(fullText: string, pageNumber: number): string {
  // If you later store per-page text, replace this.
  // For now: return a window around "Page X" markers or just first N chars.
  const marker = new RegExp(`\\bpage\\s*${pageNumber}\\b`, "i");
  const idx = fullText.search(marker);
  if (idx >= 0) {
    const start = clampInt(idx - 2500, 0, fullText.length);
    const end = clampInt(idx + 2500, 0, fullText.length);
    return fullText.slice(start, end);
  }
  return fullText.slice(0, 5000);
}

function buildPrompt(args: {
  aiRules: string;
  taggingJson: string;
  pageNumber: number;
  assetId: string;
  pageText: string;
  maxTags: number;
}) {
  const { aiRules, taggingJson, pageNumber, assetId, pageText, maxTags } = args;

  return [
    `SYSTEM RULES (follow strictly):`,
    aiRules,
    ``,
    `TAGGING CONFIG (JSON, use as constraints):`,
    taggingJson,
    ``,
    `TASK: You are tagging ONE cropped image asset extracted from a PDF page.`,
    `You must output ONLY valid JSON (no markdown).`,
    ``,
    `CONTEXT:`,
    `- pageNumber: ${pageNumber}`,
    `- assetId: ${assetId}`,
    ``,
    `PAGE TEXT (use to keep tags coherent with document; do not invent):`,
    pageText,
    ``,
    `OUTPUT SCHEMA (JSON):`,
    `{`,
    `  "tags": ["..."],`,
    `  "rationale": "short reason grounded in page text"`,
    `}`,
    ``,
    `RULES:`,
    `- tags must be short, lowercase preferred, comma-free strings`,
    `- max ${maxTags} tags`,
    `- if uncertain, output fewer tags (not guesses)`,
    `- rationale must cite words/phrases from the PAGE TEXT when possible`
  ].join("\n");
}

async function geminiGenerate(model: GenerativeModel, prompt: string) {
  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 600
    }
  });

  // Primary: response.text()
  const text = res.response.text?.() ?? "";
  if (text && text.trim()) return { text, raw: res };

  // Fallback: candidates parts
  const anyRes = res as unknown as {
    response?: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  };

  const parts = anyRes.response?.candidates?.[0]?.content?.parts ?? [];
  const joined = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  if (joined && joined.trim()) return { text: joined, raw: res };

  throw new Error("Gemini returned empty response text");
}

async function callGeminiTagger(args: {
  apiKey: string;
  modelName: string;
  aiRules: string;
  taggingJson: string;
  pageNumber: number;
  assetId: string;
  pageText: string;
}) {
  const { apiKey, modelName, aiRules, taggingJson, pageNumber, assetId, pageText } = args;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName });

  // Read max_tags_per_image from taggingJson if present
  let maxTags = 20;
  try {
    const cfg = JSON.parse(taggingJson) as unknown;
    if (cfg && typeof cfg === "object") {
      const mt = (cfg as Record<string, unknown>)["max_tags_per_image"];
      if (typeof mt === "number" && Number.isFinite(mt) && mt > 0) maxTags = clampInt(mt, 1, 50);
    }
  } catch {
    // ignore
  }

  const promptA = buildPrompt({ aiRules, taggingJson, pageNumber, assetId, pageText, maxTags });

  // Retry strategy for empty/invalid JSON
  const attempts: Array<{ prompt: string }> = [
    { prompt: promptA },
    {
      prompt:
        promptA +
        `\n\nIMPORTANT: Output ONLY JSON. No markdown. If you cannot comply, output {"tags":[],"rationale":"insufficient evidence in page text"}.`
    }
  ];

  let lastErr: Error | null = null;

  for (let i = 0; i < attempts.length; i++) {
    try {
      const { text } = await geminiGenerate(model, attempts[i].prompt);

      const parsed = safeParseJsonFromText(text);
      if (!parsed || typeof parsed !== "object") throw new Error("Gemini did not return valid JSON");

      const obj = parsed as Record<string, unknown>;
      const tags = uniqCleanTags(obj.tags, maxTags);
      const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";

      // Accept even empty tags if rationale exists; otherwise make a safe fallback
      return {
        tags,
        rationale: rationale || (tags.length ? "tags inferred from page text" : "insufficient evidence in page text")
      };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }

  throw lastErr ?? new Error("Gemini tagger failed");
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as Body;

    const projectId = String(body.projectId || "").trim();
    const manifestUrl = String(body.manifestUrl || "").trim();
    const overwrite = Boolean(body.overwrite);
    const limitAssets = typeof body.limitAssets === "number" && Number.isFinite(body.limitAssets) ? body.limitAssets : 0;

    if (!projectId || !manifestUrl) {
      return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl" }, { status: 400 });
    }

    const GEMINI_API_KEY = mustEnv("GEMINI_API_KEY");
    // Default to a modern model name; you can override via env
    const GEMINI_MODEL = optEnv("GEMINI_MODEL", "gemini-2.0-flash");

    // NOTE: We will *not* save this manifest directly at the end.
    // Tagging can take time, and the user may delete assets while it's running.
    // If we save the stale manifest, we can resurrect deleted assets.
    const manifest = await fetchManifestDirect(manifestUrl);

    if (manifest.projectId !== projectId) {
      return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
    }

    if (!manifest.extractedText?.url) {
      return NextResponse.json({ ok: false, error: "No extractedText in manifest" }, { status: 400 });
    }

    if (!manifest.pages || !Array.isArray(manifest.pages) || manifest.pages.length === 0) {
      return NextResponse.json({ ok: false, error: "No pages in manifest" }, { status: 400 });
    }

    // Full text (fallback) — later you can store per-page text in DocAI JSON
    const fullText = await fetchText(manifest.extractedText.url);

    const aiRules = manifest.settings?.aiRules ?? "";
    const taggingJson = manifest.settings?.taggingJson ?? "{}";

    let totalConsidered = 0;
    let totalTagged = 0;
    const updates: TagUpdate[] = [];

    for (const page of manifest.pages) {
      const pageNumber = page.pageNumber;
      const pageText = getPageTextFallback(fullText, pageNumber);

      const deleted = new Set<string>(Array.isArray(page.deletedAssetIds) ? page.deletedAssetIds : []);

      const assets = Array.isArray(page.assets) ? page.assets : [];
      if (!assets.length) continue;

      for (const asset of assets) {
        if (deleted.has(asset.assetId)) continue;
        totalConsidered += 1;
        if (limitAssets > 0 && totalConsidered > limitAssets) break;

        const alreadyTagged = Array.isArray(asset.tags) && asset.tags.length > 0;
        if (alreadyTagged && !overwrite) continue;

        const { tags, rationale } = await callGeminiTagger({
          apiKey: GEMINI_API_KEY,
          modelName: GEMINI_MODEL,
          aiRules,
          taggingJson,
          pageNumber,
          assetId: asset.assetId,
          pageText
        });

        updates.push({ pageNumber, assetId: asset.assetId, tags, rationale });
        totalTagged += 1;
      }

      if (limitAssets > 0 && totalConsidered > limitAssets) break;
    }

    // Re-fetch latest manifest and merge tag updates onto it, so we don't
    // overwrite concurrent changes like deletions.
    const latest = await fetchManifestDirect(manifestUrl);

    for (const u of updates) {
      const p = latest.pages?.find((x) => x.pageNumber === u.pageNumber);
      if (!p) continue;
      if (Array.isArray(p.deletedAssetIds) && p.deletedAssetIds.includes(u.assetId)) continue;
      const a = p.assets?.find((x) => x.assetId === u.assetId);
      if (!a) continue;
      (a as PageAsset).tags = u.tags;
      (a as PageAsset).tagRationale = u.rationale;
    }

    // Add debug log
    if (!Array.isArray(latest.debugLog)) latest.debugLog = [];
    const timestamp = new Date().toISOString();
    latest.debugLog.unshift(`[${timestamp}] AI-TAG: Tagged ${totalTagged} assets (considered ${totalConsidered}). Model: ${GEMINI_MODEL}.`);
    if (latest.debugLog.length > 50) latest.debugLog = latest.debugLog.slice(0, 50);

    const newManifestUrl = await saveManifest(latest);

    return NextResponse.json({
      ok: true,
      manifestUrl: newManifestUrl,
      considered: totalConsidered,
      tagged: totalTagged,
      model: GEMINI_MODEL
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { saveManifest, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  projectId?: string;
  manifestUrl?: string;
  limitAssets?: number; // optional safety
  overwrite?: boolean; // optional: retag even if tags exist
};

type DocAiRaw = {
  document?: {
    text?: string;
    pages?: Array<{
      layout?: {
        textAnchor?: {
          textSegments?: Array<{ startIndex?: number; endIndex?: number }>;
        };
      };
    }>;
  };
};

type TaggingResult = {
  tags: string[];
  rationale: string;
};

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function baseUrl(u: string) {
  const url = new URL(u);
  return `${url.origin}${url.pathname}`;
}

async function fetchJson<T>(urlRaw: string): Promise<T> {
  const url = baseUrl(urlRaw);
  const res = await fetch(`${url}?v=${Date.now()}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" }
  });
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  return (await res.json()) as T;
}

async function fetchManifest(manifestUrlRaw: string): Promise<ProjectManifest> {
  return await fetchJson<ProjectManifest>(manifestUrlRaw);
}

function sliceTextByAnchor(
  fullText: string,
  anchor?: { textSegments?: Array<{ startIndex?: number; endIndex?: number }> }
) {
  const segs = anchor?.textSegments;
  if (!fullText || !Array.isArray(segs) || segs.length === 0) return "";

  let out = "";
  for (const s of segs) {
    const a = Math.max(0, Number(s.startIndex ?? 0));
    const b = Math.max(a, Number(s.endIndex ?? 0));
    out += fullText.slice(a, b);
  }
  return out.trim();
}

function pageTextFromDocAi(raw: DocAiRaw, pageNumber1Based: number): string {
  const doc = raw.document;
  const fullText = typeof doc?.text === "string" ? doc.text : "";
  const pages = Array.isArray(doc?.pages) ? doc!.pages! : [];
  const page = pages[pageNumber1Based - 1];
  if (!page) return "";
  return sliceTextByAnchor(fullText, page.layout?.textAnchor);
}

function toBase64(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString("base64");
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depth++;
    if (c === "}") depth--;
    if (depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(
    new Set(
      tags
        .map((t) => String(t).trim())
        .filter(Boolean)
        .map((t) => t.toLowerCase())
    )
  );
}

async function callTagger(args: {
  aiRules: string;
  taggingJson: string;
  pageText: string;
  pageNumber: number;
  assetId: string;
  imageUrl: string;
}): Promise<TaggingResult> {
  const apiKey = getEnv("GEMINI_API_KEY");
  const model = "gemini-2.5-pro";

  // Fetch the PNG (real vision input)
  const imgRes = await fetch(`${baseUrl(args.imageUrl)}?v=${Date.now()}`, { cache: "no-store" });
  if (!imgRes.ok) throw new Error(`Cannot fetch image (${imgRes.status})`);
  const imgBuf = await imgRes.arrayBuffer();
  const imgB64 = toBase64(imgBuf);

  const system = `Return ONLY valid JSON with keys: "tags" (array of strings) and "rationale" (string). No markdown. No extra keys.`;

  // We keep your taggingJson “as rules” but the model must obey it.
  const promptObj = {
    aiRules: args.aiRules,
    taggingJson: args.taggingJson,
    context: {
      pageNumber: args.pageNumber,
      assetId: args.assetId,
      pageText: args.pageText
    },
    instruction:
      "Generate concise, reusable tags for the IMAGE. Tags must be coherent with pageText. Prefer stable nouns/adjectives useful for retrieval and later LoRA training. Avoid duplicates and overly generic tags."
  };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: system },
          { text: JSON.stringify(promptObj) },
          {
            inlineData: {
              mimeType: "image/png",
              data: imgB64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 512,
      responseMimeType: "application/json"
    }
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Gemini error (${resp.status}): ${t || resp.statusText}`);
  }

  const data = (await resp.json()) as unknown;

  // Try to read the first candidate text
  const text =
    (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> }).candidates?.[0]?.content
      ?.parts?.map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("") || "";

  if (!text) throw new Error("Gemini returned empty response text");

  // Expect JSON; fallback to extracting first {...}
  const jsonStr = text.trim().startsWith("{") ? text.trim() : extractFirstJsonObject(text);
  if (!jsonStr) throw new Error("Gemini returned non-JSON output");

  let parsed: TaggingResult;
  try {
    parsed = JSON.parse(jsonStr) as TaggingResult;
  } catch {
    throw new Error("Gemini returned invalid JSON");
  }

  if (!parsed || !Array.isArray(parsed.tags) || parsed.tags.length === 0 || typeof parsed.rationale !== "string") {
    throw new Error("Invalid tagger JSON shape");
  }

  return { tags: normalizeTags(parsed.tags), rationale: parsed.rationale.trim() };
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = String(body.projectId || "").trim();
  const manifestUrl = String(body.manifestUrl || "").trim();
  const limitAssets = Math.max(0, Number(body.limitAssets ?? 0));
  const overwrite = Boolean(body.overwrite ?? false);

  if (!projectId || !manifestUrl) {
    return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl" }, { status: 400 });
  }

  const manifest = await fetchManifest(manifestUrl);
  if (manifest.projectId !== projectId) {
    return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
  }

  if (!manifest.docAiJson?.url) {
    return NextResponse.json({ ok: false, error: "Missing docAiJson.url (run Process Text first)" }, { status: 400 });
  }

  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    return NextResponse.json({ ok: false, error: "No pages found (run Rasterize + Split first)" }, { status: 400 });
  }

  const raw = await fetchJson<DocAiRaw>(manifest.docAiJson.url);

  const aiRules = manifest.settings?.aiRules ?? "";
  const taggingJson = manifest.settings?.taggingJson ?? "{}";

  let scanned = 0;
  let tagged = 0;

  for (const page of manifest.pages) {
    if (!Array.isArray(page.assets) || page.assets.length === 0) continue;

    const pageText = pageTextFromDocAi(raw, page.pageNumber);

    for (const asset of page.assets) {
      scanned += 1;
      if (limitAssets > 0 && scanned > limitAssets) break;

      const alreadyTagged = Array.isArray(asset.tags) && asset.tags.length > 0;
      if (alreadyTagged && !overwrite) continue;

      const res = await callGeminiTagger({
        aiRules,
        taggingJson,
        pageText,
        pageNumber: page.pageNumber,
        assetId: asset.assetId,
        imageUrl: asset.url
      });

      asset.tags = res.tags;
      asset.tagRationale = res.rationale;
      tagged += 1;
    }

    if (limitAssets > 0 && scanned > limitAssets) break;
  }

  const newManifestUrl = await saveManifest(manifest);

  return NextResponse.json({ ok: true, manifestUrl: newManifestUrl, scanned, tagged });
}

import { NextResponse } from "next/server";
import { saveManifest, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  projectId?: string;
  manifestUrl?: string;
  limitAssets?: number; // optional safety
};

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

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function sliceTextByAnchor(fullText: string, anchor?: { textSegments?: Array<{ startIndex?: number; endIndex?: number }> }) {
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

type TaggingResult = {
  tags: string[];
  rationale: string;
};

async function callOpenAiTagger(args: {
  aiRules: string;
  taggingJson: string;
  pageText: string;
  assetId: string;
  pageNumber: number;
  imageUrl: string;
}): Promise<TaggingResult> {
  const apiKey = getEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const system = `You are an internal tagging engine.
Return ONLY valid JSON. No markdown. No extra keys.`;

  const user = {
    aiRules: args.aiRules,
    taggingJson: args.taggingJson,
    context: {
      pageNumber: args.pageNumber,
      assetId: args.assetId,
      imageUrl: args.imageUrl,
      pageText: args.pageText
    },
    task: "Generate concise, consistent tags for this image asset based on the pageText and the taggingJson. Keep tags stable and reusable."
  };

  // Strict JSON response contract
  const schema = {
    name: "asset_tags",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tags: { type: "array", items: { type: "string" }, minItems: 1 },
        rationale: { type: "string" }
      },
      required: ["tags", "rationale"]
    }
  } as const;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "text", text: system }] },
        { role: "user", content: [{ type: "text", text: JSON.stringify(user) }] }
      ],
      response_format: { type: "json_schema", json_schema: schema }
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI error (${resp.status}): ${t || resp.statusText}`);
  }

  const data = (await resp.json()) as unknown;

  // Responses API: easiest robust extraction is to find output_text
  const outputText =
    typeof (data as { output_text?: unknown }).output_text === "string"
      ? ((data as { output_text: string }).output_text as string)
      : "";

  if (!outputText) throw new Error("OpenAI returned no output_text");

  let parsed: TaggingResult;
  try {
    parsed = JSON.parse(outputText) as TaggingResult;
  } catch {
    throw new Error("OpenAI returned non-JSON output");
  }

  if (!parsed || !Array.isArray(parsed.tags) || parsed.tags.length === 0 || typeof parsed.rationale !== "string") {
    throw new Error("Invalid tagger JSON shape");
  }

  // normalize tags
  const tags = Array.from(
    new Set(
      parsed.tags
        .map((s) => String(s).trim())
        .filter(Boolean)
        .map((s) => s.toLowerCase())
    )
  );

  return { tags, rationale: parsed.rationale.trim() };
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

  let tagged = 0;
  let scanned = 0;

  for (const page of manifest.pages) {
    if (!Array.isArray(page.assets) || page.assets.length === 0) continue;

    const pageText = pageTextFromDocAi(raw, page.pageNumber);

    for (const asset of page.assets) {
      scanned += 1;
      if (limitAssets > 0 && scanned > limitAssets) break;

      // skip if already tagged
      if (Array.isArray(asset.tags) && asset.tags.length > 0) continue;

      const result = await callOpenAiTagger({
        aiRules,
        taggingJson,
        pageText,
        assetId: asset.assetId,
        pageNumber: page.pageNumber,
        imageUrl: asset.url
      });

      asset.tags = result.tags;
      // optional: store rationale without changing UI yet
      (asset as unknown as { tagRationale?: string }).tagRationale = result.rationale;

      tagged += 1;
    }

    if (limitAssets > 0 && scanned > limitAssets) break;
  }

  const newManifestUrl = await saveManifest(manifest);

  return NextResponse.json({
    ok: true,
    manifestUrl: newManifestUrl,
    tagged,
    scanned
  });
}

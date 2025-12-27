import { NextRequest, NextResponse } from "next/server";
import { fetchManifestDirect } from "@/app/lib/manifest";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      projectId?: string;
      manifestUrl?: string;
    };

    const { projectId, manifestUrl } = body;

    if (!projectId || !manifestUrl) {
      return NextResponse.json({ ok: false, error: "Missing projectId or manifestUrl" }, { status: 400 });
    }

    // Load manifest
    const manifest = await fetchManifestDirect(manifestUrl);

    // Get AI rules and schema JSON from settings
    const aiRules = manifest.settings?.aiRules ?? "";
    const schemaJsonRaw = manifest.settings?.schemaJson ?? "{}";

    let schemaDefinition: unknown;
    try {
      schemaDefinition = JSON.parse(schemaJsonRaw);
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid schemaJson in settings" }, { status: 400 });
    }

    // Load extracted text if available
    let extractedText = "";
    if (manifest.extractedText?.url) {
      try {
        const res = await fetch(manifest.extractedText.url);
        if (res.ok) {
          extractedText = await res.text();
        }
      } catch {
        // Continue without extracted text
      }
    }

    // Load formatted text if available (prefer this over extracted)
    let formattedText = "";
    if (manifest.formattedText?.url) {
      try {
        const res = await fetch(manifest.formattedText.url);
        if (res.ok) {
          formattedText = await res.text();
        }
      } catch {
        // Continue without formatted text
      }
    }

    // Use formatted text if available, otherwise extracted text
    const sourceText = formattedText || extractedText;

    if (!sourceText) {
      return NextResponse.json({ ok: false, error: "No extracted or formatted text available. Please process the PDF first." }, { status: 400 });
    }

    // Get assets with their URLs and tags for matching
    interface TaggedAsset {
      url: string;
      assetId: string;
      page: number;
      tags: string[];
    }
    const taggedAssets: TaggedAsset[] = [];
    
    if (manifest.pages) {
      for (const page of manifest.pages) {
        if (page.assets) {
          for (const asset of page.assets) {
            if (asset.url && asset.tags && asset.tags.length > 0) {
              taggedAssets.push({
                url: asset.url,
                assetId: asset.assetId,
                page: page.pageNumber,
                tags: asset.tags
              });
            }
          }
        }
      }
    }
    
    // Get unique tags for context
    const allTags = taggedAssets.flatMap(a => a.tags);
    const uniqueTags = [...new Set(allTags)].sort();

    // Build the prompt for Gemini
    const prompt = `You are an expert IP Bible creator. Your task is to fill in a structured schema based on the source material provided.

## AI RULES (follow strictly):
${aiRules}

## SCHEMA DEFINITION:
${JSON.stringify(schemaDefinition, null, 2)}

## SOURCE MATERIAL:
${sourceText}

## TAGGED ASSETS (images with their URLs and tags - USE THESE FOR IMAGE FIELDS):
${taggedAssets.length > 0 ? JSON.stringify(taggedAssets, null, 2) : "No tagged assets available."}

## UNIQUE TAGS FOUND:
${uniqueTags.length > 0 ? uniqueTags.join(", ") : "None"}

## ASSET MATCHING INSTRUCTIONS:
When populating image/asset fields in the schema, you MUST match tagged assets to the appropriate fields:

1. **For Character Images**: Search tagged assets for the character's name in the tags array. Match by:
   - Exact name match (highest confidence: 0.8+)
   - Partial name match (medium: 0.5-0.8)
   - Role match like "protagonist", "villain" (lower: 0.3-0.5)

2. **For Location Images**: Search for location name or environment type in tags.

3. **For Style Images**: Use assets with style-related tags (colors, art style, composition).

4. **Output Format for image fields**:
   - If a matching asset is found, return: { "url": "[actual asset URL]", "source": "extracted", "caption": "[brief description]", "_matchConfidence": 0.X, "_matchReason": "[why this asset matches]" }
   - If no asset matches with confidence >= 0.3, return: null

5. **CRITICAL**: Use the ACTUAL URLs from the tagged assets list above. Do NOT invent URLs.

## GENERAL INSTRUCTIONS:
1. Analyze the source material carefully
2. Fill the schema according to 3 levels:
   - L1: High-level overview (mostly images/key art references)
   - L2: Category breakdown (main text descriptions)  
   - L3: Detailed entries (full specifications)
3. For each domain (OVERVIEW, CHARACTERS, WORLD, LORE, STYLE, STORY), provide appropriate content
4. Be comprehensive but accurate - do NOT invent details not in the source material
5. Use "Unknown" for missing string fields, [] for missing arrays
6. For real-world locations (cities, countries), infer Setting, Context, Scale from world knowledge

## OUTPUT FORMAT:
Return ONLY valid JSON with this exact structure:
{
  "L1": {
    "OVERVIEW": { ... },
    "CHARACTERS": { ... },
    "WORLD": { ... },
    "LORE": { ... },
    "STYLE": { ... },
    "STORY": { ... }
  },
  "L2": {
    "OVERVIEW": { "IPTitle": "...", "Logline": "...", ... },
    "CHARACTERS": { "CharacterList": [...] },
    ...
  },
  "L3": {
    "CHARACTERS": { "CharacterList": [...] },
    "WORLD": { "Locations": [...] },
    ...
  }
}

Fill ALL fields based on the schema definition. Match the field names exactly.`;

    // Call Gemini
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();

    // Try to extract JSON from the response
    let cleanedText = text.trim();
    
    // Remove markdown code blocks if present
    if (cleanedText.startsWith("```json")) {
      cleanedText = cleanedText.slice(7);
    } else if (cleanedText.startsWith("```")) {
      cleanedText = cleanedText.slice(3);
    }
    if (cleanedText.endsWith("```")) {
      cleanedText = cleanedText.slice(0, -3);
    }
    cleanedText = cleanedText.trim();

    // Validate that it's valid JSON
    try {
      JSON.parse(cleanedText);
    } catch {
      // If not valid JSON, return the raw text anyway
      // User can edit it in the panel
    }

    // Format the JSON nicely
    let formattedResults = cleanedText;
    try {
      const parsed = JSON.parse(cleanedText);
      formattedResults = JSON.stringify(parsed, null, 2);
    } catch {
      // Keep as-is if parsing fails
    }

    return NextResponse.json({
      ok: true,
      results: formattedResults
    });
  } catch (err) {
    console.error("Schema fill error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

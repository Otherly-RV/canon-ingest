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

    // Get asset tags for additional context
    const assetTags: string[] = [];
    if (manifest.pages) {
      for (const page of manifest.pages) {
        if (page.assets) {
          for (const asset of page.assets) {
            if (asset.tags) {
              assetTags.push(...asset.tags);
            }
          }
        }
      }
    }
    const uniqueTags = [...new Set(assetTags)].sort();

    // Build the prompt for Gemini
    const prompt = `You are an expert IP Bible creator. Your task is to fill in a structured schema based on the source material provided.

## AI RULES (follow strictly):
${aiRules}

## SCHEMA DEFINITION:
${JSON.stringify(schemaDefinition, null, 2)}

## SOURCE MATERIAL:
${sourceText}

## VISUAL ASSET TAGS (for context about images/artwork):
${uniqueTags.length > 0 ? uniqueTags.join(", ") : "No tagged assets yet."}

## INSTRUCTIONS:
1. Analyze the source material carefully
2. Fill the schema according to 3 levels:
   - L1: High-level overview (mostly images/key art references)
   - L2: Category breakdown (main text descriptions)  
   - L3: Detailed entries (full specifications)
3. For each domain (OVERVIEW, CHARACTERS, WORLD, LORE, STYLE, STORY), provide appropriate content
4. Be comprehensive but accurate - do NOT invent details not in the source material
5. Use "Unknown" for missing string fields, [] for missing arrays
6. For asset fields (images), use null if no matching asset is available

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

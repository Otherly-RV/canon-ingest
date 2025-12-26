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
The schema has the following structure that you must fill:
${JSON.stringify(schemaDefinition, null, 2)}

## SOURCE MATERIAL:
${sourceText}

## VISUAL ASSET TAGS (for context about images/artwork):
${uniqueTags.length > 0 ? uniqueTags.join(", ") : "No tagged assets yet."}

## INSTRUCTIONS:
1. Analyze the source material carefully.
2. Fill in the schema according to the levels (L1=high-level overview, L2=category breakdown, L3=detailed entries).
3. For each category (OVERVIEW, CHARACTERS, WORLD, LORE, STYLE, STORY), provide appropriate content.
4. Be comprehensive but accurate - do not invent details not present in the source material.
5. Structure your response as valid JSON that matches the schema structure.
6. Include specific quotes or references from the source material where applicable.

## OUTPUT FORMAT:
Return ONLY valid JSON. The structure should follow the schema definition with filled content for each level and category.`;

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

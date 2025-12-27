import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_DETECT_MODEL = process.env.GEMINI_DETECT_MODEL || "gemini-2.0-flash";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  category?: string;
}

interface DetectionRules {
  targets?: string[];
  ignore?: string[];
  minimumSize?: { width: number; height: number };
  qualityThreshold?: number;
  cropPadding?: { default?: number; characters?: number; locations?: number };
  preferFullBleed?: string[];
  autoCategory?: boolean;
}

interface DetectRequest {
  pageUrl: string;
  pageWidth: number;
  pageHeight: number;
  detectionRules?: DetectionRules;
}

async function fetchPngAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

function buildPrompt(rules?: DetectionRules): string {
  const targets = rules?.targets?.length 
    ? rules.targets.join(", ")
    : "images, figures, photos, illustrations, diagrams, charts, graphics, character art, location scenes, logos";
  
  const ignoreList = rules?.ignore?.length
    ? `\n5. IGNORE these elements: ${rules.ignore.join(", ")}`
    : "\n5. IGNORE: decorative borders, page numbers, watermarks, tiny icons under 50px";
  
  const minSize = rules?.minimumSize
    ? `\n6. Minimum size: Only detect regions larger than ${rules.minimumSize.width}x${rules.minimumSize.height} pixels (as fraction of page)`
    : "\n6. Minimum size: Skip very small elements (less than 5% of page dimension)";
  
  const categoryInstruction = rules?.autoCategory
    ? `\n7. For each detection, include a "category" field with one of: character, location, keyArt, logo, diagram, style, other`
    : "";

  return `You are analyzing a scanned document page image. Your task is to detect all distinct visual assets.

DETECT these types: ${targets}

For each detected image region, output a JSON object with normalized bounding box coordinates:
- x: left edge as fraction of page width (0.0 to 1.0)
- y: top edge as fraction of page height (0.0 to 1.0)  
- width: width as fraction of page width
- height: height as fraction of page height${rules?.autoCategory ? '\n- category: type of image (character/location/keyArt/logo/diagram/style/other)' : ''}

Rules:
1. Only detect actual images/figures/graphics, NOT text blocks or captions
2. Include some margin/padding around each detected region for clean crops
3. If regions overlap significantly, merge them
4. Return an empty array if no images are found${ignoreList}${minSize}${categoryInstruction}

Output ONLY a valid JSON array of objects, no other text. Example:
[{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4${rules?.autoCategory ? ', "category": "character"' : ''}}]`;
}

async function detectWithGemini(
  pageUrl: string,
  pageWidth: number,
  pageHeight: number,
  rules?: DetectionRules
): Promise<Box[]> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: GEMINI_DETECT_MODEL });

  const base64 = await fetchPngAsBase64(pageUrl);

  const result = await model.generateContent([
    { text: buildPrompt(rules) },
    {
      inlineData: {
        mimeType: "image/png",
        data: base64
      }
    }
  ]);

  const text = result.response.text().trim();

  // Extract JSON array from response
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]) as Array<{ x: number; y: number; width: number; height: number; category?: string }>;

    // Convert normalized coords to pixel coords
    let boxes: Box[] = parsed.map((b) => ({
      x: Math.round(b.x * pageWidth),
      y: Math.round(b.y * pageHeight),
      width: Math.round(b.width * pageWidth),
      height: Math.round(b.height * pageHeight),
      category: b.category
    }));

    // Apply minimum size filtering if specified
    if (rules?.minimumSize) {
      const minW = rules.minimumSize.width;
      const minH = rules.minimumSize.height;
      boxes = boxes.filter((b) => b.width >= minW && b.height >= minH);
    }

    return boxes;
  } catch {
    console.error("Failed to parse Gemini response:", text);
    return [];
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as DetectRequest;
    const { pageUrl, pageWidth, pageHeight, detectionRules } = body;

    if (!pageUrl || !pageWidth || !pageHeight) {
      return NextResponse.json({ error: "Missing pageUrl, pageWidth, or pageHeight" }, { status: 400 });
    }

    const boxes = await detectWithGemini(pageUrl, pageWidth, pageHeight, detectionRules);

    return NextResponse.json({ boxes });
  } catch (err) {
    console.error("detect-gemini error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

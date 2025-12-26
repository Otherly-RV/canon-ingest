import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_DETECT_MODEL = process.env.GEMINI_DETECT_MODEL || process.env.GEMINI_MODEL || "gemini-2.0-flash";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DetectRequest {
  pageUrl: string;
  pageWidth: number;
  pageHeight: number;
}

async function fetchPngAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

function buildPrompt(): string {
  return `You are analyzing a scanned document page image. Your task is to detect all distinct images, figures, photos, illustrations, diagrams, charts, or graphics on this page.

For each detected image region, output a JSON object with normalized bounding box coordinates:
- x: left edge as fraction of page width (0.0 to 1.0)
- y: top edge as fraction of page height (0.0 to 1.0)  
- width: width as fraction of page width
- height: height as fraction of page height

Rules:
1. Only detect actual images/figures/graphics, NOT text blocks or captions
2. Include some margin around each detected region
3. If regions overlap significantly, merge them
4. Return an empty array if no images are found

Output ONLY a valid JSON array of objects, no other text. Example:
[{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4}]`;
}

async function detectWithGemini(pageUrl: string, pageWidth: number, pageHeight: number): Promise<Box[]> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: GEMINI_DETECT_MODEL });

  const base64 = await fetchPngAsBase64(pageUrl);

  const result = await model.generateContent([
    { text: buildPrompt() },
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
    const parsed = JSON.parse(match[0]) as Array<{ x: number; y: number; width: number; height: number }>;

    // Convert normalized coords to pixel coords
    return parsed.map((b) => ({
      x: Math.round(b.x * pageWidth),
      y: Math.round(b.y * pageHeight),
      width: Math.round(b.width * pageWidth),
      height: Math.round(b.height * pageHeight)
    }));
  } catch {
    console.error("Failed to parse Gemini response:", text);
    return [];
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as DetectRequest;
    const { pageUrl, pageWidth, pageHeight } = body;

    if (!pageUrl || !pageWidth || !pageHeight) {
      return NextResponse.json({ error: "Missing pageUrl, pageWidth, or pageHeight" }, { status: 400 });
    }

    const boxes = await detectWithGemini(pageUrl, pageWidth, pageHeight);

    return NextResponse.json({ boxes });
  } catch (err) {
    console.error("detect-gemini error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

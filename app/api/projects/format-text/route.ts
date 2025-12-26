import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

type Body = {
  text?: string;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Body;
    const text = String(body.text || "").trim();

    if (!text) {
      return NextResponse.json({ ok: false, error: "Missing text" }, { status: 400 });
    }

    if (!GEMINI_API_KEY) {
      return NextResponse.json({ ok: false, error: "GEMINI_API_KEY not configured" }, { status: 500 });
    }

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

    const prompt = `You are a document formatting assistant. The following text was extracted from a scanned PDF using OCR. It may have:
- Line breaks in the wrong places (mid-sentence)
- Missing paragraph breaks
- Headers/titles run together with body text
- Inconsistent spacing

Please reformat this text to be readable:
1. Combine lines that should be single sentences/paragraphs
2. Add proper paragraph breaks between distinct sections
3. Preserve headers/titles on their own lines
4. Fix obvious OCR artifacts if any
5. Do NOT change the actual content or wording

Return ONLY the reformatted text, no explanations.

---
${text}
---`;

    const result = await model.generateContent(prompt);
    const formatted = result.response.text().trim();

    return NextResponse.json({ ok: true, formatted });
  } catch (err) {
    console.error("format-text error:", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

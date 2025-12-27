import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type Body = {
  messages: Message[];
  settingsTab: string;
  currentContent: string;
  provider?: "gemini" | "openai";
};

const SYSTEM_PROMPT = `You are an expert AI assistant helping users write configuration JSON and AI rules for a creative IP (intellectual property) ingestion tool.

The tool processes PDF documents (story bibles, scripts, pitch decks) and extracts structured data into a schema covering:
- OVERVIEW: Title, logline, tone, main characters
- CHARACTERS: Character profiles, images, relationships
- WORLD: Locations, settings, environments
- LORE: History, factions, rules of the world
- STYLE: Visual style, colors, composition
- STORY: Timeline, arcs, episodes

Your role is to help users configure:

1. **AI Rules** (plain text): Instructions for how the AI should analyze and extract information. Examples:
   - "Focus on extracting character relationships and motivations"
   - "Infer historical context from time period mentions"
   - "Match character names to images using visual descriptions"

2. **Tagging JSON**: Configuration for how to tag extracted images/assets:
   \`\`\`json
   {
     "categories": ["character", "location", "style", "keyArt", "diagram"],
     "autoTags": ["portrait", "landscape", "action", "group"],
     "characterTags": ["protagonist", "antagonist", "supporting"]
   }
   \`\`\`

3. **Schema JSON**: Customizations to the extraction schema structure.

4. **Completeness Rules**: Weights for scoring how complete the extracted data is:
   \`\`\`json
   {
     "weights": {
       "OVERVIEW": 20,
       "CHARACTERS": 20,
       "WORLD": 15,
       "LORE": 15,
       "STYLE": 15,
       "STORY": 15
     }
   }
   \`\`\`

5. **Detection Rules**: Configuration for image detection/cropping:
   \`\`\`json
   {
     "targets": ["characters", "locations", "keyArt", "logos"],
     "ignore": ["decorativeBorders", "pageNumbers"],
     "minimumSize": { "width": 80, "height": 80 },
     "autoCategory": true
   }
   \`\`\`

When helping:
- Provide valid JSON when asked for configuration
- Explain what each field does
- Give concrete examples
- If the user shares their current config, suggest improvements
- Keep responses focused and practical
`;

async function chatWithGemini(messages: Message[], systemPrompt: string): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  // Build conversation history
  const history = messages.slice(0, -1).map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.content }]
  }));

  const chat = model.startChat({
    history: [
      { role: "user", parts: [{ text: "System context: " + systemPrompt }] },
      { role: "model", parts: [{ text: "Understood. I'm ready to help you configure your settings." }] },
      ...history
    ]
  });

  const lastMessage = messages[messages.length - 1];
  const result = await chat.sendMessage(lastMessage.content);
  return result.response.text();
}

async function chatWithOpenAI(messages: Message[], systemPrompt: string): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content
        }))
      ],
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "No response generated.";
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { messages, settingsTab, currentContent, provider = "gemini" } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ ok: false, error: "No messages provided" }, { status: 400 });
  }

  // Build context-aware system prompt
  const tabContext = `\n\nThe user is currently editing the "${settingsTab}" settings tab.${
    currentContent ? `\n\nTheir current content is:\n\`\`\`\n${currentContent}\n\`\`\`` : ""
  }`;

  const fullSystemPrompt = SYSTEM_PROMPT + tabContext;

  try {
    let response: string;

    if (provider === "openai" && OPENAI_API_KEY) {
      response = await chatWithOpenAI(messages, fullSystemPrompt);
    } else if (GEMINI_API_KEY) {
      response = await chatWithGemini(messages, fullSystemPrompt);
    } else {
      return NextResponse.json(
        { ok: false, error: "No AI provider configured. Set GEMINI_API_KEY or OPENAI_API_KEY." },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, response, provider: provider === "openai" && OPENAI_API_KEY ? "openai" : "gemini" });
  } catch (err) {
    console.error("AI helper error:", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

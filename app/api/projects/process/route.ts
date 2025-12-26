import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { saveManifest, fetchManifestDirect } from "@/app/lib/manifest";
import { GoogleAuth } from "google-auth-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = {
  projectId?: string;
  manifestUrl?: string;
};

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
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

async function fetchPdfBytes(sourceUrlRaw: string): Promise<Buffer> {
  const url = baseUrl(sourceUrlRaw);
  const res = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Cannot fetch source PDF (${res.status}): ${await readErrorText(res)}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function safeString(x: unknown): string {
  return typeof x === "string" ? x : "";
}

// Get OAuth2 access token using service account
async function getAccessToken(): Promise<string> {
  const saRaw = mustEnv("GCP_SA_KEY_JSON");
  const sa = JSON.parse(saRaw) as { client_email?: string; private_key?: string };
  
  if (!sa.client_email || !sa.private_key) {
    throw new Error("GCP_SA_KEY_JSON missing client_email/private_key");
  }

  const auth = new GoogleAuth({
    credentials: {
      client_email: sa.client_email,
      private_key: sa.private_key,
    },
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  
  if (!tokenResponse.token) {
    throw new Error("Failed to get access token");
  }
  
  return tokenResponse.token;
}

// Call Document AI REST API
async function processWithDocAI(pdfBytes: Buffer): Promise<{ fullText: string; raw: unknown }> {
  const projectId = mustEnv("GCP_PROJECT_ID");
  const location = mustEnv("DOCAI_LOCATION");
  const processorId = mustEnv("DOCAI_PROCESSOR_ID");

  const accessToken = await getAccessToken();
  
  const endpoint = `https://${location}-documentai.googleapis.com/v1/projects/${projectId}/locations/${location}/processors/${processorId}:process`;
  
  const content = pdfBytes.toString("base64");

  const requestBody = {
    rawDocument: {
      content,
      mimeType: "application/pdf"
    },
    skipHumanReview: true
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errorText = await readErrorText(res);
    
    // Check if it's a page limit error
    if (errorText.includes("exceed") || errorText.includes("15")) {
      return processInChunks(pdfBytes, accessToken, endpoint);
    }
    
    throw new Error(`Document AI error (${res.status}): ${errorText}`);
  }

  const result = await res.json();
  const doc = result.document as { text?: string } | undefined;
  const fullText = safeString(doc?.text);

  return { fullText, raw: result };
}

// Process large PDFs in chunks using page selector
async function processInChunks(
  pdfBytes: Buffer,
  accessToken: string,
  baseEndpoint: string
): Promise<{ fullText: string; raw: unknown }> {
  const CHUNK_SIZE = 15;
  const allTexts: string[] = [];
  const allRaws: unknown[] = [];
  let pageOffset = 1;
  let hasMorePages = true;
  const content = pdfBytes.toString("base64");

  while (hasMorePages && pageOffset <= 200) {
    const pages: number[] = [];
    for (let i = 0; i < CHUNK_SIZE; i++) {
      pages.push(pageOffset + i);
    }

    const requestBody = {
      rawDocument: {
        content,
        mimeType: "application/pdf"
      },
      skipHumanReview: true,
      processOptions: {
        individualPageSelector: { pages }
      }
    };

    try {
      const res = await fetch(baseEndpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        const errorText = await readErrorText(res);
        if (errorText.includes("page") || errorText.includes("INVALID_ARGUMENT") || errorText.includes("out of range")) {
          hasMorePages = false;
          continue;
        }
        throw new Error(`Document AI chunk error (${res.status}): ${errorText}`);
      }

      const result = await res.json();
      const doc = result.document as { text?: string; pages?: unknown[] } | undefined;
      const chunkText = safeString(doc?.text);

      if (chunkText.trim()) {
        allTexts.push(chunkText);
        allRaws.push(result);
      }

      const pagesReturned = Array.isArray(doc?.pages) ? doc.pages.length : 0;
      if (pagesReturned < CHUNK_SIZE) {
        hasMorePages = false;
      } else {
        pageOffset += CHUNK_SIZE;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("page") || errMsg.includes("INVALID_ARGUMENT") || errMsg.includes("out of range")) {
        hasMorePages = false;
      } else {
        throw err;
      }
    }
  }

  const fullText = allTexts.join("\n\n");
  const raw = allRaws.length === 1 ? allRaws[0] : { chunks: allRaws };

  return { fullText, raw };
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as Body;

    const projectId = String(body.projectId || "").trim();
    const manifestUrl = String(body.manifestUrl || "").trim();

    if (!projectId || !manifestUrl) {
      return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl" }, { status: 400 });
    }

    const manifest = await fetchManifestDirect(manifestUrl);

    if (manifest.projectId !== projectId) {
      return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
    }

    const sourceUrl = manifest.sourcePdf?.url;
    if (!sourceUrl) {
      return NextResponse.json({ ok: false, error: "No source PDF uploaded." }, { status: 400 });
    }

    // 1) Download source PDF bytes
    const pdfBytes = await fetchPdfBytes(sourceUrl);

    // 2) Document AI via REST API
    const { fullText, raw } = await processWithDocAI(pdfBytes);

    // 3) Store extracted text
    const textBlob = await put(`projects/${projectId}/extracted/text.txt`, fullText, {
      access: "public",
      contentType: "text/plain; charset=utf-8",
      addRandomSuffix: false
    });

    // 4) Store raw DocAI JSON
    const rawJson = JSON.stringify(raw, null, 2);
    const docAiBlob = await put(`projects/${projectId}/extracted/docai.json`, rawJson, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false
    });

    // 5) Update manifest
    const latest = await fetchManifestDirect(manifestUrl);
    if (latest.projectId !== projectId) {
      return NextResponse.json({ ok: false, error: "projectId does not match manifest on re-fetch" }, { status: 400 });
    }

    latest.extractedText = { url: textBlob.url };
    latest.docAiJson = { url: docAiBlob.url };
    latest.status = "processed";

    const newManifestUrl = await saveManifest(latest);

    return NextResponse.json({ ok: true, manifestUrl: newManifestUrl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { saveManifest, fetchManifestDirect, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function stripUndefined(obj: unknown): unknown {
  // keep JSON smaller and stable; optional
  return obj;
}

async function processWithDocAI(pdfBytes: Buffer): Promise<{ fullText: string; raw: unknown }> {
  const projectId = mustEnv("GCP_PROJECT_ID");
  const location = mustEnv("DOCAI_LOCATION");
  const processorId = mustEnv("DOCAI_PROCESSOR_ID");
  const saRaw = mustEnv("GCP_SA_KEY_JSON");

  const sa = JSON.parse(saRaw) as { client_email?: string; private_key?: string };
  if (!sa.client_email || !sa.private_key) throw new Error("GCP_SA_KEY_JSON missing client_email/private_key");

  const client = new DocumentProcessorServiceClient({
    apiEndpoint: `${location}-documentai.googleapis.com`,
    credentials: {
      client_email: sa.client_email,
      private_key: sa.private_key
    }
  });

  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;
  const content = pdfBytes.toString("base64");

  // First, do a quick request to find page count (process just page 1)
  const [probe] = await client.processDocument({
    name,
    rawDocument: { content, mimeType: "application/pdf" },
    skipHumanReview: true,
    processOptions: {
      individualPageSelector: { pages: [1] }
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const probeDoc = (probe as any).document;
  const totalPages = probeDoc?.pages?.length
    ? Math.max(...(probeDoc.pages as Array<{ pageNumber?: number }>).map((p) => p.pageNumber ?? 1))
    : 1;

  // If we can't determine total pages, try to get it from the PDF directly
  // For now, assume the probe gives us at least 1 page
  // We'll process in chunks of 15 pages max

  const CHUNK_SIZE = 15;
  const allTexts: string[] = [];
  const allRaws: unknown[] = [];

  // Calculate how many pages we actually have by checking if we got text
  // We'll iterate until we get empty results
  let pageOffset = 1;
  let hasMorePages = true;

  while (hasMorePages) {
    const pages: number[] = [];
    for (let i = 0; i < CHUNK_SIZE; i++) {
      pages.push(pageOffset + i);
    }

    try {
      const [result] = await client.processDocument({
        name,
        rawDocument: { content, mimeType: "application/pdf" },
        skipHumanReview: true,
        processOptions: {
          individualPageSelector: { pages }
        }
      });

      const doc = (result.document ?? null) as { text?: unknown; pages?: unknown[] } | null;
      const chunkText = safeString(doc?.text);

      if (chunkText.trim()) {
        allTexts.push(chunkText);
        allRaws.push(result);
      }

      // Check if we got fewer pages than requested (meaning we've reached the end)
      const pagesReturned = Array.isArray(doc?.pages) ? doc.pages.length : 0;
      if (pagesReturned < CHUNK_SIZE) {
        hasMorePages = false;
      } else {
        pageOffset += CHUNK_SIZE;
      }

      // Safety limit: don't process more than 200 pages
      if (pageOffset > 200) {
        hasMorePages = false;
      }
    } catch (err) {
      // If we get an error about page not existing, we've reached the end
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("page") || errMsg.includes("INVALID_ARGUMENT")) {
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

    // 2) Document AI
    const { fullText, raw } = await processWithDocAI(pdfBytes);

    // 3) Store extracted text
    const textBlob = await put(`projects/${projectId}/extracted/text.txt`, fullText, {
      access: "public",
      contentType: "text/plain; charset=utf-8",
      addRandomSuffix: false
    });

    // 4) Store raw DocAI JSON
    const rawJson = JSON.stringify(stripUndefined(raw), null, 2);
    const docAiBlob = await put(`projects/${projectId}/extracted/docai.json`, rawJson, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false
    });

    // 5) Update manifest
    // Re-fetch latest manifest to avoid race conditions
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

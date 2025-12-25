import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { saveManifest, type ProjectManifest } from "@/app/lib/manifest";

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

async function fetchManifest(manifestUrlRaw: string): Promise<ProjectManifest> {
  const url = baseUrl(manifestUrlRaw);
  const res = await fetch(`${url}?v=${Date.now()}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" }
  });
  if (!res.ok) throw new Error(`Cannot fetch manifest (${res.status}): ${await readErrorText(res)}`);
  return (await res.json()) as ProjectManifest;
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

  const [result] = await client.processDocument({
    name,
    rawDocument: {
      content: pdfBytes.toString("base64"),
      mimeType: "application/pdf"
    }
  });

  const raw = result as unknown;
  const doc = (result.document ?? null) as { text?: unknown } | null;
  const fullText = safeString(doc?.text);

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

    const manifest = await fetchManifest(manifestUrl);

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
    manifest.extractedText = { url: textBlob.url };
    manifest.docAiJson = { url: docAiBlob.url };
    manifest.status = "processed";

    const newManifestUrl = await saveManifest(manifest);

    return NextResponse.json({ ok: true, manifestUrl: newManifestUrl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

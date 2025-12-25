import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { saveManifest, type ProjectManifest } from "@/app/lib/manifest";
import { processWithDocAI } from "@/app/lib/docai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  projectId?: string;
  manifestUrl?: string;
};

function baseUrl(u: string) {
  const url = new URL(u);
  return `${url.origin}${url.pathname}`;
}

async function fetchManifest(manifestUrlRaw: string): Promise<ProjectManifest> {
  const url = baseUrl(manifestUrlRaw);
  const res = await fetch(`${url}?v=${Date.now()}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" }
  });
  if (!res.ok) throw new Error(`Cannot fetch manifest (${res.status})`);
  return (await res.json()) as ProjectManifest;
}

async function fetchPdfAsBuffer(pdfUrlRaw: string): Promise<Buffer> {
  const url = baseUrl(pdfUrlRaw);
  const res = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Cannot fetch PDF (${res.status})`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = String(body.projectId || "").trim();
  const manifestUrlRaw = String(body.manifestUrl || "").trim();

  if (!projectId || !manifestUrlRaw) {
    return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl" }, { status: 400 });
  }

  let manifest: ProjectManifest;
  try {
    manifest = await fetchManifest(manifestUrlRaw);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }

  if (manifest.projectId !== projectId) {
    return NextResponse.json({ ok: false, error: "projectId does not match manifest" }, { status: 400 });
  }

  const sourceUrl = manifest.sourcePdf?.url;
  if (!sourceUrl) {
    return NextResponse.json({ ok: false, error: "No source PDF uploaded." }, { status: 400 });
  }

  // Fetch PDF bytes from Blob → Buffer
  const pdfBuffer = await fetchPdfAsBuffer(sourceUrl);

  // Run Document AI on bytes
  const result = await processWithDocAI(pdfBuffer);

  // Store extracted text
  const textBlob = await put(`projects/${projectId}/extracted/text.txt`, result.text, {
    access: "public",
    contentType: "text/plain; charset=utf-8",
    addRandomSuffix: false
  });

  // Store raw DocAI JSON
  const rawJsonString = JSON.stringify(result.raw, null, 2);
  const docAiBlob = await put(`projects/${projectId}/docai/result.json`, rawJsonString, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false
  });

  // Update manifest
  manifest.extractedText = { url: textBlob.url };
  manifest.docAiJson = { url: docAiBlob.url };
  manifest.status = "processed";

  const newManifestUrl = await saveManifest(manifest);

  return NextResponse.json({
    ok: true,
    manifestUrl: newManifestUrl,
    extractedTextUrl: textBlob.url,
    docAiJsonUrl: docAiBlob.url
  });
}

import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { processWithDocAI } from "@/app/lib/docai";
import { saveManifest, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReqBody = { projectId?: string; manifestUrl?: string };

function baseUrl(u: string) {
  const url = new URL(u);
  return `${url.origin}${url.pathname}`;
}

export async function POST(req: Request) {
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = body.projectId;
  const manifestUrlRaw = body.manifestUrl;

  if (!projectId || !manifestUrlRaw) {
    return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl" }, { status: 400 });
  }

  // Always fetch manifest with cache-bust
  const manifestUrl = baseUrl(manifestUrlRaw);
  const mRes = await fetch(`${manifestUrl}?v=${Date.now()}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" }
  });

  if (!mRes.ok) {
    return NextResponse.json({ ok: false, error: `Cannot fetch manifest (${mRes.status})` }, { status: 400 });
  }
  const manifest = (await mRes.json()) as ProjectManifest;

  if (!manifest.sourcePdf?.url) {
    return NextResponse.json({ ok: false, error: "No source PDF uploaded." }, { status: 400 });
  }

  const pdfRes = await fetch(`${manifest.sourcePdf.url}?v=${Date.now()}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" }
  });
  if (!pdfRes.ok) {
    return NextResponse.json({ ok: false, error: `Cannot fetch PDF (${pdfRes.status})` }, { status: 400 });
  }
  const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());

  const extract = await processWithDocAI(pdfBytes);

  const textBlob = await put(
    `projects/${projectId}/extracted/text.json`,
    JSON.stringify({ fullText: extract.fullText, pages: extract.pages }, null, 2),
    { access: "public", contentType: "application/json", addRandomSuffix: false }
  );

  manifest.extractedText = { url: textBlob.url };
  manifest.status = "processed";

  const newManifestUrl = await saveManifest(manifest);

  return NextResponse.json({
    ok: true,
    extractedTextUrl: textBlob.url,
    manifestUrl: newManifestUrl
  });
}

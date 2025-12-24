import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { processWithDocAI } from "@/app/lib/docai";
import { saveManifest, type ProjectManifest } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReqBody = {
  projectId?: string;
  manifestUrl?: string;
};

export async function POST(req: Request) {
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = body.projectId;
  const manifestUrl = body.manifestUrl;

  if (!projectId || !manifestUrl) {
    return NextResponse.json({ ok: false, error: "Missing projectId/manifestUrl" }, { status: 400 });
  }

  // Load manifest
  const mRes = await fetch(manifestUrl, { cache: "no-store" });
  if (!mRes.ok) {
    return NextResponse.json(
      { ok: false, error: `Cannot fetch manifest (${mRes.status})` },
      { status: 400 }
    );
  }
  const manifest = (await mRes.json()) as ProjectManifest;

  if (!manifest.sourcePdf?.url) {
    return NextResponse.json({ ok: false, error: "No source PDF uploaded." }, { status: 400 });
  }

  // Fetch PDF bytes from Blob URL
  const pdfRes = await fetch(manifest.sourcePdf.url, { cache: "no-store" });
  if (!pdfRes.ok) {
    return NextResponse.json(
      { ok: false, error: `Cannot fetch PDF (${pdfRes.status})` },
      { status: 400 }
    );
  }
  const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());

  // Document AI extraction
  const extract = await processWithDocAI(pdfBytes);

  // Store extracted text JSON in Blob
  const textBlob = await put(
    `projects/${projectId}/extracted/text.json`,
    JSON.stringify({ fullText: extract.fullText, pages: extract.pages }, null, 2),
    {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false
    }
  );

  // Update manifest
  manifest.extractedText = { url: textBlob.url };
  manifest.status = "processed";

  const newManifestUrl = await saveManifest(manifest);

  return NextResponse.json({
    ok: true,
    extractedTextUrl: textBlob.url,
    manifestUrl: newManifestUrl
  });
}

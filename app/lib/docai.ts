import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import type { protos } from "@google-cloud/documentai";

function getServiceAccountJson(): { client_email: string; private_key: string } {
  const raw = process.env.GCP_SA_KEY_JSON;
  if (!raw) throw new Error("Missing GCP_SA_KEY_JSON");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("GCP_SA_KEY_JSON is not valid JSON (must be a single-line JSON object)");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("GCP_SA_KEY_JSON must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;
  const client_email = obj["client_email"];
  const private_key = obj["private_key"];

  if (typeof client_email !== "string" || typeof private_key !== "string") {
    throw new Error("GCP_SA_KEY_JSON must include string fields client_email and private_key");
  }

  return { client_email, private_key };
}

export type DocAIExtract = {
  fullText: string;
  pages: Array<{ pageNumber: number; text: string }>;
};

function sliceTextAnchors(
  fullText: string,
  anchors?: protos.google.cloud.documentai.v1.Document.ITextAnchor | null
) {
  const segments = anchors?.textSegments ?? [];
  if (!segments.length) return "";

  const parts: string[] = [];
  for (const seg of segments) {
    const start = Number(seg.startIndex ?? 0);
    const end = Number(seg.endIndex ?? 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    parts.push(fullText.slice(start, end));
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export async function processWithDocAI(pdfBytes: Buffer): Promise<DocAIExtract> {
  const projectId = process.env.GCP_PROJECT_ID;
  const location = process.env.DOCAI_LOCATION;
  const processorId = process.env.DOCAI_PROCESSOR_ID;

  if (!projectId || !location || !processorId) {
    throw new Error("Missing GCP_PROJECT_ID / DOCAI_LOCATION / DOCAI_PROCESSOR_ID");
  }

  const sa = getServiceAccountJson();

  const client = new DocumentProcessorServiceClient({
    credentials: {
      client_email: sa.client_email,
      private_key: sa.private_key
    }
  });

  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;

  const request: protos.google.cloud.documentai.v1.IProcessRequest = {
    name,
    rawDocument: {
      content: pdfBytes.toString("base64"),
      mimeType: "application/pdf"
    }
  };

  const [result] = await client.processDocument(request);
  const doc = result.document;
  if (!doc) throw new Error("Document AI returned no document");

  const fullText = doc.text ?? "";
  const pages = (doc.pages ?? []).map((p, idx) => ({
    pageNumber: idx + 1,
    text: sliceTextAnchors(fullText, p.layout?.textAnchor ?? null)
  }));

  return { fullText, pages };
}

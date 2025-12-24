import { DocumentProcessorServiceClient } from "@google-cloud/documentai";

function getServiceAccountJson() {
  const raw = process.env.GCP_SA_KEY_JSON;
  if (!raw) throw new Error("Missing GCP_SA_KEY_JSON");

  // Vercel env often stores JSON with escaped newlines; parse normally.
  // If someone pasted a JSON string with literal "\\n", JSON.parse will keep \n as real newlines in JS strings.
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error("GCP_SA_KEY_JSON is not valid JSON (must be a single-line JSON object)");
  }
}

export type DocAIExtract = {
  fullText: string;
  pages: Array<{ pageNumber: number; text: string }>;
};

function sliceTextAnchors(fullText: string, textAnchor?: any) {
  const segs = textAnchor?.textSegments ?? [];
  if (!Array.isArray(segs) || segs.length === 0) return "";

  return segs
    .map((s: any) => {
      const start = Number(s.startIndex ?? 0);
      const end = Number(s.endIndex ?? 0);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "";
      return fullText.slice(start, end);
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function processWithDocAI(pdfBytes: Buffer): Promise<DocAIExtract> {
  const projectId = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_LOCATION;
  const processorId = process.env.GCP_PROCESSOR_ID;

  if (!projectId || !location || !processorId) {
    throw new Error("Missing GCP_PROJECT_ID / GCP_LOCATION / GCP_PROCESSOR_ID");
  }

  const sa = getServiceAccountJson();

  const client = new DocumentProcessorServiceClient({
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

  const doc = result.document;
  if (!doc) throw new Error("Document AI returned no document");

  const fullText = doc.text ?? "";
  const pages = (doc.pages ?? []).map((p: any, idx: number) => ({
    pageNumber: idx + 1,
    text: sliceTextAnchors(fullText, p.layout?.textAnchor)
  }));

  return { fullText, pages };
}

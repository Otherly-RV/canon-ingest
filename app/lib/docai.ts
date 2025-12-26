import { DocumentProcessorServiceClient } from "@google-cloud/documentai";

export type DocAIResult = {
  text: string;
  raw: unknown;
};

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function parseServiceAccountJson(): Record<string, unknown> {
  const raw = getEnv("GCP_SA_KEY_JSON");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("GCP_SA_KEY_JSON is not an object");
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Invalid GCP_SA_KEY_JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function buildClient(): DocumentProcessorServiceClient {
  const sa = parseServiceAccountJson();

  // documentai client expects fields like client_email/private_key; we keep it untyped here but not "any"
  const credentials = sa as unknown as { client_email?: string; private_key?: string };

  return new DocumentProcessorServiceClient({
    credentials: {
      client_email: credentials.client_email,
      private_key: credentials.private_key
    }
  });
}

function processorName(): string {
  const projectId = getEnv("DOCAI_PROJECT_ID");
  const location = getEnv("DOCAI_LOCATION");
  const processorId = getEnv("DOCAI_PROCESSOR_ID");
  return `projects/${projectId}/locations/${location}/processors/${processorId}`;
}

export async function processWithDocAI(pdfBytes: Buffer): Promise<DocAIResult> {
  const client = buildClient();
  const name = processorName();

  const [result] = await client.processDocument({
    name,
    rawDocument: {
      content: pdfBytes,
      mimeType: "application/pdf"
    }
  });

  // result.document is the parsed DocAI document
  const doc = (result as unknown as { document?: { text?: string } }).document;
  const text = typeof doc?.text === "string" ? doc.text : "";

  return {
    text,
    raw: result as unknown
  };
}

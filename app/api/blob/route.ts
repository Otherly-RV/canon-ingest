import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Clone so we can safely read JSON without consuming the original stream
  const cloned = request.clone();

  const body = (await cloned.json()) as HandleUploadBody;

  const result = await handleUpload({
    request,
    body,
    onBeforeGenerateToken: async () => {
      return {
        allowedContentTypes: ["image/png"]
      };
    },
    onUploadCompleted: async () => {
      // no-op
    }
  });

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

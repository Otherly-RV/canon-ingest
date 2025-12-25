import { handleUpload } from "@vercel/blob/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Newer @vercel/blob types require `body` in HandleUploadOptions
  // The client posts JSON, so parse it once and pass it through.
  const body = (await request.json()) as unknown;

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

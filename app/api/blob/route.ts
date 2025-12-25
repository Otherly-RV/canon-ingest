import { handleUpload } from "@vercel/blob/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const result = await handleUpload({
    request,
    onBeforeGenerateToken: async () => {
      return {
        allowedContentTypes: ["image/png"]
      };
    },
    onUploadCompleted: async () => {
      // no-op
    }
  });

  // Next.js wants a Response. handleUpload returns an object payload.
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

import { handleUpload } from "@vercel/blob/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleUpload({
    request,
    // You can add auth here later if needed.
    onBeforeGenerateToken: async (pathname: string) => {
      // Lock down to PNG only (your requirement)
      return {
        allowedContentTypes: ["image/png"],
        tokenPayload: JSON.stringify({ pathname })
      };
    },
    onUploadCompleted: async () => {
      // optional: log / webhook later
    }
  });
}

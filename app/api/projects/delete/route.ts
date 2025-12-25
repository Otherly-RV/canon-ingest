import { NextResponse } from "next/server";
import { del, list } from "@vercel/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { projectId?: string };

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = (body.projectId || "").trim();
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "Missing projectId" }, { status: 400 });
  }

  const prefix = `projects/${projectId}/`;

  // 1) List all blobs under prefix (paginate)
  const urls: string[] = [];
  let cursor: string | undefined = undefined;

  for (;;) {
    const page = await list({ prefix, limit: 1000, cursor });
    for (const b of page.blobs) {
      urls.push(b.url);
    }
    cursor = page.cursor ?? undefined;
    if (!cursor) break;
  }

  // 2) Delete by URL array (this matches older/newer @vercel/blob types)
  if (urls.length > 0) {
    await del(urls);
  }

  return NextResponse.json({ ok: true, deletedPrefix: prefix, deletedCount: urls.length });
}

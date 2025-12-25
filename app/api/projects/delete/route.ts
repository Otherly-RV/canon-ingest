import { NextResponse } from "next/server";
import { del, list } from "@vercel/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { projectId?: string };

type ListResult = {
  blobs: Array<{ url: string; pathname?: string }>;
  cursor?: string | null;
};

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

  const urls: string[] = [];
  let cursor: string | undefined = undefined;

  for (;;) {
    const page = (await list({ prefix, limit: 1000, cursor })) as unknown as ListResult;

    for (const b of page.blobs) {
      if (typeof b.url === "string" && b.url.length > 0) urls.push(b.url);
    }

    const next = page.cursor ?? undefined;
    cursor = typeof next === "string" && next.length > 0 ? next : undefined;

    if (!cursor) break;
  }

  if (urls.length > 0) {
    await del(urls);
  }

  return NextResponse.json({ ok: true, deletedPrefix: prefix, deletedCount: urls.length });
}

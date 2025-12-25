import { NextResponse } from "next/server";
import { del } from "@vercel/blob";

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

  await del({ prefix: `projects/${projectId}/` });

  return NextResponse.json({ ok: true, deletedPrefix: `projects/${projectId}/` });
}

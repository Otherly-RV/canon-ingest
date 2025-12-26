import { NextResponse } from "next/server";
import { fetchManifestDirect } from "@/app/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { manifestUrl?: string };

export async function POST(req: Request): Promise<Response> {
  try {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const manifestUrlRaw = (body.manifestUrl || "").trim();
    if (!manifestUrlRaw) {
      return NextResponse.json({ ok: false, error: "Missing manifestUrl" }, { status: 400 });
    }

    const manifest = await fetchManifestDirect(manifestUrlRaw);
    return NextResponse.json({ ok: true, manifest });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

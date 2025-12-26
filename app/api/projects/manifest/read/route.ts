import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { manifestUrl?: string };

function baseUrl(u: string) {
  const url = new URL(u);
  return `${url.origin}${url.pathname}`;
}

async function readErrorText(res: Response) {
  try {
    const t = await res.text();
    return t || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

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

    const url = `${baseUrl(manifestUrlRaw)}?v=${Date.now()}`;

    const res = await fetch(url, { 
      cache: "no-store",
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `Cannot fetch manifest (${res.status}): ${await readErrorText(res)}` },
        { status: 400 }
      );
    }

    const json = (await res.json()) as unknown;
    return NextResponse.json({ ok: true, manifest: json });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

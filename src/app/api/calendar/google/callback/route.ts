import { NextRequest, NextResponse } from "next/server";
import { consumeGoogleOAuthState, exchangeGoogleOAuthCode, readGoogleOAuthClientConfig } from "@/lib/calendar-providers";

export const dynamic = "force-dynamic";

const DEFAULT_CALLBACK = "http://127.0.0.1:3333/api/calendar/google/callback";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(new URL(`/calendar?tab=providers&google=oauth-error&reason=${encodeURIComponent(error)}`, request.url));
  }

  const code = String(url.searchParams.get("code") || "").trim();
  const state = String(url.searchParams.get("state") || "").trim();
  if (!code) {
    return NextResponse.redirect(new URL("/calendar?tab=providers&google=oauth-error&reason=missing_code", request.url));
  }
  const validState = await consumeGoogleOAuthState(state);
  if (!validState) {
    return NextResponse.redirect(new URL("/calendar?tab=providers&google=oauth-error&reason=state_mismatch", request.url));
  }

  try {
    const cfg = await readGoogleOAuthClientConfig();
    const redirectUri = cfg?.redirectUri || DEFAULT_CALLBACK;
    await exchangeGoogleOAuthCode(code, redirectUri);
    return NextResponse.redirect(new URL("/calendar?tab=providers&google=connected", request.url));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return NextResponse.redirect(
      new URL(`/calendar?tab=providers&google=oauth-error&reason=${encodeURIComponent(reason)}`, request.url)
    );
  }
}

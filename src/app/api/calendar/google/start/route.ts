import { NextRequest, NextResponse } from "next/server";
import { putGoogleOAuthState, readGoogleOAuthClientConfig } from "@/lib/calendar-providers";

export const dynamic = "force-dynamic";

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar";
const DEFAULT_CALLBACK = "http://127.0.0.1:3333/api/calendar/google/callback";

export async function GET(_request: NextRequest) {
  const cfg = await readGoogleOAuthClientConfig();
  if (!cfg?.clientId) {
    return NextResponse.json({ ok: false, error: "Google OAuth client is not configured" }, { status: 400 });
  }

  const state = await putGoogleOAuthState(10 * 60);
  const redirectUri = cfg.redirectUri || DEFAULT_CALLBACK;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return NextResponse.redirect(authUrl);
}

import { NextResponse } from "next/server";
import { getBexio } from "@/lib/bexio";
import { createClient } from "@/lib/supabase/server";

// "Sign in with Bexio" through Supabase Auth's custom OIDC provider
// (BEXIO_SUPABASE_PROVIDER, e.g. "custom:bexio"). Supabase hands the provider
// tokens to the app exactly once, here; the library takes them over.
// Not yet verified against live Bexio: Supabase Auth requires a public HTTPS
// issuer, so this can't run against the local mock (see examples/README.md).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code)
    return NextResponse.redirect(new URL("/?auth_error=missing_code", url));
  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session) {
    return NextResponse.redirect(new URL("/?auth_error=exchange_failed", url));
  }
  const {
    access_token,
    refresh_token,
    provider_token,
    provider_refresh_token,
    user,
  } = data.session;
  try {
    if (provider_token) {
      await getBexio().saveGrant({
        ownerId: user.id,
        tokens: {
          accessToken: provider_token,
          refreshToken: provider_refresh_token,
        },
      });
    }
  } finally {
    // exchangeCodeForSession stored the whole session, provider tokens
    // included, in the (JavaScript-readable) auth cookie. Re-save it without
    // them, so the grant is the only place the Bexio tokens live.
    await supabase.auth.setSession({ access_token, refresh_token });
  }
  return NextResponse.redirect(new URL("/", url));
}

import { NextResponse } from "next/server";
import { getBexio } from "@/lib/bexio";
import { createClient } from "@/lib/supabase/server";

// "Sign in with Bexio" through Supabase Auth's custom OIDC provider
// (BEXIO_SUPABASE_PROVIDER, e.g. "custom:bexio"). Supabase hands the provider
// tokens to the app exactly once, here; the library takes them over.
// Verified manually against live Bexio only: Supabase Auth requires a public
// HTTPS issuer, so it can't run against the local mock (see examples/README.md).
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
  const { provider_token, provider_refresh_token, user } = data.session;
  if (provider_token) {
    await getBexio().saveGrant({
      ownerId: user.id,
      tokens: {
        accessToken: provider_token,
        refreshToken: provider_refresh_token,
      },
    });
  }
  return NextResponse.redirect(new URL("/", url));
}

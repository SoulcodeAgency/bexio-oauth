import { NextResponse } from "next/server";
import { getBexio } from "@/lib/bexio";
import { createClient } from "@/lib/supabase/server";

// "Sign in with Bexio" through Supabase Auth's custom OIDC provider
// (BEXIO_SUPABASE_PROVIDER, e.g. "custom:bexio"). exchangeCodeForSession
// returns the provider tokens once; the library takes them over, and the
// Supabase session is re-saved without them.
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
  let resaveFailed = false;
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
    const resaved = await supabase.auth.setSession({
      access_token,
      refresh_token,
    });
    if (resaved.error) {
      // setSession reports instead of throwing. Never keep a cookie that
      // still holds the Bexio tokens: drop the local session.
      await supabase.auth.signOut({ scope: "local" });
      resaveFailed = true;
    }
  }
  if (resaveFailed) {
    return NextResponse.redirect(
      new URL("/?auth_error=session_resave_failed", url),
    );
  }
  return NextResponse.redirect(new URL("/", url));
}

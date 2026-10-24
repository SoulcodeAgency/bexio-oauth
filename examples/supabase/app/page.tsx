import { signInWithBexio, signOut, signUpOrIn } from "@/app/actions";
import { Grants } from "@/components/grants";
import { getUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ bexio_error?: string; auth_error?: string }>;
}) {
  const { bexio_error, auth_error } = await searchParams;
  const user = await getUser();
  if (!user) {
    return (
      <main>
        <h1>Supabase Auth + bexio-oauth</h1>
        {auth_error && <p data-testid="auth-error">Auth error: {auth_error}</p>}
        <form action={signUpOrIn}>
          <input
            name="email"
            type="email"
            placeholder="email"
            required
            data-testid="email"
          />
          <input
            name="password"
            type="password"
            placeholder="password"
            required
            data-testid="password"
          />
          <button data-testid="sign-in">Sign up / sign in</button>
        </form>
        {process.env.BEXIO_SUPABASE_PROVIDER && (
          <form action={signInWithBexio}>
            <button data-testid="sign-in-bexio">Sign in with Bexio</button>
          </form>
        )}
      </main>
    );
  }
  return (
    <main>
      <h1>
        Hello {user.email}{" "}
        <form action={signOut} style={{ display: "inline" }}>
          <button data-testid="sign-out">Sign out</button>
        </form>
      </h1>
      {bexio_error && (
        <p data-testid="bexio-error">Bexio error: {bexio_error}</p>
      )}
      <h2>
        Your Bexio connection{" "}
        <a data-testid="connect" href="/api/bexio/connect">
          Connect Bexio
        </a>
      </h2>
      <Grants ownerId={user.id} />
    </main>
  );
}

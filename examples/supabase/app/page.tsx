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
        <div className="signin">
          <h1>Supabase Auth + bexio-oauth</h1>
          {auth_error && (
            <p className="notice" data-testid="auth-error">
              {auth_error}
            </p>
          )}
          <form action={signUpOrIn}>
            <input
              name="email"
              type="email"
              placeholder="Email"
              required
              data-testid="email"
            />
            <input
              name="password"
              type="password"
              placeholder="Password"
              required
              data-testid="password"
            />
            <button className="primary" data-testid="sign-in">
              Sign in or sign up
            </button>
          </form>
          {process.env.BEXIO_SUPABASE_PROVIDER && (
            <form action={signInWithBexio}>
              <button data-testid="sign-in-bexio">Sign in with Bexio</button>
            </form>
          )}
        </div>
      </main>
    );
  }
  return (
    <main>
      <header className="top">
        <h1>Hello {user.email}</h1>
        <form action={signOut}>
          <button data-testid="sign-out">Sign out</button>
        </form>
      </header>
      {bexio_error && (
        <p className="notice" data-testid="bexio-error">
          Bexio error: {bexio_error}
        </p>
      )}

      <div className="section-head">
        <h2>Your Bexio</h2>
        <a
          className="button primary"
          data-testid="connect"
          href="/api/bexio/connect"
        >
          Connect Bexio
        </a>
      </div>
      <section className="owner">
        <Grants ownerId={user.id} />
      </section>
    </main>
  );
}

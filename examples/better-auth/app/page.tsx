import { SignInWithBexio, SignOut } from "@/components/auth-buttons";
import { Grants } from "@/components/grants";
import { WORKSPACES, workspaceOwner } from "@/lib/bexio";
import { getSession } from "@/lib/session";
import { runRefreshIdle } from "@/app/actions";
import { testToolsEnabled } from "@/lib/test-tools";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ bexio_error?: string; refresh_idle?: string }>;
}) {
  const { bexio_error, refresh_idle } = await searchParams;
  const session = await getSession();
  if (!session) {
    return (
      <main>
        <h1>Better Auth + bexio-oauth</h1>
        <p>
          Sign in with Bexio: Better Auth runs the login, the library keeps the
          tokens.
        </p>
        <SignInWithBexio />
      </main>
    );
  }
  return (
    <main>
      <h1>
        Hello {session.user.name} <SignOut />
      </h1>
      {bexio_error && (
        <p data-testid="bexio-error">Bexio error: {bexio_error}</p>
      )}
      {testToolsEnabled() && (
        <form action={runRefreshIdle}>
          <button data-testid="run-refresh-idle">
            Run refreshIdle (what the cron does)
          </button>{" "}
          {refresh_idle && (
            <small data-testid="refresh-idle-result">{refresh_idle}</small>
          )}
        </form>
      )}

      <h2>Your Bexio login (saveGrant)</h2>
      <Grants ownerId={session.user.id} connectHref="/api/bexio/connect" />

      <h2>Workspaces (Connect Bexio)</h2>
      {WORKSPACES.map((slug) => (
        <section key={slug} data-testid={`workspace-${slug}`}>
          <h3>
            Workspace {slug}{" "}
            <a
              data-testid={`connect-${slug}`}
              href={`/api/bexio/connect?workspace=${slug}`}
            >
              Connect Bexio
            </a>
          </h3>
          <Grants
            ownerId={workspaceOwner(slug)}
            connectHref={`/api/bexio/connect?workspace=${slug}`}
          />
        </section>
      ))}
    </main>
  );
}

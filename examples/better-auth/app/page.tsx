import type { RefreshIdleResult } from "@soulcode/bexio-oauth";
import { runRefreshIdle } from "@/app/actions";
import { SignInWithBexio, SignOut } from "@/components/auth-buttons";
import { Grants } from "@/components/grants";
import { WORKSPACES, workspaceOwner } from "@/lib/bexio";
import { getSession } from "@/lib/session";
import { testToolsEnabled } from "@/lib/test-tools";

export const dynamic = "force-dynamic";

/** "2 refreshed, 1 reauth required": the non-zero counts of a refreshIdle run. */
function describeRun(json: string): string {
  const result = JSON.parse(json) as RefreshIdleResult;
  const parts = [
    [result.refreshed, "refreshed"],
    [result.skipped, "skipped"],
    [result.reauthRequired, "reauth required"],
    [result.failed, "failed"],
    [result.remaining, "remaining"],
  ]
    .filter(([count]) => count)
    .map(([count, label]) => `${count} ${label}`);
  return parts.length ? parts.join(", ") : "nothing idle";
}

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
        <div className="signin">
          <h1>Better Auth + bexio-oauth</h1>
          <SignInWithBexio />
        </div>
      </main>
    );
  }
  return (
    <main>
      <header className="top">
        <h1>Hello {session.user.name}</h1>
        <div className="top-actions">
          {testToolsEnabled() && (
            <form action={runRefreshIdle}>
              {refresh_idle && (
                <span className="result" data-testid="refresh-idle-result">
                  {describeRun(refresh_idle)}{" "}
                </span>
              )}
              <button
                data-testid="run-refresh-idle"
                title="What the cron does: refresh every idle connection"
              >
                Run refreshIdle
              </button>
            </form>
          )}
          <SignOut />
        </div>
      </header>
      {bexio_error && (
        <p className="notice" data-testid="bexio-error">
          Bexio error: {bexio_error}
        </p>
      )}

      <h2>Your login</h2>
      <section className="owner">
        <Grants ownerId={session.user.id} connectHref="/api/bexio/connect" />
      </section>

      <h2>Workspaces</h2>
      <div className="owners">
        {WORKSPACES.map((slug) => (
          <section
            key={slug}
            className="owner"
            data-testid={`workspace-${slug}`}
          >
            <div className="owner-head">
              <h3>Workspace {slug}</h3>
              <a
                className="button primary"
                data-testid={`connect-${slug}`}
                href={`/api/bexio/connect?workspace=${slug}`}
              >
                Connect Bexio
              </a>
            </div>
            <Grants
              ownerId={workspaceOwner(slug)}
              connectHref={`/api/bexio/connect?workspace=${slug}`}
            />
          </section>
        ))}
      </div>
    </main>
  );
}

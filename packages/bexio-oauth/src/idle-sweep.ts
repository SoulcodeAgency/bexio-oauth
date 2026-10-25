import type { ClientContext } from "./config.js";
import { toMs, type Duration } from "./duration.js";
import { isBexioOAuthError } from "./errors.js";
import { lockWindow, refreshLocked } from "./refresh.js";
import type { RefreshIdleResult } from "./types.js";

export const DEFAULT_IDLE_LIMIT = 100;

/** `BexioOAuth.refreshIdle`: refreshes idle grants one after another. */
export async function refreshIdle(
  ctx: ClientContext,
  options: { idleFor: Duration; limit?: number; timeBudget?: Duration },
): Promise<RefreshIdleResult> {
  const { store, clock } = ctx;
  const idleMs = toMs(options?.idleFor, "idleFor");
  const budgetMs =
    options.timeBudget === undefined
      ? Infinity
      : toMs(options.timeBudget, "timeBudget");
  const startedAt = clock().getTime();
  const result: RefreshIdleResult = {
    refreshed: 0,
    skipped: 0,
    reauthRequired: 0,
    failed: 0,
    remaining: 0,
  };
  const refreshedBefore = new Date(startedAt - idleMs);
  const idle = await store.listIdleGrants({
    refreshedBefore,
    limit: options.limit ?? DEFAULT_IDLE_LIMIT,
  });
  if (idle.length === 0) return result;
  try {
    await ctx.oidc.config();
  } catch {
    // Bexio unreachable: report, don't throw; the next run retries.
    result.failed = idle.length;
    return result;
  }
  for (const [index, grant] of idle.entries()) {
    // Stop before taking the next lock, so a function timeout can't cut a
    // refresh in half. The oldest grants come first, so the next run
    // continues where this one stopped.
    if (clock().getTime() - startedAt >= budgetMs) {
      result.remaining = idle.length - index;
      break;
    }
    const window = lockWindow(ctx, clock());
    const locked = await store.acquireRefreshLock({
      id: grant.id,
      ...window,
      refreshedBefore,
    });
    if (!locked) {
      result.skipped++;
      continue;
    }
    try {
      if (await refreshLocked(ctx, locked, window.lockToken))
        result.refreshed++;
      else result.skipped++;
    } catch (error) {
      if (isBexioOAuthError(error, "reauth_required")) {
        result.reauthRequired++;
      } else {
        result.failed++;
      }
    }
  }
  return result;
}

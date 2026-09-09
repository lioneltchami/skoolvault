import type { Page, Response } from "playwright";
import { log } from "./log.js";
import { sleep } from "./text.js";

export interface RateLimitState {
  backoffUntil: number;
  hits: number;
  lastHitAt: number;
}

export function createRateLimitState(): RateLimitState {
  return { backoffUntil: 0, hits: 0, lastHitAt: 0 };
}

/**
 * Attach a response listener that trips backoff on 429 (and Skool 403 bursts).
 * Returns a disposer.
 */
export function attachRateLimitWatcher(
  page: Page,
  state: RateLimitState,
  opts?: { backoffMs?: number },
): () => void {
  const backoffMs = opts?.backoffMs ?? 30_000;

  const onResponse = (resp: Response) => {
    const status = resp.status();
    // 429 is unambiguous rate limiting. Treat 403 only on API/Mux hosts —
    // page navigations often 403 for unrelated auth/ACL noise.
    if (status !== 429 && status !== 403) return;
    const url = resp.url();
    if (
      status === 403 &&
      !/api2\.skool\.com|mux\.com|stream\.video\.skool/.test(url)
    ) {
      return;
    }
    if (!/skool\.com|mux\.com/.test(url)) return;

    const now = Date.now();
    // Decay hit counter after a quiet window so one bad burst doesn't
    // permanently pin every wait at 120s.
    if (state.lastHitAt && now - state.lastHitAt > 120_000) {
      state.hits = 0;
    }
    state.lastHitAt = now;
    state.hits += 1;
    state.backoffUntil = now + backoffMs * Math.min(state.hits, 4);
    log.warn(`Rate limit ${status} on ${url.slice(0, 80)}… backing off`);
  };

  page.on("response", onResponse);
  return () => page.off("response", onResponse);
}

/** Wait out any active backoff window before the next navigation/action. */
export async function waitIfRateLimited(state: RateLimitState): Promise<void> {
  const remaining = state.backoffUntil - Date.now();
  if (remaining > 0) {
    log.info(
      `Waiting ${(remaining / 1000).toFixed(1)}s for rate-limit backoff`,
    );
    await sleep(remaining);
  }
}

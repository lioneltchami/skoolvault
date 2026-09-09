import type { Page, Response } from "playwright";
import { log } from "./log.js";
import { sleep } from "./text.js";

export interface RateLimitState {
	backoffUntil: number;
	hits: number;
}

export function createRateLimitState(): RateLimitState {
	return { backoffUntil: 0, hits: 0 };
}

/**
 * Attach a response listener that trips backoff on 429/403 from Skool hosts.
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
		if (status !== 429 && status !== 403) return;
		const url = resp.url();
		if (!/skool\.com|mux\.com|api2\.skool/.test(url)) return;
		state.hits += 1;
		state.backoffUntil = Date.now() + backoffMs * Math.min(state.hits, 4);
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

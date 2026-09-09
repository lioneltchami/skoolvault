import type { Page } from "playwright";

export async function readNextData(
	page: Page,
): Promise<Record<string, unknown> | null> {
	return page.evaluate(() => {
		const el = document.querySelector("script#__NEXT_DATA__");
		if (!el?.textContent) return null;
		try {
			return JSON.parse(el.textContent) as Record<string, unknown>;
		} catch {
			return null;
		}
	});
}

export function pageProps(
	data: Record<string, unknown> | null,
): Record<string, unknown> {
	if (!data) return {};
	const props = data.props as Record<string, unknown> | undefined;
	const pageProps = props?.pageProps as Record<string, unknown> | undefined;
	return pageProps ?? {};
}

export function renderData(
	data: Record<string, unknown> | null,
): Record<string, unknown> {
	const pp = pageProps(data);
	return (pp.renderData as Record<string, unknown>) ?? pp;
}

export async function fetchLessonVideoToken(
	page: Page,
	opts: { group: string; courseHash: string; moduleId: string },
): Promise<{ playbackId: string; token: string; duration?: number } | null> {
	return page.evaluate(async ({ group, courseHash, moduleId }) => {
		const el = document.querySelector("script#__NEXT_DATA__");
		if (!el?.textContent) return null;
		try {
			const data = JSON.parse(el.textContent) as { buildId?: string };
			const buildId = data.buildId;
			if (!buildId) return null;
			const url = `/_next/data/${buildId}/${group}/classroom/${courseHash}.json?md=${moduleId}&group=${group}`;
			const resp = await fetch(url, { credentials: "include" });
			if (!resp.ok) return null;
			const j = (await resp.json()) as {
				pageProps?: {
					renderData?: {
						video?: {
							playbackId?: string;
							playbackToken?: string;
							duration?: number;
						};
					};
				};
			};
			const video = j.pageProps?.renderData?.video;
			if (video?.playbackId && video?.playbackToken) {
				return {
					playbackId: video.playbackId,
					token: video.playbackToken,
					duration: video.duration,
				};
			}
		} catch {
			return null;
		}
		return null;
	}, opts);
}

import type { Page } from "playwright";
import { readNextData, renderData } from "../next-data.js";

/**
 * Prefer structured lesson text from __NEXT_DATA__/renderData over noisy DOM chrome.
 * Falls back to a cleaned MainContent innerText when SSR fields are empty.
 */
export async function extractLessonBody(
	page: Page,
	lessonId: string,
): Promise<string> {
	const fromNext = await page.evaluate((id) => {
		const el = document.querySelector("script#__NEXT_DATA__");
		if (!el?.textContent) return "";
		try {
			const data = JSON.parse(el.textContent) as {
				props?: {
					pageProps?: {
						renderData?: {
							video?: { description?: string };
							course?: unknown;
						};
						course?: { metadata?: { desc?: string; content?: string } };
					};
				};
			};
			const pp = data.props?.pageProps;
			const rd = pp?.renderData;
			const parts: string[] = [];

			if (rd?.video?.description) parts.push(String(rd.video.description));

			type Node = {
				course?: {
					id?: string;
					metadata?: { desc?: string; content?: string };
				};
				children?: Node[];
			};

			const walk = (node: Node | undefined) => {
				if (!node) return;
				const info = node.course;
				if (info?.id === id) {
					const meta = info.metadata || {};
					if (meta.desc) parts.push(String(meta.desc));
					if (meta.content) parts.push(String(meta.content));
				}
				for (const child of node.children || []) walk(child);
			};
			walk(rd?.course as Node | undefined);

			const courseMeta = pp?.course?.metadata;
			if (courseMeta?.desc) parts.push(String(courseMeta.desc));
			if (courseMeta?.content) parts.push(String(courseMeta.content));

			return [...new Set(parts.filter(Boolean))].join("\n\n").trim();
		} catch {
			return "";
		}
	}, lessonId);

	if (fromNext && fromNext.length > 20) return fromNext.slice(0, 50_000);

	const fromDom = await page.evaluate(() => {
		const selectors = [
			'[class*="LessonContent"]',
			'[class*="CourseContent"]',
			'[class*="PostContent"]',
			'[class*="MainContent"]',
			"article",
			"main",
		];
		for (const sel of selectors) {
			const el = document.querySelector(sel);
			const text = el?.textContent?.replace(/\n{3,}/g, "\n\n").trim() || "";
			if (text.length > 40) return text.slice(0, 50_000);
		}
		return "";
	});

	return fromDom;
}

export async function extractLessonVideoLink(
	page: Page,
	lessonId: string,
): Promise<string | undefined> {
	const data = await readNextData(page);
	const rd = renderData(data);
	type Node = {
		course?: { id?: string; metadata?: { videoLink?: string } };
		children?: Node[];
	};
	const found: { link?: string } = {};
	const walk = (node: Node | undefined) => {
		if (!node || found.link) return;
		if (node.course?.id === lessonId && node.course.metadata?.videoLink) {
			found.link = node.course.metadata.videoLink;
			return;
		}
		for (const child of node.children || []) walk(child);
	};
	walk(rd.course as Node | undefined);
	return found.link;
}

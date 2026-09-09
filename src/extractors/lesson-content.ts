import type { Page } from "playwright";
import {
	fetchLessonPageProps,
	readNextData,
	renderData,
} from "../next-data.js";
import { tipTapToMarkdown } from "../utils/tiptap.js";

type TreeNode = {
	course?: {
		id?: string;
		metadata?: { desc?: string; content?: string; videoLink?: string };
	};
	children?: TreeNode[];
};

function collectFromTree(root: unknown, lessonId: string): string[] {
	const parts: string[] = [];
	const walk = (node: TreeNode | undefined) => {
		if (!node) return;
		const info = node.course;
		if (info?.id === lessonId) {
			const meta = info.metadata || {};
			if (meta.desc) parts.push(String(meta.desc));
			if (meta.content) parts.push(String(meta.content));
		}
		for (const child of node.children || []) walk(child);
	};
	walk(root as TreeNode | undefined);
	return parts;
}

function partsFromPageProps(
	pp: Record<string, unknown> | null | undefined,
	lessonId: string,
): string[] {
	if (!pp) return [];
	const parts: string[] = [];
	const rd = (pp.renderData as Record<string, unknown>) || pp;
	const video = rd.video as { description?: string } | undefined;
	if (video?.description) parts.push(String(video.description));
	parts.push(...collectFromTree(rd.course, lessonId));
	const courseMeta = (
		pp.course as { metadata?: { desc?: string; content?: string } }
	)?.metadata;
	if (courseMeta?.desc) parts.push(String(courseMeta.desc));
	if (courseMeta?.content) parts.push(String(courseMeta.content));
	return parts;
}

/**
 * Prefer fresh `/_next/data/...json?md=` (current lesson TipTap), then on-page
 * __NEXT_DATA__, then cleaned DOM. Always normalize TipTap → Markdown.
 */
export async function extractLessonBody(
	page: Page,
	lessonId: string,
	opts?: { group?: string; courseHash?: string },
): Promise<string> {
	const parts: string[] = [];

	if (opts?.group && opts?.courseHash) {
		const pp = await fetchLessonPageProps(page, {
			group: opts.group,
			courseHash: opts.courseHash,
			moduleId: lessonId,
		});
		parts.push(...partsFromPageProps(pp, lessonId));
	}

	if (parts.join("").trim().length < 20) {
		const data = await readNextData(page);
		const pp = data
			? ((data.props as { pageProps?: Record<string, unknown> })?.pageProps ??
				null)
			: null;
		parts.push(...partsFromPageProps(pp, lessonId));
	}

	const fromData = [...new Set(parts.filter(Boolean))]
		.map((p) => tipTapToMarkdown(p))
		.filter(Boolean)
		.join("\n\n")
		.trim();

	if (fromData.length > 20) return fromData.slice(0, 50_000);

	const fromDom = await page.evaluate(() => {
		const selectors = [
			'[class*="LessonContent"]',
			'[class*="CourseContent"]',
			'[class*="PostContent"]',
			'[class*="MainContent"]',
			'[class*="RichText"]',
			".ql-editor",
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

	return tipTapToMarkdown(fromDom || fromData).slice(0, 50_000);
}

export async function extractLessonVideoLink(
	page: Page,
	lessonId: string,
): Promise<string | undefined> {
	const data = await readNextData(page);
	const rd = renderData(data);
	const found: { link?: string } = {};
	const walk = (node: TreeNode | undefined) => {
		if (!node || found.link) return;
		if (node.course?.id === lessonId && node.course.metadata?.videoLink) {
			found.link = node.course.metadata.videoLink;
			return;
		}
		for (const child of node.children || []) walk(child);
	};
	walk(rd.course as TreeNode | undefined);
	return found.link;
}

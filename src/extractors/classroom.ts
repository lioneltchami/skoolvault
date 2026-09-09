import type { Page } from "playwright";
import { pageProps, readNextData, renderData } from "../next-data.js";
import type { Course } from "../schema.js";
import { slugify } from "../utils/text.js";

interface RawCourse {
	id?: string;
	name?: string;
	rootId?: string;
	state?: number;
	createdAt?: string;
	updatedAt?: string;
	metadata?: {
		title?: string;
		desc?: string;
		numModules?: number;
		hasAccess?: number;
	};
}

export async function listCourses(
	page: Page,
	skipLocked = true,
): Promise<Course[]> {
	const data = await readNextData(page);
	const rd = renderData(data);
	const pp = pageProps(data);
	const allCourses = (rd.allCourses || pp.allCourses || []) as RawCourse[];

	const domTitles = await page.evaluate(() =>
		Array.from(document.querySelectorAll('[class*="CourseTitle"]')).map(
			(el) => el.textContent?.trim() || "",
		),
	);

	const courses: Course[] = [];
	for (let i = 0; i < allCourses.length; i++) {
		const c = allCourses[i]!;
		const hasAccess =
			c.metadata?.hasAccess === undefined ? true : c.metadata.hasAccess === 1;
		if (skipLocked && !hasAccess) continue;

		const title =
			c.metadata?.title || domTitles[i] || c.name || `Course ${i + 1}`;
		const nameHash = c.name || c.rootId || c.id || `course-${i}`;
		courses.push({
			id: c.id || nameHash,
			nameHash,
			title,
			slug: slugify(title),
			description: c.metadata?.desc || "",
			numModules: c.metadata?.numModules || 0,
			hasAccess,
		});
	}

	// DOM fallback
	if (courses.length === 0) {
		const fromDom = await page.evaluate(() => {
			const out: { title: string; description: string; index: number }[] = [];
			const wrappers = document.querySelectorAll(
				'[class*="CourseLinkWrapper"], [class*="CourseWrapper"]',
			);
			wrappers.forEach((wrapper, i) => {
				const title =
					wrapper
						.querySelector('[class*="CourseTitle"]')
						?.textContent?.trim() || `Course ${i + 1}`;
				const description =
					wrapper
						.querySelector('[class*="CourseDescription"]')
						?.textContent?.trim() || "";
				out.push({ title, description, index: i });
			});
			return out;
		});
		for (const c of fromDom) {
			courses.push({
				id: `dom-${c.index}`,
				nameHash: "",
				title: c.title,
				slug: slugify(c.title),
				description: c.description,
				numModules: 0,
				hasAccess: true,
			});
		}
	}

	return courses;
}

export interface TreeLesson {
	id: string;
	name: string;
	title: string;
	section: string;
	videoId?: string;
	position: number;
	resourcesRaw?: string;
}

interface TreeNode {
	course?: {
		id?: string;
		name?: string;
		unitType?: string;
		metadata?: {
			title?: string;
			videoId?: string;
			resources?: string;
			desc?: string;
		};
	};
	children?: TreeNode[];
}

function walkTree(
	node: TreeNode,
	path: string[],
	out: TreeLesson[],
	counter: { n: number },
): void {
	const info = node.course || {};
	const meta = info.metadata || {};
	const unitType = info.unitType || "";
	const title = meta.title || info.name || "";

	if (unitType === "module") {
		counter.n += 1;
		out.push({
			id: info.id || `lesson-${counter.n}`,
			name: info.name || "",
			title: title || `Lesson ${counter.n}`,
			section: path.length ? path[path.length - 1]! : "",
			videoId: meta.videoId,
			position: counter.n,
			resourcesRaw: meta.resources,
		});
	}

	const children = node.children || [];
	const newPath = unitType === "set" ? [...path, title] : path;
	for (const child of children) walkTree(child, newPath, out, counter);
}

export async function extractCourseLessonTree(
	page: Page,
): Promise<TreeLesson[]> {
	const data = await readNextData(page);
	const rd = renderData(data);
	const pp = pageProps(data);
	const courseTree = (rd.course || pp.course) as TreeNode | undefined;
	if (!courseTree) return [];
	const out: TreeLesson[] = [];
	walkTree(courseTree, [], out, { n: 0 });
	return out;
}

export function parseResources(
	resourcesRaw?: string,
): { fileId?: string; link?: string; label?: string }[] {
	if (!resourcesRaw) return [];
	try {
		const parsed = JSON.parse(resourcesRaw) as unknown;
		if (Array.isArray(parsed)) {
			return parsed.map((r) => {
				const o = r as Record<string, unknown>;
				return {
					fileId:
						typeof o.file_id === "string"
							? o.file_id
							: typeof o.fileId === "string"
								? o.fileId
								: undefined,
					link:
						typeof o.link === "string"
							? o.link
							: typeof o.url === "string"
								? o.url
								: undefined,
					label:
						typeof o.label === "string"
							? o.label
							: typeof o.name === "string"
								? o.name
								: undefined,
				};
			});
		}
	} catch {
		// ignore
	}
	return [];
}

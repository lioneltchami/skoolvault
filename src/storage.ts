import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
	type CommunityMeta,
	CommunityMetaSchema,
	FeedPostSchema,
	LessonSchema,
} from "./schema.js";
import { slugify } from "./utils/text.js";

export interface CommunityPaths {
	root: string;
	meta: string;
	progress: string;
	courses: string;
	feed: string;
	about: string;
	files: string;
	session: string;
}

export function communityPaths(
	outputRoot: string,
	communitySlug: string,
): CommunityPaths {
	const root = path.join(outputRoot, communitySlug);
	return {
		root,
		meta: path.join(root, "meta.json"),
		progress: path.join(root, "progress.json"),
		courses: path.join(root, "courses"),
		feed: path.join(root, "feed"),
		about: path.join(root, "about"),
		files: path.join(root, "files"),
		session: path.join(outputRoot, ".session.json"),
	};
}

export function ensureCommunityLayout(paths: CommunityPaths): void {
	for (const dir of [
		paths.root,
		paths.courses,
		paths.feed,
		paths.about,
		paths.files,
	]) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

export function writeJson(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

/** Validate with Zod then write — throws ZodError on bad shapes. */
export function writeValidatedJson<T>(
	file: string,
	schema: z.ZodType<T>,
	data: unknown,
): T {
	const parsed = schema.parse(data);
	writeJson(file, parsed);
	return parsed;
}

export function writeLessonJson(file: string, data: unknown) {
	return writeValidatedJson(file, LessonSchema, data);
}

export function writeFeedPostsJson(
	file: string,
	data: { posts: unknown[]; scrapedAt: string },
) {
	const posts = data.posts.map((p) => FeedPostSchema.parse(p));
	writeJson(file, { posts, scrapedAt: data.scrapedAt });
	return posts;
}

export function writeCommunityMetaValidated(
	paths: CommunityPaths,
	meta: unknown,
): CommunityMeta {
	const parsed = writeValidatedJson(paths.meta, CommunityMetaSchema, meta);
	return parsed;
}

export function readJson<T>(file: string): T | null {
	if (!fs.existsSync(file)) return null;
	return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function courseDir(paths: CommunityPaths, courseSlug: string): string {
	return path.join(paths.courses, courseSlug);
}

export function ensureCourseLayout(paths: CommunityPaths, courseSlug: string) {
	const root = courseDir(paths, courseSlug);
	const layout = {
		root,
		courseJson: path.join(root, "course.json"),
		lessons: path.join(root, "lessons"),
		media: path.join(root, "media"),
		files: path.join(root, "files"),
	};
	for (const d of [layout.root, layout.lessons, layout.media, layout.files]) {
		fs.mkdirSync(d, { recursive: true });
	}
	return layout;
}

export function writeCommunityMeta(
	paths: CommunityPaths,
	meta: CommunityMeta,
): void {
	writeValidatedJson(paths.meta, CommunityMetaSchema, meta);
}

export function lessonBasename(position: number, title: string): string {
	const num = String(position).padStart(2, "0");
	return `${num}-${slugify(title)}`;
}

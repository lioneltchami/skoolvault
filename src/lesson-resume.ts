import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectExternalVideoUrls } from "./media/mux.js";
import type { FileRef, Lesson, VideoRef } from "./schema.js";
import {
	findLessonArtifactsById,
	lessonBasename,
	readJson,
} from "./storage.js";

export interface LessonNodeHints {
	id: string;
	title: string;
	position: number;
	videoId?: string;
	videoLink?: string;
	resourcesRaw?: string;
	desc?: string;
}

export function urlHash(url: string): string {
	return createHash("sha1").update(url).digest("hex").slice(0, 8);
}

/** Stable on-disk name for an external video — keyed by URL, not list index. */
export function externalVideoPath(
	mediaDir: string,
	base: string,
	source: string,
	url: string,
): string {
	return path.join(mediaDir, `${base}-${source}-${urlHash(url)}.mp4`);
}

/** Pure resume decision — exported for unit tests. */
export function lessonNeedsRework(opts: {
	lessonDone: boolean;
	videos: boolean;
	files: boolean;
	muxVideoId?: string;
	muxMp4Exists: boolean;
	muxPlaybackIdMatches: boolean;
	muxVideoFailed: boolean;
	externalExpected: { path: string }[];
	fileIdsWanted: string[];
	existingFiles?: { fileId?: string; localPath?: string }[];
}): boolean {
	if (!opts.lessonDone) return true;

	if (opts.videos && opts.muxVideoId) {
		if (
			opts.muxVideoFailed ||
			!opts.muxMp4Exists ||
			!opts.muxPlaybackIdMatches
		) {
			return true;
		}
	}
	if (opts.videos) {
		for (const e of opts.externalExpected) {
			if (!e.path || !fs.existsSync(e.path)) return true;
		}
	}
	if (opts.files && opts.fileIdsWanted.length) {
		const missing = opts.fileIdsWanted.some((id) => {
			const f = opts.existingFiles?.find((x) => x.fileId === id);
			return !f?.localPath || !fs.existsSync(f.localPath);
		});
		if (missing) return true;
	}
	return false;
}

/** Detect externals from the SAME corpus the downloader uses (before live body). */
export function externalVideoHints(node: LessonNodeHints): VideoRef[] {
	return detectExternalVideoUrls(
		[node.desc, node.resourcesRaw, node.videoLink].filter(Boolean).join(" "),
	);
}

/**
 * Build expected external downloads from tree hints + prior lesson JSON.
 * Paths are URL-hashed so resume and download always agree.
 */
export function buildExternalExpected(
	mediaDir: string,
	base: string,
	node: LessonNodeHints,
	priorVideos?: VideoRef[],
	extraText = "",
): { path: string; url: string; source: VideoRef["source"] }[] {
	const byUrl = new Map<string, VideoRef>();
	for (const v of externalVideoHints(node)) {
		if (v.url) byUrl.set(v.url, v);
	}
	if (extraText) {
		for (const v of detectExternalVideoUrls(extraText)) {
			if (v.url) byUrl.set(v.url, v);
		}
	}
	for (const v of priorVideos ?? []) {
		if (v.url && v.source !== "mux") {
			byUrl.set(v.url, v);
		}
	}
	const out: { path: string; url: string; source: VideoRef["source"] }[] = [];
	for (const v of byUrl.values()) {
		if (!v.url || !["loom", "vimeo", "youtube", "wistia"].includes(v.source)) {
			continue;
		}
		out.push({
			url: v.url,
			source: v.source,
			path:
				v.localPath && fs.existsSync(v.localPath)
					? v.localPath
					: externalVideoPath(mediaDir, base, v.source, v.url),
		});
	}
	return out;
}

export function resolveLessonBase(
	lessonsDir: string,
	node: LessonNodeHints,
): { base: string; jsonPath: string } {
	const existing = findLessonArtifactsById(lessonsDir, node.id);
	if (existing) return existing;
	const base = lessonBasename(node.position, node.title, node.id);
	return { base, jsonPath: path.join(lessonsDir, `${base}.json`) };
}

/** Carry over on-disk paths + non-empty content when a repair pass is thin. */
export function mergePriorLocalPaths(
	lesson: Lesson,
	priorPath: string,
): Lesson {
	const prior = readJson<Lesson>(priorPath);
	if (!prior) return lesson;

	const videos: VideoRef[] = lesson.videos.map((v) => {
		if (v.localPath && fs.existsSync(v.localPath)) return v;
		const match = prior.videos?.find((p) => {
			if (v.playbackId && p.playbackId === v.playbackId) return true;
			if (v.url && p.url === v.url) return true;
			return false;
		});
		if (match?.localPath && fs.existsSync(match.localPath)) {
			return { ...v, localPath: match.localPath };
		}
		return v;
	});

	const files: FileRef[] = lesson.files.map((f) => {
		if (f.localPath && fs.existsSync(f.localPath)) return f;
		const match = prior.files?.find(
			(p) => p.fileId && f.fileId && p.fileId === f.fileId,
		);
		if (match?.localPath && fs.existsSync(match.localPath)) {
			return { ...f, localPath: match.localPath, name: f.name || match.name };
		}
		return f;
	});

	// Never wipe a good transcript with an empty re-extraction
	const content =
		lesson.content.trim().length >= 20
			? lesson.content
			: prior.content?.trim()
				? prior.content
				: lesson.content;

	return { ...lesson, content, videos, files };
}

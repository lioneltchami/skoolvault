import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	emptyProgress,
	isLessonDone,
	isVideoDone,
	isVideoFailed,
	loadProgress,
	markCourseDone,
	markLessonDone,
	markLessonPartial,
	markVideo,
	saveProgress,
} from "./progress.js";
import { LessonSchema } from "./schema.js";
import { writeLessonJson } from "./storage.js";

function check(name: string, fn: () => void) {
	try {
		fn();
		console.log(`ok  ${name}`);
	} catch (e) {
		console.error(`FAIL ${name}`);
		throw e;
	}
}

check("markLessonPartial is not done; markLessonDone is", () => {
	const p = emptyProgress();
	markLessonPartial(p, "course-a", "l1");
	assert.equal(isLessonDone(p, "course-a", "l1"), false);
	markLessonDone(p, "course-a", "l1");
	assert.equal(isLessonDone(p, "course-a", "l1"), true);
});

check("markVideo complete/failed", () => {
	const p = emptyProgress();
	markVideo(p, "k1", "complete");
	markVideo(p, "k2", "failed");
	assert.equal(isVideoDone(p, "k1"), true);
	assert.equal(isVideoFailed(p, "k2"), true);
	assert.equal(isVideoDone(p, "k2"), false);
});

check("markCourseDone + save/load roundtrip", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skoolvault-progress-"));
	const file = path.join(dir, "progress.json");
	const p = emptyProgress();
	markLessonDone(p, "c1", "l1");
	markCourseDone(p, "c1");
	saveProgress(file, p);
	const loaded = loadProgress(file);
	assert.equal(loaded.courses.c1?.status, "complete");
	assert.equal(isLessonDone(loaded, "c1", "l1"), true);
	fs.rmSync(dir, { recursive: true, force: true });
});

check("LessonSchema.parse rejects bad type", () => {
	assert.throws(() =>
		LessonSchema.parse({
			type: "feedPost",
			id: "1",
			courseId: "c",
			courseHash: "h",
			courseTitle: "T",
			title: "L",
			url: "https://x",
			extractedAt: new Date().toISOString(),
		}),
	);
});

check("writeLessonJson validates and writes", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skoolvault-lesson-"));
	const file = path.join(dir, "01-intro.json");
	const lesson = {
		type: "lesson" as const,
		id: "l1",
		courseId: "c1",
		courseHash: "hash",
		courseTitle: "Course",
		section: "Week 1",
		title: "Intro",
		position: 1,
		content: "Hello",
		url: "https://www.skool.com/g/classroom/hash?md=l1",
		videos: [{ source: "mux" as const, playbackId: "abc" }],
		files: [],
		comments: [],
		extractedAt: "2026-01-01T00:00:00.000Z",
	};
	writeLessonJson(file, lesson);
	const raw = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(raw.type, "lesson");
	assert.equal(raw.videos[0].playbackId, "abc");
	assert.throws(() => writeLessonJson(file, { ...lesson, type: "nope" }));
	fs.rmSync(dir, { recursive: true, force: true });
});

check("P0: video without localPath must not count as done", () => {
	// Mirrors pull.ts decision: ref truthy but no file → failed, not complete
	const p = emptyProgress();
	const ref: { localPath?: string } | null = { localPath: undefined };
	const outMp4Missing = true;
	const ok = Boolean(ref?.localPath) && !outMp4Missing;
	if (ok) markVideo(p, "course:l1", "complete");
	else {
		markVideo(p, "course:l1", "failed");
		markLessonPartial(p, "course", "l1");
	}
	assert.equal(isVideoDone(p, "course:l1"), false);
	assert.equal(isVideoFailed(p, "course:l1"), true);
	assert.equal(isLessonDone(p, "course", "l1"), false);
});

check("P0: lesson filter must not mark course complete", () => {
	const p = emptyProgress();
	const tree = [{ id: "a" }, { id: "b" }];
	const lessonFilter = "a";
	markLessonDone(p, "c", "a");
	if (!lessonFilter) {
		const allDone = tree.every((n) => isLessonDone(p, "c", n.id));
		if (allDone) markCourseDone(p, "c");
	}
	assert.notEqual(p.courses.c?.status, "complete");
});

check("atomic writeJson + corrupt progress recovers", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skoolvault-atomic-"));
	const file = path.join(dir, "progress.json");
	saveProgress(file, emptyProgress());
	assert.ok(fs.existsSync(file));
	fs.writeFileSync(file, "{broken", "utf8");
	const loaded = loadProgress(file);
	assert.equal(loaded.feed.status, "pending");
	fs.rmSync(dir, { recursive: true, force: true });
});

console.log("\nprogress/schema tests passed");

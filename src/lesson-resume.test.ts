import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeSameSite } from "./auth.js";
import { lessonNeedsRework, mergePriorLocalPaths } from "./lesson-resume.js";
import type { Lesson } from "./schema.js";
import { writeJson } from "./storage.js";

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

check("normalizeSameSite maps Cookie-Editor values", () => {
  assert.equal(normalizeSameSite("lax"), "Lax");
  assert.equal(normalizeSameSite("strict"), "Strict");
  assert.equal(normalizeSameSite("no_restriction"), "None");
  assert.equal(normalizeSameSite("None"), "None");
  assert.equal(normalizeSameSite(undefined), "Lax");
});

check("P2: completed Loom-only lesson needs rework when mp4 missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ext-"));
  const missing = path.join(dir, "01-x-loom-1.mp4");
  assert.equal(
    lessonNeedsRework({
      lessonDone: true,
      videos: true,
      files: false,
      muxVideoId: undefined,
      muxMp4Exists: false,
      muxVideoFailed: false,
      externalExpected: [{ path: missing }],
      fileIdsWanted: [],
    }),
    true,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

check("P2: completed lesson with all externals present skips", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ext2-"));
  const present = path.join(dir, "01-x-loom-1.mp4");
  fs.writeFileSync(present, "x".repeat(2000));
  assert.equal(
    lessonNeedsRework({
      lessonDone: true,
      videos: true,
      files: false,
      muxVideoId: undefined,
      muxMp4Exists: false,
      muxVideoFailed: false,
      externalExpected: [{ path: present }],
      fileIdsWanted: [],
    }),
    false,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

check(
  "P2: mergePriorLocalPaths keeps downloaded paths across flag flips",
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-merge-"));
    const mp4 = path.join(dir, "vid.mp4");
    const pdf = path.join(dir, "f.pdf");
    fs.writeFileSync(mp4, "video");
    fs.writeFileSync(pdf, "file");
    const priorPath = path.join(dir, "lesson.json");
    const prior: Lesson = {
      type: "lesson",
      id: "l1",
      courseId: "c",
      courseHash: "h",
      courseTitle: "C",
      section: "",
      title: "T",
      position: 1,
      content: "old",
      url: "https://www.skool.com/g/classroom/h?md=l1",
      videos: [{ source: "mux", playbackId: "abc", localPath: mp4 }],
      files: [{ fileId: "fid1", name: "notes.pdf", localPath: pdf }],
      comments: [],
      extractedAt: "2026-01-01T00:00:00.000Z",
    };
    writeJson(priorPath, prior);

    const next: Lesson = {
      ...prior,
      content: "new",
      videos: [{ source: "mux", playbackId: "abc" }],
      files: [{ fileId: "fid1", name: "notes.pdf" }],
    };
    const merged = mergePriorLocalPaths(next, priorPath);
    assert.equal(merged.videos[0]?.localPath, mp4);
    assert.equal(merged.files[0]?.localPath, pdf);
    fs.rmSync(dir, { recursive: true, force: true });
  },
);

console.log("\nP2 resume/auth tests passed");

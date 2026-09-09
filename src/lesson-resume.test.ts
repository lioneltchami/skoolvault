import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cookieExpiresUnix,
  hasAuthTokenCookie,
  normalizeSameSite,
} from "./auth.js";
import {
  buildExternalExpected,
  externalVideoPath,
  lessonNeedsRework,
  mergePriorLocalPaths,
  urlHash,
} from "./lesson-resume.js";
import type { Lesson } from "./schema.js";
import { writeFeedPostsJson, writeJson } from "./storage.js";

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

check("hasAuthTokenCookie rejects guest WAF-only cookies", () => {
  assert.equal(
    hasAuthTokenCookie([
      { name: "aws-waf-token", domain: ".skool.com" },
      { name: "client_id", domain: ".skool.com" },
    ]),
    false,
  );
  assert.equal(
    hasAuthTokenCookie([{ name: "auth_token", domain: ".skool.com" }]),
    true,
  );
  assert.equal(
    hasAuthTokenCookie([
      { name: "auth_token", domain: ".skool.com", value: "" },
    ]),
    false,
  );
  assert.equal(
    hasAuthTokenCookie([{ name: "auth_token", value: "tok" }]),
    true,
  );
});

check("cookieExpiresUnix normalizes Cookie-Editor ms", () => {
  assert.equal(cookieExpiresUnix(1_700_000_000), 1_700_000_000);
  assert.equal(cookieExpiresUnix(1_700_000_000_000), 1_700_000_000);
  assert.equal(cookieExpiresUnix(-1), -1);
  assert.equal(cookieExpiresUnix(undefined), -1);
});

check("external paths are URL-stable (not index-based)", () => {
  const a = externalVideoPath(
    "/m",
    "01-x",
    "loom",
    "https://loom.com/share/aaa",
  );
  const b = externalVideoPath("/m", "01-x", "youtube", "https://youtu.be/bbb");
  const a2 = externalVideoPath(
    "/m",
    "01-x",
    "loom",
    "https://loom.com/share/aaa",
  );
  assert.equal(a, a2);
  assert.notEqual(a, b);
  assert.ok(a.includes(urlHash("https://loom.com/share/aaa")));
});

check("P2: Loom in prior JSON forces rework when mp4 missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ext-"));
  const expected = buildExternalExpected(
    dir,
    "01-x",
    { id: "l1", title: "T", position: 1 },
    [
      {
        source: "loom",
        url: "https://www.loom.com/share/abc123",
      },
    ],
  );
  assert.equal(expected.length, 1);
  assert.equal(
    lessonNeedsRework({
      lessonDone: true,
      videos: true,
      files: false,
      muxVideoId: undefined,
      muxMp4Exists: false,
      muxPlaybackIdMatches: true,
      muxVideoFailed: false,
      externalExpected: expected,
      fileIdsWanted: [],
    }),
    true,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

check("P2: desc loom + body youtube share URL-hashed paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ext2-"));
  const loom = "https://www.loom.com/share/aaa";
  const yt = "https://youtu.be/bbb";
  const fromHints = buildExternalExpected(dir, "01-x", {
    id: "l1",
    title: "T",
    position: 1,
    desc: `watch ${yt}`,
    videoLink: loom,
  });
  const fromBody = buildExternalExpected(
    dir,
    "01-x",
    { id: "l1", title: "T", position: 1, videoLink: loom },
    undefined,
    `body has ${loom} and ${yt}`,
  );
  const pathsHints = new Set(fromHints.map((e) => e.path));
  const pathsBody = new Set(fromBody.map((e) => e.path));
  assert.ok(pathsHints.has(externalVideoPath(dir, "01-x", "loom", loom)));
  assert.ok(pathsBody.has(externalVideoPath(dir, "01-x", "loom", loom)));
  assert.ok(pathsBody.has(externalVideoPath(dir, "01-x", "youtube", yt)));
  // same URL → same path across corpora (no loom-1 vs loom-2 skew)
  assert.equal(
    externalVideoPath(dir, "01-x", "loom", loom),
    fromBody.find((e) => e.url === loom)!.path,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

check(
  "P2: mergePriorLocalPaths keeps content + paths; no cross-mux match",
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
      content: "FULL LESSON TRANSCRIPT KEEP ME",
      url: "https://www.skool.com/g/classroom/h?md=l1",
      videos: [{ source: "mux", playbackId: "abc", localPath: mp4 }],
      files: [{ fileId: "fid1", name: "notes.pdf", localPath: pdf }],
      comments: [],
      extractedAt: "2026-01-01T00:00:00.000Z",
    };
    writeJson(priorPath, prior);

    const next: Lesson = {
      ...prior,
      content: "",
      videos: [{ source: "mux", playbackId: "abc" }],
      files: [{ fileId: "fid1", name: "notes.pdf" }],
    };
    const merged = mergePriorLocalPaths(next, priorPath);
    assert.equal(merged.content, "FULL LESSON TRANSCRIPT KEEP ME");
    assert.equal(merged.videos[0]?.localPath, mp4);
    assert.equal(merged.files[0]?.localPath, pdf);

    const swapped: Lesson = {
      ...prior,
      content: "x".repeat(30),
      videos: [{ source: "mux", playbackId: "TOTALLY-DIFFERENT" }],
      files: [],
    };
    const noSteal = mergePriorLocalPaths(swapped, priorPath);
    assert.equal(noSteal.videos[0]?.localPath, undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  },
);

check("P2: feed merge keeps comments across --comments flip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-feed-"));
  const file = path.join(dir, "posts.json");
  writeFeedPostsJson(file, {
    posts: [
      {
        type: "feedPost",
        id: "p1",
        title: "A",
        content: "c",
        url: "",
        upvotes: 0,
        commentsCount: 2,
        comments: [
          {
            id: "c1",
            parentId: "",
            rootId: "",
            content: "hi",
            upvotes: 0,
          },
          {
            id: "c2",
            parentId: "",
            rootId: "",
            content: "yo",
            upvotes: 0,
          },
        ],
        extractedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    scrapedAt: "2026-01-01T00:00:00.000Z",
  });
  writeFeedPostsJson(file, {
    posts: [
      {
        type: "feedPost",
        id: "p1",
        title: "A",
        content: "c",
        url: "",
        upvotes: 1,
        commentsCount: 0,
        comments: [],
        extractedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    scrapedAt: "2026-01-02T00:00:00.000Z",
  });
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    posts: { comments: unknown[]; commentsCount: number }[];
  };
  assert.equal(raw.posts[0]!.comments.length, 2);
  assert.equal(raw.posts[0]!.commentsCount, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log("\nP2 resume/auth tests passed");

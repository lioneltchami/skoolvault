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

/** Pure resume decision — exported for unit tests. */
export function lessonNeedsRework(opts: {
  lessonDone: boolean;
  videos: boolean;
  files: boolean;
  muxVideoId?: string;
  muxMp4Exists: boolean;
  muxVideoFailed: boolean;
  externalExpected: { path: string }[];
  fileIdsWanted: string[];
  existingFiles?: { fileId?: string; localPath?: string }[];
}): boolean {
  if (!opts.lessonDone) return true;

  if (opts.videos && opts.muxVideoId) {
    if (opts.muxVideoFailed || !opts.muxMp4Exists) return true;
  }
  if (opts.videos) {
    for (const e of opts.externalExpected) {
      if (!fs.existsSync(e.path)) return true;
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

export function externalVideoHints(node: LessonNodeHints): VideoRef[] {
  return detectExternalVideoUrls(
    [node.desc, node.resourcesRaw, node.videoLink].filter(Boolean).join(" "),
  );
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

/** Carry over on-disk localPaths when a repair pass doesn't re-download that artifact. */
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
      if (v.source === "mux" && p.source === "mux" && p.localPath) return true;
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

  return { ...lesson, videos, files };
}

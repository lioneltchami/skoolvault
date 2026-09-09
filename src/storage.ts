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
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
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
  const incoming = data.posts.map((p) => FeedPostSchema.parse(p));
  const existing = readJson<{ posts?: unknown[] }>(file);
  const byId = new Map<string, (typeof incoming)[number]>();
  for (const p of existing?.posts ?? []) {
    try {
      const parsed = FeedPostSchema.parse(p);
      byId.set(parsed.id, parsed);
    } catch {
      // drop corrupt prior rows
    }
  }
  for (const p of incoming) {
    const prev = byId.get(p.id);
    // Flag flip `--comments` off must not wipe previously archived threads
    if (
      prev &&
      (!p.comments || p.comments.length === 0) &&
      prev.comments &&
      prev.comments.length > 0
    ) {
      byId.set(p.id, {
        ...p,
        comments: prev.comments,
        commentsCount: Math.max(p.commentsCount ?? 0, prev.commentsCount ?? 0),
      });
    } else {
      byId.set(p.id, p);
    }
  }
  const posts = [...byId.values()];
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
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Stable on-disk course folder — avoid title-slug collisions across courses. */
export function courseFolderKey(course: {
  slug: string;
  nameHash: string;
  id: string;
}): string {
  const unique = (course.nameHash || course.id || "").slice(0, 10);
  if (!unique || unique.startsWith("dom-")) return course.slug;
  return `${course.slug}--${unique}`;
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

export function lessonBasename(
  position: number,
  title: string,
  id?: string,
): string {
  const num = String(position).padStart(2, "0");
  const slug = slugify(title);
  const shortId = id ? id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) : "";
  // Include stable id so upstream inserts don't rename every later artifact
  return shortId ? `${num}-${slug}--${shortId}` : `${num}-${slug}`;
}

/** Find an existing lesson JSON by lesson id (survives basename/position changes). */
export function findLessonArtifactsById(
  lessonsDir: string,
  lessonId: string,
): { base: string; jsonPath: string } | null {
  if (!fs.existsSync(lessonsDir)) return null;
  for (const f of fs.readdirSync(lessonsDir)) {
    if (!f.endsWith(".json")) continue;
    const jsonPath = path.join(lessonsDir, f);
    const data = readJson<{ id?: string }>(jsonPath);
    if (data?.id === lessonId) {
      return { base: f.replace(/\.json$/, ""), jsonPath };
    }
  }
  return null;
}

import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { ensureAuth } from "./auth.js";
import {
  extractCourseLessonTree,
  listCourses,
  parseResources,
} from "./extractors/classroom.js";
import { extractFeedPosts, fetchPostComments } from "./extractors/feed.js";
import { downloadSkoolFile } from "./media/files.js";
import {
  assertFfmpegAvailable,
  detectExternalVideoUrls,
  resolveAndDownloadMux,
} from "./media/mux.js";
import {
  isLessonDone,
  isVideoDone,
  isVideoFailed,
  loadProgress,
  markCourseDone,
  markLessonDone,
  markLessonPartial,
  markVideo,
  type ProgressState,
  saveProgress,
} from "./progress.js";
import type { Course, Lesson } from "./schema.js";
import {
  communityPaths,
  ensureCommunityLayout,
  ensureCourseLayout,
  lessonBasename,
  writeCommunityMeta,
  writeJson,
} from "./storage.js";
import type { ParsedSkoolUrl } from "./url.js";
import { log } from "./utils/log.js";
import { jitter, sanitizeFilename, sleep } from "./utils/text.js";

export interface PullOptions {
  parsed: ParsedSkoolUrl;
  outputRoot: string;
  page: Page;
  sessionFile: string;
  videos?: boolean;
  files?: boolean;
  feed?: boolean;
  comments?: boolean;
  courseFilter?: string;
  skipLocked?: boolean;
  maxFeedPosts?: number;
  delayMinMs?: number;
  delayMaxMs?: number;
  dryRun?: boolean;
}

function lessonToMarkdown(lesson: Lesson): string {
  const lines = [
    `# ${lesson.title}`,
    "",
    `- Course: ${lesson.courseTitle}`,
    lesson.section ? `- Section: ${lesson.section}` : "",
    `- URL: ${lesson.url}`,
    `- Extracted: ${lesson.extractedAt}`,
    "",
    "## Content",
    "",
    lesson.content || "_No text content_",
    "",
  ].filter(Boolean);

  if (lesson.videos.length) {
    lines.push("## Videos", "");
    for (const v of lesson.videos) {
      lines.push(
        `- **${v.source}**: ${v.localPath || v.url || v.playbackId || ""}`,
      );
    }
    lines.push("");
  }
  if (lesson.files.length) {
    lines.push("## Files", "");
    for (const f of lesson.files) {
      lines.push(`- ${f.name}${f.localPath ? ` → ${f.localPath}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function courseTreeLoaded(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector("script#__NEXT_DATA__");
    if (!el?.textContent) return false;
    try {
      const data = JSON.parse(el.textContent) as {
        props?: {
          pageProps?: {
            course?: { children?: unknown[] };
            renderData?: { course?: { children?: unknown[] } };
          };
        };
      };
      const course =
        data.props?.pageProps?.renderData?.course ||
        data.props?.pageProps?.course;
      return Boolean(
        course && Array.isArray(course.children) && course.children.length > 0,
      );
    } catch {
      return false;
    }
  });
}

/** True only when __NEXT_DATA__/renderData has a non-empty course tree. */
async function loadCoursePage(
  page: Page,
  communityUrl: string,
  course: Course,
): Promise<boolean> {
  if (!course.nameHash) return false;
  const url = `${communityUrl}/classroom/${course.nameHash}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(3500);

  if (await courseTreeLoaded(page)) return true;

  // Soft reload once to refresh SSR payload after client nav
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(3000);
  return courseTreeLoaded(page);
}

async function scrapeOneCourse(
  opts: PullOptions,
  course: Course,
  progress: ProgressState,
  paths: ReturnType<typeof communityPaths>,
): Promise<void> {
  const layout = ensureCourseLayout(paths, course.slug);
  writeJson(layout.courseJson, {
    ...course,
    scrapedAt: new Date().toISOString(),
  });

  const loaded = await loadCoursePage(
    opts.page,
    opts.parsed.communityUrl,
    course,
  );
  if (!loaded) {
    log.error(
      `Course tree empty after load/reload: ${course.title} (${course.nameHash}). Skipping — not marked complete.`,
    );
    return;
  }
  await ensureAuth(opts.page, opts.parsed.communityUrl, opts.sessionFile);

  const tree = await extractCourseLessonTree(opts.page);
  if (!tree.length) {
    log.error(
      `extractCourseLessonTree returned 0 lessons for ${course.title} (${course.nameHash}). Skipping — not marked complete.`,
    );
    return;
  }
  log.info(`${course.title}: ${tree.length} lesson(s)`);

  if (opts.dryRun) {
    for (const t of tree) {
      console.log(
        `    [${t.position}] ${t.section ? t.section + " / " : ""}${t.title}${t.videoId ? " 🎥" : ""}`,
      );
    }
    return;
  }

  const lessonFilter =
    opts.parsed.kind === "lesson" ? opts.parsed.lessonId : undefined;

  for (const node of tree) {
    if (lessonFilter && node.id !== lessonFilter) continue;

    const base = lessonBasename(node.position, node.title);
    const outMp4 = path.join(layout.media, `${base}.mp4`);
    const videoKey = `${course.slug}:${node.id}`;

    // Resume: skip only when lesson complete AND requested video ok on disk.
    // Repair falsely-complete lessons missing MP4 or marked video-failed.
    if (isLessonDone(progress, course.slug, node.id)) {
      const needsVideoRepair =
        Boolean(opts.videos) &&
        Boolean(node.videoId) &&
        (isVideoFailed(progress, videoKey) || !fs.existsSync(outMp4));
      if (!needsVideoRepair) {
        log.skip(`${node.title}`);
        continue;
      }
      log.info(`Retry media for ${node.title}`);
    }

    const lessonUrl = `${opts.parsed.communityUrl}/classroom/${course.nameHash}?md=${node.id}`;
    await opts.page.goto(lessonUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await sleep(2500);
    await ensureAuth(opts.page, opts.parsed.communityUrl, opts.sessionFile);

    // Prefer content from current page body
    const content = await opts.page.evaluate(() => {
      const main =
        document.querySelector('[class*="MainContent"]') ||
        document.querySelector('[class*="LessonContent"]') ||
        document.querySelector("main");
      return main?.textContent?.trim().slice(0, 50_000) || "";
    });

    const videos = detectExternalVideoUrls(
      content + " " + (node.resourcesRaw || ""),
    );
    const resources = parseResources(node.resourcesRaw);
    const files = [];
    let artifactsOk = true;

    if (opts.videos && node.videoId) {
      if (
        !isVideoDone(progress, videoKey) ||
        isVideoFailed(progress, videoKey) ||
        !fs.existsSync(outMp4)
      ) {
        try {
          const ref = await resolveAndDownloadMux({
            page: opts.page,
            group: opts.parsed.communitySlug,
            courseHash: course.nameHash,
            moduleId: node.id,
            outputPath: outMp4,
            knownPlaybackId: node.videoId,
          });
          if (ref) {
            videos.unshift(ref);
            markVideo(progress, videoKey, "complete");
          } else {
            log.warn(`Video missing for ${node.title} (no Mux result)`);
            markVideo(progress, videoKey, "failed");
            artifactsOk = false;
          }
        } catch (e) {
          log.warn(
            `Video failed for ${node.title}: ${e instanceof Error ? e.message : e}`,
          );
          markVideo(progress, videoKey, "failed");
          artifactsOk = false;
        }
      } else {
        videos.unshift({
          source: "mux",
          playbackId: node.videoId,
          localPath: outMp4,
        });
        log.skip(`Video ${base}.mp4`);
      }
    } else if (node.videoId) {
      videos.unshift({ source: "mux", playbackId: node.videoId });
    }

    if (opts.files) {
      for (const r of resources) {
        if (r.fileId) {
          const f = await downloadSkoolFile({
            page: opts.page,
            context: opts.page.context(),
            fileId: r.fileId,
            destDir: layout.files,
            preferredName: r.label,
          });
          if (f) files.push(f);
          // Skool fileId should yield a local file when --files is on
          if (!f?.localPath) {
            log.warn(`File failed for ${node.title}: ${r.fileId}`);
            artifactsOk = false;
          }
        } else if (r.link) {
          files.push({ name: r.label || r.link, url: r.link });
        }
      }
    } else {
      for (const r of resources) {
        files.push({
          fileId: r.fileId,
          name: r.label || r.fileId || r.link || "",
          url: r.link,
        });
      }
    }

    const lesson: Lesson = {
      type: "lesson",
      id: node.id,
      courseId: course.id,
      courseHash: course.nameHash,
      courseTitle: course.title,
      section: node.section,
      title: node.title,
      position: node.position,
      content,
      url: lessonUrl,
      videos,
      files,
      comments: [],
      extractedAt: new Date().toISOString(),
    };

    writeJson(path.join(layout.lessons, `${base}.json`), lesson);
    fs.writeFileSync(
      path.join(layout.lessons, `${base}.md`),
      lessonToMarkdown(lesson),
      "utf8",
    );
    if (artifactsOk) {
      markLessonDone(progress, course.slug, node.id);
      log.ok(`Lesson ${node.position}: ${node.title}`);
    } else {
      markLessonPartial(progress, course.slug, node.id);
      log.warn(`Lesson partial ${node.position}: ${node.title}`);
    }
    saveProgress(paths.progress, progress);

    await jitter(opts.delayMinMs ?? 1200, opts.delayMaxMs ?? 2800);
  }

  // Single-lesson URL: never mark whole course complete.
  // Otherwise only when every lesson in the full tree succeeded.
  if (!lessonFilter) {
    const allDone = tree.every((node) =>
      isLessonDone(progress, course.slug, node.id),
    );
    if (allDone) {
      markCourseDone(progress, course.slug);
      saveProgress(paths.progress, progress);
    }
  }
}

export async function pullCommunity(opts: PullOptions): Promise<void> {
  // Fail fast before browser work when --videos needs ffmpeg
  if (opts.videos && !opts.dryRun) {
    assertFfmpegAvailable();
  }

  const paths = communityPaths(opts.outputRoot, opts.parsed.communitySlug);
  ensureCommunityLayout(paths);
  // Keep session next to output root for reuse across communities
  paths.session = opts.sessionFile;

  writeCommunityMeta(paths, {
    slug: opts.parsed.communitySlug,
    url: opts.parsed.communityUrl,
    scrapedAt: new Date().toISOString(),
    skoolvaultVersion: "0.1.0",
  });

  const progress = loadProgress(paths.progress);
  const doClassroom =
    opts.parsed.kind === "classroom" ||
    opts.parsed.kind === "community" ||
    opts.parsed.kind === "course" ||
    opts.parsed.kind === "lesson";
  const doFeed = opts.feed || opts.parsed.kind === "feed";

  if (doClassroom) {
    log.step(`Classroom → ${opts.parsed.classroomUrl}`);
    await opts.page.goto(opts.parsed.classroomUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await sleep(4000);
    await ensureAuth(opts.page, opts.parsed.communityUrl, opts.sessionFile);

    let courses = await listCourses(opts.page, opts.skipLocked !== false);
    writeJson(path.join(paths.courses, "index.json"), {
      courses,
      scrapedAt: new Date().toISOString(),
    });
    log.info(`Found ${courses.length} course(s)`);

    if (opts.parsed.courseHash) {
      courses = courses.filter((c) => c.nameHash === opts.parsed.courseHash);
      if (courses.length === 0) {
        courses = [
          {
            id: opts.parsed.courseHash,
            nameHash: opts.parsed.courseHash,
            title: opts.parsed.courseHash,
            slug: sanitizeFilename(opts.parsed.courseHash).toLowerCase(),
            description: "",
            numModules: 0,
            hasAccess: true,
          },
        ];
      }
    }

    if (opts.courseFilter) {
      const q = opts.courseFilter.toLowerCase();
      courses = courses.filter(
        (c) => c.title.toLowerCase().includes(q) || c.slug.includes(q),
      );
    }

    for (const course of courses) {
      log.step(`Course: ${course.title}`);
      await scrapeOneCourse(opts, course, progress, paths);
    }
  }

  if (doFeed) {
    log.step("Community feed");
    const feedUrl = opts.parsed.feedQuery
      ? `${opts.parsed.communityUrl}${opts.parsed.feedQuery}`
      : opts.parsed.communityUrl;
    await opts.page.goto(feedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await sleep(4000);
    await ensureAuth(opts.page, opts.parsed.communityUrl, opts.sessionFile);

    const posts = await extractFeedPosts(opts.page, opts.maxFeedPosts ?? 50);
    if (opts.comments) {
      for (const post of posts) {
        if (!post.id.startsWith("dom-")) {
          try {
            post.comments = await fetchPostComments(opts.page, post.id);
            await jitter(800, 1600);
          } catch (e) {
            log.warn(
              `Comments failed for ${post.id}: ${e instanceof Error ? e.message : e}`,
            );
          }
        }
      }
    }

    if (!opts.dryRun) {
      writeJson(path.join(paths.feed, "posts.json"), {
        posts,
        scrapedAt: new Date().toISOString(),
      });
      progress.feed.status = "complete";
      saveProgress(paths.progress, progress);
    }
    log.ok(`Feed posts: ${posts.length}`);
  }

  log.step(`Done → ${paths.root}`);
}

export async function listOnly(opts: {
  parsed: ParsedSkoolUrl;
  page: Page;
  sessionFile: string;
  skipLocked?: boolean;
}): Promise<Course[]> {
  await opts.page.goto(opts.parsed.classroomUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await sleep(4000);
  await ensureAuth(opts.page, opts.parsed.communityUrl, opts.sessionFile);
  return listCourses(opts.page, opts.skipLocked !== false);
}

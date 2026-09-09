import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { ensureAuth } from "./auth.js";
import {
  clickCourseFromIndex,
  extractCourseLessonTree,
  listCourses,
  parseResources,
} from "./extractors/classroom.js";
import { extractFeedPosts, fetchPostComments } from "./extractors/feed.js";
import { extractLessonBody } from "./extractors/lesson-content.js";
import {
  buildExternalExpected,
  externalVideoPath,
  lessonNeedsRework,
  mergePriorLocalPaths,
  resolveLessonBase,
  urlHash,
} from "./lesson-resume.js";
import { downloadSkoolFile } from "./media/files.js";
import {
  assertFfmpegAvailable,
  detectExternalVideoUrls,
  resolveAndDownloadMux,
} from "./media/mux.js";
import { downloadExternalVideo, hasYtDlp } from "./media/ytdlp.js";
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
  courseFolderKey,
  ensureCommunityLayout,
  ensureCourseLayout,
  readJson,
  writeCommunityMeta,
  writeFeedPostsJson,
  writeJson,
  writeLessonJson,
} from "./storage.js";
import type { ParsedSkoolUrl } from "./url.js";
import { log } from "./utils/log.js";
import {
  attachRateLimitWatcher,
  createRateLimitState,
  type RateLimitState,
  waitIfRateLimited,
} from "./utils/rate-limit.js";
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
  rateLimit?: RateLimitState;
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
  if (!course.nameHash) {
    // DOM-only courses: try click-from-index by title
    log.warn(
      `No nameHash for "${course.title}" — trying classroom click fallback`,
    );
    const clicked = await clickCourseFromIndex(
      page,
      communityUrl,
      course.title,
    );
    if (!clicked) return false;
    return courseTreeLoaded(page);
  }

  const url = `${communityUrl}/classroom/${course.nameHash}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(3500);

  if (await courseTreeLoaded(page)) return true;

  // Soft reload once to refresh SSR payload after client nav
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(3000);
  if (await courseTreeLoaded(page)) return true;

  // Click-from-index fallback (paginated classroom)
  log.warn(`Direct URL failed for "${course.title}" — trying click-from-index`);
  const clicked = await clickCourseFromIndex(page, communityUrl, course.title);
  if (!clicked) return false;
  return courseTreeLoaded(page);
}

async function scrapeOneCourse(
  opts: PullOptions,
  course: Course,
  progress: ProgressState,
  paths: ReturnType<typeof communityPaths>,
): Promise<void> {
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
  const hashFromUrl = opts.page.url().match(/\/classroom\/([^/?#]+)/)?.[1];
  if (hashFromUrl) course.nameHash = hashFromUrl;

  // folderKey AFTER hash recovery so DOM-only courses don't orphan on next run
  const folderKey = courseFolderKey(course);
  const layout = ensureCourseLayout(paths, folderKey);

  writeJson(layout.courseJson, {
    ...course,
    scrapedAt: new Date().toISOString(),
  });

  const courseUrl = `${opts.parsed.communityUrl}/classroom/${course.nameHash}`;
  await ensureAuth(
    opts.page,
    opts.parsed.communityUrl,
    opts.sessionFile,
    courseUrl,
  );

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

    const { base, jsonPath: lessonJsonPath } = resolveLessonBase(
      layout.lessons,
      node,
    );
    const outMp4 = path.join(layout.media, `${base}.mp4`);
    const videoKey = `${folderKey}:${node.id}`;
    const existingLesson = readJson<{
      files?: { fileId?: string; localPath?: string }[];
      videos?: {
        source: string;
        url?: string;
        playbackId?: string;
        localPath?: string;
      }[];
      content?: string;
    }>(lessonJsonPath);

    const externalExpected = buildExternalExpected(
      layout.media,
      base,
      node,
      existingLesson?.videos as import("./schema.js").VideoRef[] | undefined,
    );
    const wantedFileIds = parseResources(node.resourcesRaw)
      .map((r) => r.fileId)
      .filter((id): id is string => Boolean(id));

    const priorMuxId = existingLesson?.videos?.find(
      (v) => v.source === "mux" && v.localPath,
    )?.playbackId;
    const muxPlaybackIdMatches =
      !node.videoId || !priorMuxId || priorMuxId === node.videoId;

    const rework = lessonNeedsRework({
      lessonDone: isLessonDone(progress, folderKey, node.id),
      videos: Boolean(opts.videos),
      files: Boolean(opts.files),
      muxVideoId: node.videoId,
      muxMp4Exists: fs.existsSync(outMp4),
      muxPlaybackIdMatches,
      muxVideoFailed: isVideoFailed(progress, videoKey),
      externalExpected,
      fileIdsWanted: wantedFileIds,
      existingFiles: existingLesson?.files,
    });

    if (isLessonDone(progress, folderKey, node.id) && !rework) {
      log.skip(`${node.title}`);
      continue;
    }
    if (isLessonDone(progress, folderKey, node.id) && rework) {
      log.info(`Retry media/files for ${node.title}`);
    }

    const lessonUrl = `${opts.parsed.communityUrl}/classroom/${course.nameHash}?md=${node.id}`;
    if (opts.rateLimit) await waitIfRateLimited(opts.rateLimit);
    await opts.page.goto(lessonUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await sleep(2500);
    await ensureAuth(
      opts.page,
      opts.parsed.communityUrl,
      opts.sessionFile,
      lessonUrl,
    );

    if (!opts.page.url().includes(`md=${node.id}`)) {
      log.warn(
        `Left lesson page after auth (${opts.page.url()}) — marking partial: ${node.title}`,
      );
      markLessonPartial(progress, folderKey, node.id);
      saveProgress(paths.progress, progress);
      continue;
    }

    const content =
      (await extractLessonBody(opts.page, node.id)) || node.desc || "";

    // Same corpus for detect + download (desc + live body + resources + videoLink)
    const videoCorpus = [content, node.desc, node.resourcesRaw, node.videoLink]
      .filter(Boolean)
      .join(" ");
    const videos = detectExternalVideoUrls(videoCorpus);
    const resources = parseResources(node.resourcesRaw);
    const files = [];
    let artifactsOk = true;

    if (
      content.trim().length < 20 &&
      (existingLesson?.content?.trim().length ?? 0) >= 20
    ) {
      // mergePrior will restore text; still flag partial so we retry extraction
      log.warn(`Thin lesson body for ${node.title} — keeping prior content`);
      artifactsOk = false;
    }

    if (opts.videos && node.videoId) {
      if (
        !isVideoDone(progress, videoKey) ||
        isVideoFailed(progress, videoKey) ||
        !fs.existsSync(outMp4) ||
        !muxPlaybackIdMatches
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
          if (ref?.localPath && fs.existsSync(outMp4)) {
            videos.unshift(ref);
            markVideo(progress, videoKey, "complete");
          } else {
            if (ref) videos.unshift(ref);
            else if (node.videoId) {
              videos.unshift({ source: "mux", playbackId: node.videoId });
            }
            log.warn(`Video missing for ${node.title} (no Mux download)`);
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

    if (opts.videos) {
      const externals = videos.filter(
        (v) =>
          v.url &&
          v.source !== "mux" &&
          ["loom", "vimeo", "youtube", "wistia"].includes(v.source),
      );
      for (let i = 0; i < externals.length; i++) {
        const v = externals[i]!;
        const extPath = externalVideoPath(layout.media, base, v.source, v.url!);
        const extKey = `${folderKey}:${node.id}:ext:${v.source}:${urlHash(v.url!)}`;
        if (isVideoDone(progress, extKey) && fs.existsSync(extPath)) {
          v.localPath = extPath;
          continue;
        }
        if (!hasYtDlp()) {
          log.warn(`Skipping ${v.source} download (yt-dlp missing): ${v.url}`);
          artifactsOk = false;
          continue;
        }
        try {
          if (opts.rateLimit) await waitIfRateLimited(opts.rateLimit);
          const ref = await downloadExternalVideo({
            url: v.url!,
            outputPath: extPath,
            source: v.source,
          });
          Object.assign(v, ref);
          markVideo(progress, extKey, "complete");
        } catch (e) {
          log.warn(
            `External ${v.source} failed: ${e instanceof Error ? e.message : e}`,
          );
          markVideo(progress, extKey, "failed");
          artifactsOk = false;
        }
      }
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

    let lesson: Lesson = {
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
    lesson = mergePriorLocalPaths(lesson, lessonJsonPath);

    writeLessonJson(lessonJsonPath, lesson);
    fs.writeFileSync(
      path.join(layout.lessons, `${base}.md`),
      lessonToMarkdown(lesson),
      "utf8",
    );
    if (artifactsOk) {
      markLessonDone(progress, folderKey, node.id);
      log.ok(`Lesson ${node.position}: ${node.title}`);
    } else {
      markLessonPartial(progress, folderKey, node.id);
      log.warn(`Lesson partial ${node.position}: ${node.title}`);
    }
    saveProgress(paths.progress, progress);

    await jitter(opts.delayMinMs ?? 1200, opts.delayMaxMs ?? 2800);
  }

  if (!lessonFilter) {
    const allDone = tree.every((node) =>
      isLessonDone(progress, folderKey, node.id),
    );
    if (allDone) {
      markCourseDone(progress, folderKey);
      saveProgress(paths.progress, progress);
    }
  }
}

export async function pullCommunity(opts: PullOptions): Promise<void> {
  // Fail fast before browser work when --videos needs ffmpeg
  if (opts.videos && !opts.dryRun) {
    assertFfmpegAvailable();
    // yt-dlp optional but recommended; warn once if missing (Mux still works)
    if (!hasYtDlp()) {
      log.warn(
        "yt-dlp not found — Loom/Vimeo/YouTube/Wistia downloads will be skipped (Mux still works). Install: brew install yt-dlp",
      );
    }
  }

  const rateLimit = opts.rateLimit ?? createRateLimitState();
  const detachRateLimit = attachRateLimitWatcher(opts.page, rateLimit);
  opts.rateLimit = rateLimit;

  try {
    await pullCommunityInner(opts);
  } finally {
    detachRateLimit();
  }
}

async function pullCommunityInner(opts: PullOptions): Promise<void> {
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
    if (opts.rateLimit) await waitIfRateLimited(opts.rateLimit);
    await opts.page.goto(opts.parsed.classroomUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await sleep(4000);
    await ensureAuth(
      opts.page,
      opts.parsed.communityUrl,
      opts.sessionFile,
      opts.parsed.classroomUrl,
    );

    let courses = await listCourses(opts.page, opts.skipLocked !== false);

    if (courses.length === 0 && !opts.parsed.courseHash && !opts.courseFilter) {
      throw new Error(
        `No courses found in classroom for ${opts.parsed.communitySlug}. ` +
          `Refusing to overwrite courses/index.json (auth wall, rate limit, or empty community).`,
      );
    }

    // Never clobber a good index with [] when courseFilter/courseHash bypassed the throw
    if (courses.length > 0) {
      writeJson(path.join(paths.courses, "index.json"), {
        courses,
        scrapedAt: new Date().toISOString(),
      });
    }
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
      if (opts.rateLimit) await waitIfRateLimited(opts.rateLimit);
      await scrapeOneCourse(opts, course, progress, paths);
    }
  }

  if (doFeed) {
    log.step("Community feed");
    const feedUrl = opts.parsed.feedQuery
      ? `${opts.parsed.communityUrl}${opts.parsed.feedQuery}`
      : opts.parsed.communityUrl;
    if (opts.rateLimit) await waitIfRateLimited(opts.rateLimit);
    await opts.page.goto(feedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await sleep(4000);
    await ensureAuth(
      opts.page,
      opts.parsed.communityUrl,
      opts.sessionFile,
      feedUrl,
    );

    const maxFeed = opts.maxFeedPosts ?? 50;
    const posts = await extractFeedPosts(opts.page, maxFeed);
    if (opts.comments) {
      for (const post of posts) {
        if (!post.id.startsWith("dom-")) {
          try {
            if (opts.rateLimit) await waitIfRateLimited(opts.rateLimit);
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
      const merged = writeFeedPostsJson(path.join(paths.feed, "posts.json"), {
        posts,
        scrapedAt: new Date().toISOString(),
      });
      const onlyDom =
        posts.length > 0 && posts.every((p) => p.id.startsWith("dom-"));
      const hitCap = posts.length >= maxFeed;
      // SSR is one page — never mark feed complete without real pagination
      progress.feed.status = "pending";
      log.warn(
        `Feed archived ${merged.length} post(s) (run=${posts.length}` +
          `${hitCap ? `, hit --max-feed ${maxFeed}` : ""}` +
          `${onlyDom ? ", DOM fallback" : ""}` +
          `${posts.length === 0 ? ", empty" : ""}) — status left pending (SSR snapshot only)`,
      );
      saveProgress(paths.progress, progress);
    }
    log.ok(`Feed posts this run: ${posts.length}`);
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
  await ensureAuth(
    opts.page,
    opts.parsed.communityUrl,
    opts.sessionFile,
    opts.parsed.classroomUrl,
  );
  return listCourses(opts.page, opts.skipLocked !== false);
}

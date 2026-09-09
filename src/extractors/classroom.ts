import type { Page } from "playwright";
import { pageProps, readNextData, renderData } from "../next-data.js";
import type { Course } from "../schema.js";
import { sleep, slugify } from "../utils/text.js";

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

function mapRawCourse(c: RawCourse, i: number, domTitle?: string): Course {
  const hasAccess =
    c.metadata?.hasAccess === undefined ? true : c.metadata.hasAccess === 1;
  const title = c.metadata?.title || domTitle || c.name || `Course ${i + 1}`;
  const nameHash = c.name || c.rootId || c.id || `course-${i}`;
  return {
    id: c.id || nameHash,
    nameHash,
    title,
    slug: slugify(title),
    description: c.metadata?.desc || "",
    numModules: c.metadata?.numModules || 0,
    hasAccess,
  };
}

async function readDomTitles(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[class*="CourseTitle"]')).map(
      (el) => el.textContent?.trim() || "",
    ),
  );
}

async function clickClassroomNext(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll(
        'button[aria-label*="Next" i], a[aria-label*="Next" i], [class*="Pagination"] button, [class*="pagination"] button',
      ),
    ) as HTMLButtonElement[];
    const nextBtn = candidates.find((btn) => {
      const label = (
        btn.getAttribute("aria-label") ||
        btn.textContent ||
        ""
      ).toLowerCase();
      const looksNext =
        label.includes("next") || btn.textContent?.trim() === ">";
      return (
        looksNext &&
        !btn.disabled &&
        btn.getAttribute("aria-disabled") !== "true"
      );
    });
    if (nextBtn) {
      nextBtn.click();
      return true;
    }
    return false;
  });
}

/**
 * List courses from classroom page. Paginates up to 5 pages (DOM + merging
 * __NEXT_DATA__ allCourses) so large classrooms are not truncated.
 */
export async function listCourses(
  page: Page,
  skipLocked = true,
): Promise<Course[]> {
  const byId = new Map<string, Course>();

  const ingest = async () => {
    const data = await readNextData(page);
    const rd = renderData(data);
    const pp = pageProps(data);
    const allCourses = (rd.allCourses || pp.allCourses || []) as RawCourse[];
    const domTitles = await readDomTitles(page);

    for (let i = 0; i < allCourses.length; i++) {
      const c = allCourses[i]!;
      const mapped = mapRawCourse(c, i, domTitles[i]);
      if (skipLocked && !mapped.hasAccess) continue;
      byId.set(mapped.id, mapped);
    }

    // Always merge visible DOM cards — client pagination updates DOM, not
    // the initial SSR __NEXT_DATA__ blob.
    const fromDom = await page.evaluate(() => {
      const out: { title: string; description: string; href: string }[] = [];
      const wrappers = document.querySelectorAll(
        '[class*="CourseLinkWrapper"], [class*="CourseWrapper"], a[href*="/classroom/"]',
      );
      wrappers.forEach((wrapper) => {
        const title =
          wrapper
            .querySelector('[class*="CourseTitle"]')
            ?.textContent?.trim() ||
          wrapper.textContent?.trim().slice(0, 120) ||
          "";
        if (!title) return;
        const description =
          wrapper
            .querySelector('[class*="CourseDescription"]')
            ?.textContent?.trim() || "";
        const href =
          (wrapper as HTMLAnchorElement).href ||
          wrapper.querySelector("a")?.getAttribute("href") ||
          "";
        out.push({ title, description, href });
      });
      return out;
    });

    for (const c of fromDom) {
      const hashMatch = c.href.match(/\/classroom\/([^/?#]+)/);
      const nameHash = hashMatch?.[1] || "";
      const id = nameHash || `dom-${c.title}`;
      if (byId.has(id)) continue;
      const dup = [...byId.values()].find((x) => x.title === c.title);
      if (dup) {
        if (!dup.nameHash && nameHash) dup.nameHash = nameHash;
        continue;
      }
      byId.set(id, {
        id,
        nameHash,
        title: c.title,
        slug: slugify(c.title),
        description: c.description,
        numModules: 0,
        hasAccess: true,
      });
    }
  };

  await ingest();

  // Paginate classroom index (Skool may split courses across pages)
  for (let pageNum = 0; pageNum < 5; pageNum++) {
    const moved = await clickClassroomNext(page);
    if (!moved) break;
    await sleep(2500);
    await ingest();
  }

  return [...byId.values()];
}

export interface TreeLesson {
  id: string;
  name: string;
  title: string;
  section: string;
  videoId?: string;
  videoLink?: string;
  position: number;
  resourcesRaw?: string;
  desc?: string;
}

interface TreeNode {
  course?: {
    id?: string;
    name?: string;
    unitType?: string;
    metadata?: {
      title?: string;
      videoId?: string;
      videoLink?: string;
      resources?: string;
      desc?: string;
      content?: string;
    };
  };
  children?: TreeNode[];
}

/** Exported for unit tests — walk Skool course.children tree into flat lessons. */
export function walkTree(
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
      videoLink: meta.videoLink,
      position: counter.n,
      resourcesRaw: meta.resources,
      desc: meta.desc || meta.content,
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

/** Click a course card from the classroom index across up to 5 pages. */
export async function clickCourseFromIndex(
  page: Page,
  communityUrl: string,
  courseTitle: string,
): Promise<boolean> {
  await page.goto(`${communityUrl}/classroom`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await sleep(3000);

  for (let pageNum = 0; pageNum < 5; pageNum++) {
    const clicked = await page.evaluate((title) => {
      const wrappers = document.querySelectorAll(
        '[class*="CourseLinkWrapper"], [class*="CourseWrapper"]',
      );
      for (const w of wrappers) {
        const titleEl = w.querySelector('[class*="CourseTitle"]');
        if (titleEl && titleEl.textContent?.trim() === title) {
          (w as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, courseTitle);

    if (clicked) {
      try {
        await page.waitForURL(/\/classroom\//, { timeout: 10_000 });
      } catch {
        // may already be on course URL
      }
      await sleep(2500);
      const url = page.url();
      if (url.includes("/classroom/") && !url.endsWith("/classroom")) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await sleep(3000);
      }
      return true;
    }

    const hasNext = await clickClassroomNext(page);
    if (!hasNext) break;
    await sleep(2500);
  }

  return false;
}

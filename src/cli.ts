#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { openAuthenticatedSession } from "./auth.js";
import { assertFfmpegAvailable } from "./media/mux.js";
import { listOnly, pullCommunity } from "./pull.js";
import { communityPaths } from "./storage.js";
import { parseSkoolUrl } from "./url.js";
import { log } from "./utils/log.js";

const program = new Command();

program
  .name("skoolvault")
  .description(
    "Personal Skool archive — courses, videos, files, and feed, stored per community",
  )
  .version("0.1.0");

program
  .command("list")
  .description("List courses in a community classroom")
  .argument("<url>", "Skool community or classroom URL")
  .option("-o, --out <dir>", "Output root directory", "output")
  .option("--cookies <file>", "Cookie-Editor / Playwright cookies JSON")
  .option(
    "--headless",
    "Run browser headless (requires valid session/cookies)",
    false,
  )
  .option("--include-locked", "Include courses without access", false)
  .action(async (url: string, opts) => {
    const parsed = parseSkoolUrl(url);
    const outputRoot = path.resolve(opts.out);
    const paths = communityPaths(outputRoot, parsed.communitySlug);
    const session = await openAuthenticatedSession({
      sessionFile: paths.session,
      cookiesFile: opts.cookies,
      headed: !opts.headless,
      communityUrl: parsed.communityUrl,
    });
    try {
      const courses = await listOnly({
        parsed,
        page: session.page,
        sessionFile: paths.session,
        skipLocked: !opts.includeLocked,
      });
      console.log(`\n${parsed.communitySlug} — ${courses.length} course(s)\n`);
      for (const c of courses) {
        console.log(
          `  • ${c.title}  [${c.nameHash}]  modules≈${c.numModules}${c.hasAccess ? "" : "  (locked)"}`,
        );
      }
    } finally {
      await session.browser.close();
    }
  });

program
  .command("pull")
  .description(
    "Archive a Skool community (classroom and/or feed) into output/<community>/",
  )
  .argument("<url>", "Skool URL (community, classroom, course, or lesson)")
  .option(
    "-o, --out <dir>",
    "Output root (each community gets its own folder)",
    "output",
  )
  .option("--cookies <file>", "Cookie-Editor / Playwright cookies JSON")
  .option(
    "--headless",
    "Run browser headless (requires valid session/cookies)",
    false,
  )
  .option(
    "--videos",
    "Download Mux (ffmpeg) + Loom/Vimeo/YouTube/Wistia (yt-dlp) as MP4",
    false,
  )
  .option("--files", "Download Skool file attachments", false)
  .option("--feed", "Also scrape the community feed (or use a feed URL)", false)
  .option("--comments", "Fetch comment threads for feed posts", false)
  .option("--course <text>", "Only courses whose title matches this text")
  .option("--include-locked", "Include locked/VIP courses", false)
  .option("--max-feed <n>", "Max feed posts", "50")
  .option(
    "--dry-run",
    "Show what would be scraped without writing media",
    false,
  )
  .action(async (url: string, opts) => {
    // Do NOT pass preferFeed here: `--feed` means "also scrape feed", not
    // "skip classroom". Feed-only URLs still use ?s|fl|c|p (see url.ts).
    const parsed = parseSkoolUrl(url);

    const outputRoot = path.resolve(opts.out);
    const paths = communityPaths(outputRoot, parsed.communitySlug);

    log.step(
      `SkoolVault → community "${parsed.communitySlug}" (${parsed.kind})`,
    );
    log.info(`Output: ${path.join(outputRoot, parsed.communitySlug)}`);

    if (opts.videos && !opts.dryRun) {
      assertFfmpegAvailable();
    }

    const session = await openAuthenticatedSession({
      sessionFile: paths.session,
      cookiesFile: opts.cookies,
      headed: !opts.headless,
      communityUrl: parsed.communityUrl,
    });

    try {
      await pullCommunity({
        parsed,
        outputRoot,
        page: session.page,
        sessionFile: paths.session,
        videos: Boolean(opts.videos),
        files: Boolean(opts.files),
        feed: Boolean(opts.feed) || parsed.kind === "feed",
        comments: Boolean(opts.comments),
        courseFilter: opts.course,
        skipLocked: !opts.includeLocked,
        maxFeedPosts: Number(opts.maxFeed) || 50,
        dryRun: Boolean(opts.dryRun),
      });
    } finally {
      await session.browser.close();
    }
  });

program.parseAsync(process.argv).catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

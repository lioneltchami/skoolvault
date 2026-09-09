import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { VideoRef } from "../schema.js";
import { log } from "../utils/log.js";

const YTDLP_TIMEOUT_MS = 1800_000;

export function hasYtDlp(): boolean {
  const r = spawnSync("yt-dlp", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

export function assertYtDlpAvailable(): void {
  if (hasYtDlp()) return;
  throw new Error(
    "yt-dlp not found on PATH (needed for Loom/Vimeo/YouTube/Wistia downloads).\n" +
      "  macOS:  brew install yt-dlp\n" +
      "  Linux:  pipx install yt-dlp   # or: sudo apt install yt-dlp\n" +
      "  Windows: winget install yt-dlp",
  );
}

function runYtDlp(url: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const outTemplate = outputPath.replace(/\.mp4$/i, "") + ".%(ext)s";
    const args = [
      "--no-playlist",
      "--no-warnings",
      "-f",
      "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
      "--merge-output-format",
      "mp4",
      "-o",
      outTemplate,
      url,
    ];
    const child = spawn("yt-dlp", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`yt-dlp timed out after ${YTDLP_TIMEOUT_MS / 1000}s`));
    }, YTDLP_TIMEOUT_MS);

    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        e.message.includes("ENOENT")
          ? new Error("yt-dlp not found on PATH")
          : e,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(err.slice(-500) || `yt-dlp exited ${code}`));
    });
  });
}

function findDownloadedFile(basePathWithoutExt: string): string | null {
  const dir = path.dirname(basePathWithoutExt);
  const base = path.basename(basePathWithoutExt);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  const exact = files.find((f) => f === `${base}.mp4`);
  if (exact) return path.join(dir, exact);
  // Prefer real containers over yt-dlp fragments (.f137.mp4, .part, …)
  const container = files.find(
    (f) =>
      f.startsWith(`${base}.`) &&
      /\.(mp4|mkv|webm|mov|m4v)$/i.test(f) &&
      !/\.f\d+\./i.test(f) &&
      !f.endsWith(".part"),
  );
  return container ? path.join(dir, container) : null;
}

/** Download Loom/Vimeo/YouTube/Wistia via yt-dlp → MP4. */
export async function downloadExternalVideo(opts: {
  url: string;
  outputPath: string;
  source: VideoRef["source"];
}): Promise<VideoRef> {
  if (
    fs.existsSync(opts.outputPath) &&
    fs.statSync(opts.outputPath).size > 10_240
  ) {
    return { source: opts.source, url: opts.url, localPath: opts.outputPath };
  }

  const base = opts.outputPath.replace(/\.mp4$/i, "");
  await runYtDlp(opts.url, opts.outputPath);
  const found = findDownloadedFile(base);
  if (!found) {
    throw new Error(`yt-dlp produced no file for ${opts.url}`);
  }
  if (found !== opts.outputPath) {
    fs.renameSync(found, opts.outputPath);
  }
  if (
    !fs.existsSync(opts.outputPath) ||
    fs.statSync(opts.outputPath).size < 1024
  ) {
    throw new Error("yt-dlp download empty");
  }
  log.ok(`Downloaded ${path.basename(opts.outputPath)} (${opts.source})`);
  return { source: opts.source, url: opts.url, localPath: opts.outputPath };
}

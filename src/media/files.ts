import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BrowserContext, Page } from "playwright";
import type { FileRef } from "../schema.js";
import { log } from "../utils/log.js";
import { sanitizeFilename } from "../utils/text.js";

async function cookieHeaderForUrl(
  context: BrowserContext,
  url: string,
): Promise<string | undefined> {
  const cookies = await context.cookies(url);
  if (!cookies.length) return undefined;
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function streamDownload(
  url: string,
  dest: string,
  cookieHeader?: string,
): Promise<void> {
  const headers: Record<string, string> = {
    Referer: "https://www.skool.com/",
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  const resp = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(600_000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} downloading file`);
  }
  if (!resp.body) {
    throw new Error("Empty response body");
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  try {
    // Node 18+: Web ReadableStream → Node stream → disk (no full-buffer OOM)
    await pipeline(
      Readable.fromWeb(resp.body as import("node:stream/web").ReadableStream),
      fs.createWriteStream(tmp),
    );
    fs.renameSync(tmp, dest);
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw e;
  }
}

export async function downloadSkoolFile(opts: {
  page: Page;
  context: BrowserContext;
  fileId: string;
  destDir: string;
  preferredName?: string;
}): Promise<FileRef | null> {
  // Authenticated page fetch returns only URL metadata (small JSON).
  const result = await opts.page.evaluate(async (fileId) => {
    try {
      const resp = await fetch(
        `https://api2.skool.com/files/${fileId}/download-url?expire=28800`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        },
      );
      if (!resp.ok) return { error: `HTTP ${resp.status}` };
      const data = (await resp.json()) as {
        url?: string;
        downloadUrl?: string;
        name?: string;
      };
      return { url: data.url || data.downloadUrl, name: data.name };
    } catch (e) {
      return { error: String(e) };
    }
  }, opts.fileId);

  if (!result || "error" in result || !result.url) {
    log.warn(
      `File ${opts.fileId} download-url failed: ${(result as { error?: string })?.error || "no url"}`,
    );
    return { fileId: opts.fileId, name: opts.preferredName || opts.fileId };
  }

  // Namespace by fileId so labels collide safely; keep server extension.
  const serverName = result.name ? sanitizeFilename(result.name) : "";
  const ext = path.extname(serverName);
  const label = sanitizeFilename(
    opts.preferredName || serverName || opts.fileId,
  );
  const baseName = path.extname(label) ? label : `${label}${ext}`;
  const name = `${opts.fileId.slice(0, 12)}-${baseName}`;
  const dest = path.join(opts.destDir, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return { fileId: opts.fileId, name, url: result.url, localPath: dest };
  }

  try {
    const cookieHeader = await cookieHeaderForUrl(opts.context, result.url);
    await streamDownload(result.url, dest, cookieHeader);
    log.ok(`File ${name}`);
    return { fileId: opts.fileId, name, url: result.url, localPath: dest };
  } catch (e) {
    log.warn(
      `File ${opts.fileId} download failed: ${e instanceof Error ? e.message : e}`,
    );
    return { fileId: opts.fileId, name, url: result.url };
  }
}

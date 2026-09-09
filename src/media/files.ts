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

/**
 * Skool sometimes returns JSON `{url}` / `{downloadUrl}`, sometimes a raw
 * `https://…` body (text/plain). Never assume JSON.
 */
export function parseDownloadUrlBody(body: string): {
  url?: string;
  name?: string;
  error?: string;
} {
  const trimmed = body.trim();
  if (!trimmed) return { error: "empty body" };
  if (/^https?:\/\//i.test(trimmed)) {
    // Bare URL, or quoted `"https://…"` from a weird proxy
    const unquoted = trimmed.replace(/^"(.*)"$/, "$1");
    if (/^https?:\/\//i.test(unquoted) && !unquoted.includes("\n")) {
      return { url: unquoted };
    }
  }
  try {
    const data = JSON.parse(trimmed) as unknown;
    if (typeof data === "string" && /^https?:\/\//i.test(data)) {
      return { url: data };
    }
    if (data && typeof data === "object") {
      const o = data as { url?: string; downloadUrl?: string; name?: string };
      const url = o.url || o.downloadUrl;
      if (url) return { url, name: o.name };
    }
    return { error: `no url in JSON: ${trimmed.slice(0, 80)}` };
  } catch {
    return { error: `unparseable body: ${trimmed.slice(0, 80)}` };
  }
}

export async function downloadSkoolFile(opts: {
  page: Page;
  context: BrowserContext;
  fileId: string;
  destDir: string;
  preferredName?: string;
}): Promise<FileRef | null> {
  // Authenticated page fetch returns signed URL (JSON or plain text).
  const safeFileId = opts.fileId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeFileId || safeFileId !== opts.fileId) {
    log.warn(`Rejecting unsafe fileId: ${opts.fileId.slice(0, 40)}`);
    return { fileId: opts.fileId, name: opts.preferredName || opts.fileId };
  }

  const raw = await opts.page.evaluate(async (fileId) => {
    try {
      const resp = await fetch(
        `https://api2.skool.com/files/${fileId}/download-url?expire=28800`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        },
      );
      const text = await resp.text();
      return { ok: resp.ok, status: resp.status, text };
    } catch (e) {
      return { ok: false, status: 0, text: "", error: String(e) };
    }
  }, safeFileId);

  if (raw.error && !raw.text) {
    log.warn(`File ${opts.fileId} download-url failed: ${raw.error}`);
    return { fileId: opts.fileId, name: opts.preferredName || opts.fileId };
  }
  if (!raw.ok) {
    log.warn(
      `File ${opts.fileId} download-url failed: HTTP ${raw.status}: ${raw.text.slice(0, 120)}`,
    );
    return { fileId: opts.fileId, name: opts.preferredName || opts.fileId };
  }

  const parsed = parseDownloadUrlBody(raw.text);
  if (parsed.error || !parsed.url) {
    log.warn(
      `File ${opts.fileId} download-url failed: ${parsed.error || "no url"}`,
    );
    return { fileId: opts.fileId, name: opts.preferredName || opts.fileId };
  }

  const result = { url: parsed.url, name: parsed.name };

  // Namespace by fileId so labels collide safely; keep server extension.
  const serverName = result.name ? sanitizeFilename(result.name) : "";
  const ext = path.extname(serverName);
  const label = sanitizeFilename(
    opts.preferredName || serverName || safeFileId,
  );
  const baseName = path.extname(label) ? label : `${label}${ext}`;
  const name = `${safeFileId.slice(0, 12)}-${baseName}`;
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

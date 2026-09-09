import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { fetchLessonVideoToken } from "../next-data.js";
import type { VideoRef } from "../schema.js";
import { log } from "../utils/log.js";

/** OpenCnid-style ceiling for one HLS remux. */
const FFMPEG_TIMEOUT_MS = 1800_000;

const FFMPEG_INSTALL_HINT =
	"ffmpeg not found on PATH. Install it, then retry:\n" +
	"  macOS:  brew install ffmpeg\n" +
	"  Debian/Ubuntu:  sudo apt install ffmpeg\n" +
	"  Windows:  winget install ffmpeg";

export function assertFfmpegAvailable(): void {
	const check = spawnSync("ffmpeg", ["-version"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (check.error || check.status !== 0) {
		throw new Error(FFMPEG_INSTALL_HINT);
	}
}

function runFfmpeg(hlsUrl: string, outputPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		const partPath = `${outputPath}.part`;
		try {
			if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
		} catch {
			// ignore
		}
		const args = [
			"-y",
			"-loglevel",
			"error",
			"-headers",
			"Referer: https://www.skool.com/\r\n",
			"-i",
			hlsUrl,
			"-c",
			"copy",
			"-bsf:a",
			"aac_adtstoasc",
			"-movflags",
			"+faststart",
			partPath,
		];
		const child = spawn("ffmpeg", args, {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let err = "";
		let settled = false;

		const cleanupPartial = () => {
			try {
				if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
			} catch {
				// ignore
			}
		};

		const fail = (e: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			cleanupPartial();
			reject(e);
		};

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			fail(
				new Error(
					`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000}s writing ${path.basename(outputPath)}`,
				),
			);
		}, FFMPEG_TIMEOUT_MS);

		child.stderr.on("data", (d) => {
			err += d.toString();
		});
		child.on("error", (e: NodeJS.ErrnoException) => {
			if (e.code === "ENOENT") {
				fail(new Error(FFMPEG_INSTALL_HINT));
			} else {
				fail(e);
			}
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) {
				try {
					// -loglevel error: any stderr is a real problem (expired token mid-stream, etc.)
					if (err.trim()) {
						cleanupPartial();
						reject(new Error(err.slice(-400)));
						return;
					}
					if (!fs.existsSync(partPath) || fs.statSync(partPath).size < 10_240) {
						cleanupPartial();
						reject(new Error("Download produced empty/truncated file"));
						return;
					}
					fs.renameSync(partPath, outputPath);
					resolve();
				} catch (e) {
					cleanupPartial();
					reject(e instanceof Error ? e : new Error(String(e)));
				}
			} else {
				cleanupPartial();
				reject(new Error(err.slice(-400) || `ffmpeg exited ${code}`));
			}
		});
	});
}

export async function downloadMuxVideo(opts: {
	playbackId: string;
	token: string;
	outputPath: string;
}): Promise<"ok" | "skip"> {
	if (
		fs.existsSync(opts.outputPath) &&
		fs.statSync(opts.outputPath).size > 10_240
	) {
		return "skip";
	}
	fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
	const hls = `https://stream.mux.com/${opts.playbackId}.m3u8?token=${opts.token}`;
	try {
		await runFfmpeg(hls, opts.outputPath);
	} catch (e) {
		// Fallback Skool CDN host
		const alt = `https://stream.video.skool.com/${opts.playbackId}.m3u8?token=${opts.token}`;
		try {
			await runFfmpeg(alt, opts.outputPath);
		} catch {
			if (fs.existsSync(opts.outputPath)) fs.unlinkSync(opts.outputPath);
			throw e;
		}
	}
	if (
		!fs.existsSync(opts.outputPath) ||
		fs.statSync(opts.outputPath).size < 10_240
	) {
		if (fs.existsSync(opts.outputPath)) fs.unlinkSync(opts.outputPath);
		throw new Error("Download produced empty/truncated file");
	}
	return "ok";
}

export async function resolveAndDownloadMux(opts: {
	page: Page;
	group: string;
	courseHash: string;
	moduleId: string;
	outputPath: string;
	/** Kept for call-site clarity; download still requires a live token. */
	knownPlaybackId?: string;
}): Promise<VideoRef | null> {
	void opts.knownPlaybackId;
	const tokenInfo = await fetchLessonVideoToken(opts.page, {
		group: opts.group,
		courseHash: opts.courseHash,
		moduleId: opts.moduleId,
	});

	if (!tokenInfo) {
		// No token → cannot download. Never return a metadata-only ref —
		// callers would mark the video "complete" with nothing on disk.
		log.debug(`No Mux token for module ${opts.moduleId}`);
		return null;
	}

	const result = await downloadMuxVideo({
		playbackId: tokenInfo.playbackId,
		token: tokenInfo.token,
		outputPath: opts.outputPath,
	});

	if (result === "skip")
		log.skip(`Video exists: ${path.basename(opts.outputPath)}`);
	else log.ok(`Downloaded ${path.basename(opts.outputPath)}`);

	return {
		source: "mux",
		playbackId: tokenInfo.playbackId,
		// Skool/Mux duration is seconds; schema field is milliseconds
		durationMs:
			tokenInfo.duration != null
				? Math.round(tokenInfo.duration * 1000)
				: undefined,
		localPath: opts.outputPath,
	};
}

export function detectExternalVideoUrls(text: string): VideoRef[] {
	const refs: VideoRef[] = [];
	const patterns: { source: VideoRef["source"]; re: RegExp }[] = [
		{
			source: "loom",
			re: /https?:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/[a-zA-Z0-9]+/g,
		},
		{ source: "vimeo", re: /https?:\/\/(?:www\.)?vimeo\.com\/\d+/g },
		{
			source: "youtube",
			re: /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/g,
		},
		{
			source: "wistia",
			re: /https?:\/\/(?:[\w-]+\.)?wistia\.com\/(?:medias|embed)\/[\w-]+/g,
		},
	];
	for (const { source, re } of patterns) {
		const matches = text.match(re) || [];
		for (const url of matches) {
			if (refs.some((r) => r.url === url)) continue;
			refs.push({ source, url });
		}
	}
	return refs;
}

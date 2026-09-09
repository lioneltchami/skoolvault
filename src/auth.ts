import fs from "node:fs";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright";
import { log } from "./utils/log.js";
import { sleep } from "./utils/text.js";

export interface AuthResult {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export interface AuthOptions {
  sessionFile: string;
  cookiesFile?: string;
  headed?: boolean;
  communityUrl: string;
}

/** Cookie-Editor / Chrome → Playwright sameSite enum. */
export function normalizeSameSite(raw: unknown): "Strict" | "Lax" | "None" {
  const key = String(raw ?? "")
    .toLowerCase()
    .replace(/_/g, "");
  if (key === "strict") return "Strict";
  if (key === "none" || key === "norestriction") return "None";
  return "Lax";
}

function cookieFileToStorageState(cookiesFile: string): {
  cookies: unknown[];
  origins: [];
} {
  const raw = JSON.parse(fs.readFileSync(cookiesFile, "utf8")) as unknown;
  // Cookie-Editor export is usually an array; Playwright storageState wants {cookies, origins}
  if (Array.isArray(raw)) {
    const cookies = raw.map((c: Record<string, unknown>) => ({
      name: String(c.name),
      value: String(c.value),
      domain: String(c.domain ?? ".skool.com"),
      path: String(c.path ?? "/"),
      expires: typeof c.expirationDate === "number" ? c.expirationDate : -1,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure ?? true),
      sameSite: normalizeSameSite(c.sameSite),
    }));
    return { cookies, origins: [] };
  }
  if (raw && typeof raw === "object" && "cookies" in (raw as object)) {
    const state = raw as { cookies: Record<string, unknown>[]; origins: [] };
    return {
      cookies: state.cookies.map((c) => ({
        ...c,
        sameSite: normalizeSameSite(c.sameSite),
      })),
      origins: state.origins ?? [],
    };
  }
  throw new Error(
    "Cookie file must be Cookie-Editor JSON array or Playwright storageState",
  );
}

async function waitForLogin(page: Page, timeoutMs = 300_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(2000);
    try {
      const url = page.url();
      if (
        url.includes("skool.com") &&
        !url.includes("/login") &&
        !url.includes("/signup")
      ) {
        return;
      }
    } catch {
      // navigating
    }
  }
  throw new Error("Login timed out after 5 minutes");
}

export async function openAuthenticatedSession(
  opts: AuthOptions,
): Promise<AuthResult> {
  const headed = opts.headed !== false;
  const browser = await chromium.launch({
    headless: !headed,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  let context: BrowserContext;

  if (opts.cookiesFile) {
    if (!fs.existsSync(opts.cookiesFile)) {
      await browser.close();
      throw new Error(`Cookies file not found: ${opts.cookiesFile}`);
    }
    log.info(`Loading cookies from ${opts.cookiesFile}`);
    const state = cookieFileToStorageState(opts.cookiesFile);
    context = await browser.newContext({
      storageState: state as never,
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
  } else if (fs.existsSync(opts.sessionFile)) {
    log.info("Restoring saved session…");
    context = await browser.newContext({
      storageState: opts.sessionFile,
      viewport: { width: 1440, height: 900 },
    });
  } else {
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
  }

  const page = await context.newPage();
  await page.goto(opts.communityUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await sleep(2000);

  if (page.url().includes("/login") || page.url().includes("/signup")) {
    if (!headed) {
      await browser.close();
      throw new Error(
        "Login required. Re-run without --headless, or pass --cookies <file>",
      );
    }
    log.step("Log in to Skool in the browser window (detected automatically)");
    await page.goto("https://www.skool.com/login", {
      waitUntil: "domcontentloaded",
    });
    await waitForLogin(page);
    log.ok("Login detected");
    await context.storageState({ path: opts.sessionFile });
    log.ok(`Session saved → ${opts.sessionFile}`);
    await page.goto(opts.communityUrl, { waitUntil: "domcontentloaded" });
    await sleep(2000);
  } else {
    await context.storageState({ path: opts.sessionFile });
    log.ok("Authenticated session ready");
  }

  return { browser, context, page };
}

export async function ensureAuth(
  page: Page,
  communityUrl: string,
  sessionFile: string,
  /** Page to reopen after re-login (lesson/course URL). Defaults to community. */
  returnUrl?: string,
): Promise<void> {
  if (page.url().includes("/login") || page.url().includes("/signup")) {
    log.warn("Session expired — log in again in the browser");
    await waitForLogin(page);
    await page.context().storageState({ path: sessionFile });
    const target = returnUrl || communityUrl;
    await page.goto(target, { waitUntil: "domcontentloaded" });
    await sleep(2000);
    if (page.url().includes("/login") || page.url().includes("/signup")) {
      await page.goto(communityUrl, { waitUntil: "domcontentloaded" });
      await sleep(2000);
    }
  }
}

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

/** True if storage has Skool's session cookie (guest WAF cookies alone don't count). */
export function hasAuthTokenCookie(
  cookies: { name: string; domain?: string; value?: string }[],
): boolean {
  return cookies.some(
    (c) =>
      c.name === "auth_token" &&
      (c.value === undefined || c.value.length > 0) &&
      (!c.domain || c.domain.includes("skool.com")),
  );
}

/** Cookie-Editor may use ms; Playwright storageState uses Unix seconds. */
export function cookieExpiresUnix(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return -1;
  return raw > 1e12 ? Math.floor(raw / 1000) : raw;
}

function cookieFileToStorageState(cookiesFile: string): {
  cookies: unknown[];
  origins: [];
} {
  const raw = JSON.parse(fs.readFileSync(cookiesFile, "utf8")) as unknown;
  if (Array.isArray(raw)) {
    const cookies = raw.map((c: Record<string, unknown>) => ({
      name: String(c.name),
      value: String(c.value ?? ""),
      domain: String(c.domain ?? ".skool.com"),
      path: String(c.path ?? "/"),
      expires: cookieExpiresUnix(c.expirationDate ?? c.expires),
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
        expires: cookieExpiresUnix(c.expires ?? c.expirationDate),
        sameSite: normalizeSameSite(c.sameSite),
      })),
      origins: state.origins ?? [],
    };
  }
  throw new Error(
    "Cookie file must be Cookie-Editor JSON array or Playwright storageState",
  );
}

/**
 * Real login check — public Skool pages do NOT redirect guests to /login,
 * so URL alone is not enough. Require auth_token + a self user in page data.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes("/login") || url.includes("/signup")) return false;

  const cookies = await page.context().cookies("https://www.skool.com/");
  if (!hasAuthTokenCookie(cookies)) return false;

  return page.evaluate(() => {
    const el = document.querySelector("script#__NEXT_DATA__");
    if (!el?.textContent) return false;
    try {
      const data = JSON.parse(el.textContent) as {
        props?: {
          pageProps?: {
            self?: { id?: string };
            renderData?: { self?: { id?: string } };
          };
        };
      };
      const pp = data.props?.pageProps;
      const self = pp?.self || pp?.renderData?.self;
      return Boolean(self?.id);
    } catch {
      return false;
    }
  });
}

async function waitForLogin(page: Page, timeoutMs = 300_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(2000);
    try {
      if (await isLoggedIn(page)) return;
    } catch {
      // navigating
    }
  }
  throw new Error(
    "Login timed out after 5 minutes (need auth_token cookie + logged-in user)",
  );
}

async function forceLogin(
  page: Page,
  context: BrowserContext,
  sessionFile: string,
  communityUrl: string,
): Promise<void> {
  log.step("Log in to Skool in the browser window (detected automatically)");
  await page.goto("https://www.skool.com/login", {
    waitUntil: "domcontentloaded",
  });
  await waitForLogin(page);
  log.ok("Login detected (auth_token + user)");
  await context.storageState({ path: sessionFile });
  log.ok(`Session saved → ${sessionFile}`);
  await page.goto(communityUrl, { waitUntil: "domcontentloaded" });
  await sleep(2000);
  if (!(await isLoggedIn(page))) {
    throw new Error(
      "Login cookie saved but community page still looks logged out",
    );
  }
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

  if (!(await isLoggedIn(page))) {
    if (!headed) {
      await browser.close();
      throw new Error(
        "Not logged in (missing auth_token / user). Re-run without --headless, or pass --cookies <file> with auth_token.",
      );
    }
    // Drop stale guest session so we don't keep reusing it
    try {
      if (fs.existsSync(opts.sessionFile)) fs.unlinkSync(opts.sessionFile);
    } catch {
      // ignore
    }
    await forceLogin(page, context, opts.sessionFile, opts.communityUrl);
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
  opts?: {
    /** Page to reopen after re-login (lesson/course URL). Defaults to community. */
    returnUrl?: string;
    /** When false (headless/CI), fail immediately — no 5min login wait. Default true. */
    interactive?: boolean;
  },
): Promise<void> {
  const interactive = opts?.interactive !== false;
  const returnUrl = opts?.returnUrl;
  const onAuthWall =
    page.url().includes("/login") || page.url().includes("/signup");
  if (!onAuthWall && (await isLoggedIn(page))) return;

  if (!interactive) {
    throw new Error(
      "Session expired (missing auth_token / user). Refresh SKOOL_COOKIES / --cookies, or re-run without --headless.",
    );
  }

  log.warn("Session missing/expired — log in again in the browser");
  await page.goto("https://www.skool.com/login", {
    waitUntil: "domcontentloaded",
  });
  await waitForLogin(page);
  await page.context().storageState({ path: sessionFile });
  const target = returnUrl || communityUrl;
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await sleep(2000);
  if (!(await isLoggedIn(page))) {
    await page.goto(communityUrl, { waitUntil: "domcontentloaded" });
    await sleep(2000);
  }
  if (!(await isLoggedIn(page))) {
    throw new Error(
      "Re-login failed — still missing auth_token / logged-in user",
    );
  }
}

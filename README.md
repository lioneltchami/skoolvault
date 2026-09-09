# SkoolVault

Personal, local-first archive for Skool communities you already have access to.

Stores **one folder per community** under `output/<community-slug>/` — courses, lesson text, Mux videos (MP4), attachments, and the community feed — with resume support.

Lean build inspired by open scrapers (rcspence1, OpenCnid) plus product lessons from FlowExtract / SERP — without their closed code.

## Requirements

- Node.js 18+
- [ffmpeg](https://ffmpeg.org/) (for Mux/`--videos`)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (optional; Loom/Vimeo/YouTube/Wistia when `--videos`)
- Chromium via Playwright (`npx playwright install chromium`)

## Quick start

```bash
cd ~/builders/skool-scraper-lab
npm install
npx playwright install chromium

# List courses (opens browser once for login; session is reused)
# Slug or full URL both work:
npm run skoolvault -- list ai-first-client-formula-8589
npm run skoolvault -- list https://www.skool.com/YOUR-GROUP/classroom

# Archive classroom metadata + Markdown/JSON (no media yet)
npm run skoolvault -- pull YOUR-GROUP

# Classroom + community wall + MP4s + files (local; same shape as GH Action)
npm run skoolvault -- pull YOUR-GROUP --feed --videos --files --comments

# One course by title filter
npm run skoolvault -- pull YOUR-GROUP --course "Week 1" --videos

# Feed + comments only extras on a classroom pull (or bare community URL)
npm run skoolvault -- pull YOUR-GROUP --feed --comments

# Cookie auth (Cookie-Editor export) + headless — local or CI
npm run skoolvault -- pull YOUR-GROUP --cookies ./cookies.json --headless --feed --videos --files
```

## Output layout (community-first)

Everything lands under `output/<community-slug>/` (change root with `--out`).

| What                                      | Where                                              |
| ----------------------------------------- | -------------------------------------------------- |
| Lesson docs                               | `courses/<course>/lessons/*.md` + `*.json`         |
| Mux / Loom / YouTube / etc. video         | `courses/<course>/media/*.mp4`                     |
| Attachments (PDF, n8n JSON, images, zip…) | `courses/<course>/files/`                          |
| Feed                                      | `feed/posts.json`                                  |
| Resume + meta                             | `progress.json`, `meta.json`, `courses/index.json` |
| Session (local reuse)                     | `output/.session.json`                             |

Inline CDN images in lesson HTML usually stay as remote URLs in the Markdown — only **Skool file attachments** are downloaded into `files/`. No separate MP3 pipeline; audio only appears if an attachment is audio, or yt-dlp happens to emit audio as part of a video merge (final target is still `.mp4`).

```
output/
└── your-group/
    ├── meta.json
    ├── progress.json          # resume state for THIS community
    ├── courses/
    │   ├── index.json
    │   └── course-slug--hash/
    │       ├── course.json
    │       ├── lessons/       # *.json + *.md
    │       ├── media/         # *.mp4
    │       └── files/         # PDFs / JSON / images / zips
    ├── feed/
    │   └── posts.json
    ├── about/
    └── files/
```

A second community → a new sibling folder. Re-runs update the same community folder and skip completed lessons/videos.

## GitHub Actions (cookie secret, not password)

Password login is fragile (WAF / OAuth / 2FA). CI uses **cookies**. Same CLI works locally.

1. Log in locally once → export Cookie-Editor JSON (must include `auth_token` for `skool.com`).
2. Repo → Settings → Secrets → `SKOOL_COOKIES` = that JSON blob.
3. Actions → **SkoolVault archive** → Run workflow — fill in:
   - **community** — slug only, e.g. `ai-first-client-formula-8589`
   - **videos / files / comments** — toggles (classroom + community feed always run)
   - optional **course** title filter / **max_feed**
4. Download artifact **`skoolvault-<slug>`** — same tree as local `output/<slug>/`.

Local twin of a full Action run:

```bash
npm run skoolvault -- pull ai-first-client-formula-8589 \
  --cookies ./cookies.json --headless --feed --videos --files --comments
```

Workflow: [`.github/workflows/skoolvault.yml`](./.github/workflows/skoolvault.yml). Refresh the secret when the session expires — headless runs **fail fast** (no 5‑minute login wait).

## Commands

| Command         | Purpose                       |
| --------------- | ----------------------------- |
| `list <target>` | Print courses (id/hash/title) |
| `pull <target>` | Archive based on slug or URL  |

`target` = community slug (`my-group`) or full Skool URL.

### URL routing

| Target                                | Behavior                                              |
| ------------------------------------- | ----------------------------------------------------- |
| `my-group` (slug)                     | Classroom (add `--feed` for community wall too)       |
| `/group/classroom`                    | All accessible courses                                |
| `/group/classroom/{hash}`             | One course                                            |
| `/group/classroom/{hash}?md={lesson}` | Still scrapes that course (lesson-focused navigation) |
| `/group` + `--feed`                   | Classroom + community wall                            |
| `/group?s=newest&p=1`                 | Feed with Skool query preserved                       |

### Useful flags

- `--videos` — Mux HLS → MP4 (ffmpeg); Loom/Vimeo/YouTube/Wistia via yt-dlp when installed
- `--files` — Skool `api2` signed downloads (re-run after a metadata-only pull will fetch missing attachments)
- `--feed` / `--comments` — **also** scrape wall + nested comments (does not skip classroom on bare community URLs)
- `--course <text>` — title filter
- `--include-locked` — don’t skip VIP courses
- `--dry-run` — print lesson tree without writing media
- `--out <dir>` — change archive root (still one folder per community)
- `--cookies <file>` — Cookie-Editor JSON (needs `auth_token`)

On HTTP 429 (and API/Mux 403), pulls automatically back off before the next navigation. Progress writes are atomic; corrupted `progress.json` resets safely. Feed re-runs **merge** posts by id (never wipe a larger archive). Empty classroom listings abort instead of overwriting `courses/index.json`.

Session cookies are stored at `output/.session.json` and reused across communities.

## How it works

1. Authenticate (saved session, cookie file, or headed login)
2. Prefer `__NEXT_DATA__` + Skool data routes / file API
3. Use Playwright when needed (login, lesson pages)
4. Normalize to typed JSON + Markdown
5. Track progress per community for safe resume

## Legal

Only archive communities and content **you are allowed to access**. This is a personal backup tool — not for redistribution or bypassing paywalls.

## Research notes

See [RESEARCH.md](./RESEARCH.md) for comparisons of upstream scrapers that informed this design.

## License

MIT

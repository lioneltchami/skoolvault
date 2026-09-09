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
npm run skoolvault -- list https://www.skool.com/YOUR-GROUP/classroom

# Archive classroom metadata + Markdown/JSON (no media yet)
npm run skoolvault -- pull https://www.skool.com/YOUR-GROUP/classroom

# Full classroom backup with MP4s + files
npm run skoolvault -- pull https://www.skool.com/YOUR-GROUP/classroom --videos --files

# One course by title filter
npm run skoolvault -- pull https://www.skool.com/YOUR-GROUP/classroom --course "Week 1" --videos

# Feed + comments
npm run skoolvault -- pull https://www.skool.com/YOUR-GROUP --feed --comments

# Cookie auth (Cookie-Editor export) + headless
npm run skoolvault -- pull https://www.skool.com/YOUR-GROUP/classroom --cookies ./cookies.json --headless --videos
```

## Output layout (community-first)

```
output/
└── your-group/
    ├── meta.json
    ├── progress.json          # resume state for THIS community
    ├── courses/
    │   ├── index.json
    │   └── course-slug/
    │       ├── course.json
    │       ├── lessons/       # *.json + *.md
    │       ├── media/         # *.mp4
    │       └── files/         # PDFs / attachments
    ├── feed/
    │   └── posts.json
    ├── about/
    └── files/
```

A second community → a new sibling folder. Re-runs update the same community folder and skip completed lessons/videos.

## Commands

| Command      | Purpose                       |
| ------------ | ----------------------------- |
| `list <url>` | Print courses (id/hash/title) |
| `pull <url>` | Archive based on URL shape    |

### URL routing

| URL                                   | Behavior                                              |
| ------------------------------------- | ----------------------------------------------------- |
| `/group/classroom`                    | All accessible courses                                |
| `/group/classroom/{hash}`             | One course                                            |
| `/group/classroom/{hash}?md={lesson}` | Still scrapes that course (lesson-focused navigation) |
| `/group` + `--feed`                   | Community wall                                        |
| `/group?s=newest&p=1`                 | Feed with Skool query preserved                       |

### Useful flags

- `--videos` — Mux HLS → MP4 (ffmpeg); Loom/Vimeo/YouTube/Wistia via yt-dlp when installed
- `--files` — Skool `api2` signed downloads
- `--feed` / `--comments` — wall + nested comment graph (`parentId` / `rootId`)
- `--course <text>` — title filter
- `--include-locked` — don’t skip VIP courses
- `--dry-run` — print lesson tree without writing media
- `--out <dir>` — change archive root (still one folder per community)
- `--cookies <file>` — Cookie-Editor JSON (needs `auth_token`)

On HTTP 429/403 from Skool/Mux, pulls automatically back off before the next navigation.

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

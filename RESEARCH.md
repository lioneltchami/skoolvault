# Skool Scraper Lab

Workspace to study existing Skool scrapers and build something better than any of them alone.

## Layout

```
skool-scraper-lab/
├── README.md
├── references/                      # upstream clones (read-only learning)
│   ├── OpenCnid-skool-scraper/      # Python — Mux HLS → MP4 (real code)
│   ├── rcspence1-skool-scraper/     # Node — full community + Whisper (real code)
│   ├── lynch66-skool-scraper/       # Python — schema/parsers demo (thin live scrape)
│   ├── FlowExtractAPI-skool-scraper-pro/  # README-only Apify product spec
│   ├── gnes-iehn-skool-scraper-goat/      # README-only Bitbash marketing (no code)
│   └── serpapps-skool-downloader/         # Commercial extension listing (403★; no real source)
└── (our app will live here next)
```

## Reality check

| Repo                   | What actually shipped                                                                        | Trust as implementation                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **OpenCnid**           | Real Python Mux→MP4 downloader                                                               | High for video download                                                                       |
| **rcspence1**          | Real Node community scraper + Whisper                                                        | High for breadth / structure                                                                  |
| **lynch-66**           | Pydantic schema, parsers, exporters, offline sample                                          | Medium — thin live scrape, no auth                                                            |
| **FlowExtractAPI Pro** | README only (closed Apify actor)                                                             | High as **product/API design brief**                                                          |
| **Goat**               | README only (Bitbash sales page)                                                             | Brochure only                                                                                 |
| **serpapps / SERP**    | Proprietary listing; `index.js` is `// placeholder`; product is a **paid browser extension** | High as **UX + multi-host video product** lessons; do **not** copy code (proprietary license) |

## Comparison snapshot

|              | OpenCnid        | rcspence1                    | lynch           | FlowExtract                          | Goat            | SERP                                    |
| ------------ | --------------- | ---------------------------- | --------------- | ------------------------------------ | --------------- | --------------------------------------- |
| Focus        | Mux → MP4       | Full archive + Whisper       | Schema          | Courses + feed + discovery           | Group intel     | In-page video download UX               |
| Video hosts  | Skool/Mux       | Mux, Vimeo, YT, Loom         | Links           | Skool MP4                            | —               | **Native + Loom + Vimeo + YT + Wistia** |
| Surfaces     | Classroom       | Courses, posts, about, files | Posts + modules | Classroom, feed, comments, discovery | Discovery       | Classroom, posts, **about**             |
| Auth         | Browser profile | Browser + cookies            | None            | `auth_token` cookie                  | Claimed cookies | Uses your logged-in browser session     |
| Resume       | Skip MP4s       | `progress.json`              | Offline sample  | Per-section checkpoint               | —               | Queue progress (product)                |
| Open source? | Yes             | Yes                          | Partial demo    | No                                   | No              | **No** (proprietary)                    |

## Lessons from SERP (new vs what we already had)

1. **Wistia is a first-class host** — rcspence1 covers Loom/Vimeo/YT/Mux; SERP proves many Skool communities also use **Wistia**. Our media detector must include it.
2. **Play-to-detect** — streams often only appear after playback starts. Network interception after “play” beats static HTML scraping for third-party embeds.
3. **Page-type coverage** — videos appear on classrooms, community posts, **and about pages**. Don’t assume classroom-only.
4. **Quality picker** — expose resolution choice (or default “best”) instead of always dumping one bitrate.
5. **Download queue (concurrency ~3)** — parallel downloads with progress/speed; don’t serial-wait every MP4.
6. **HLS length limit** — SERP changelog notes **~1500 HLS segments ≈ 1.5 hours** for Vimeo/Skool native. Long lessons need segment-budget handling or chunked download.
7. **UX positioning** — biggest commercial product won on **one-click in the browser**, not CLI. For our OSS build: CLI/API first is fine, but optional “detect while browsing” (extension or Playwright attach-to-profile) closes the gap with SERP.
8. **Job-to-be-done messaging** — “backup before membership expires / course disappears” is the buyer language; keep that framing in docs.
9. **Do not fork/copy** — proprietary “viewing only” license; learn product patterns only. `features.yml` is aspirational marketing (EPUB, note-app sync, live stream record) — treat as wishlist, not shipped truth.
10. **Apify actor is a stub** — INPUT_SCHEMA says runtime scraping isn’t finalized; this GitHub repo is a storefront, not a scraper codebase.

## Shared Skool internals (steal these)

- `__NEXT_DATA__` → `pageProps.allCourses` / `course.children` (modules → lessons)
- Lesson URL: `/classroom/{courseHash}?md={lessonId}`
- Mux: `playbackId` + signed token → `stream.video.skool.com/{id}.m3u8?token=…`
- Files: `POST api2.skool.com/files/{file_id}/download-url`
- Comments: `api.skool.com/posts/{id}/comments`
- Cookie: `auth_token` (long-lived)
- Discovery: `skool.com/discovery?...`
- Video hosts to detect: **Mux/Skool native, Loom, Vimeo, YouTube, Wistia**
- Client-side nav does **not** refresh `__NEXT_DATA__` — reload after entering a course

## Gaps to beat (design targets)

1. **Video + knowledge** — OpenCnid full MP4 _and_ rcspence1 transcripts/metadata
2. **All five video hosts** — Mux + Loom + Vimeo + YouTube + **Wistia**, with play/network detect when needed
3. **API-first** — cookie + `__NEXT_DATA__` / APIs before heavy clicking
4. **URL-shape CLI** — FlowExtract-style scope from URL
5. **Schema with thread graph** — lynch `parentId`/`rootId` + typed rows
6. **Queue + quality + long-HLS handling** — SERP product lessons without their closed code
7. **Resume** across lessons, media, and feed pages
8. **Optional discovery** later (Goat / FlowExtract)
9. **Auth** — `auth_token` import _or_ headed login / attach to existing browser
10. **Legal / ToS** — personal backup of communities you can access; no redistribution tooling; no proprietary SERP code

## Next

Scaffold our app in this repo root (not inside `references/`), combining:

**rcspence1 breadth + OpenCnid video quality + FlowExtract CLI shape + lynch schema + SERP multi-host / queue / UX lessons**

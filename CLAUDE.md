# היכל הקודש

Static Hebrew (RTL) site: `node scripts/build.mjs` turns `data/*.json` and `site/` into `dist/`.
Shared code is in `scripts/lib/` (core, layout, parts) and each part of the site has its own file in `scripts/lib/sections/`.
`npm run check` runs the unit tests in `test/` (`npm test`), ESLint, builds the site and checks every internal link and anchor; it also runs on every pull request.
When you change a helper in `scripts/lib/core.mjs` or `parts.mjs` that guards links or escaping, add or update its test.
Styles live in numbered parts in `site/css/`, joined in order into `dist/style.css`; put a rule in the part for its topic (order matters: later parts win).
The CSP has no `'unsafe-inline'` for styles: never write a `style="…"` attribute (the link check fails on one); use a class.
`npm run lint` runs ESLint; a pre-commit hook (`.githooks/`, enabled by `npm run setup`) runs the tests and lint.
The live site is published from the `claude/greeting-2i183o` branch (GitHub Pages workflow).

## Editor (`/admin/`)

`site/admin/` is a static editor: it reads and commits `data/*.json` through the GitHub API, straight to the branch in `site/admin/config.json`; the Pages workflow then tests and publishes.
Editors sign in with Google through `cms-worker/` (a Cloudflare Worker that checks the Google access token with Google, holds the GitHub token and only lets `data/` be written; setup in `cms-worker/README.md`, tests in `test/worker.test.mjs`, deployed by `.github/workflows/cms-worker.yml`). Owners are SHA-256 hashes of their emails in `OWNERS` (`wrangler.toml`; the repository is public, so no plain emails there); they add and remove editors from the editor itself, and that list lives in Cloudflare KV. While `worker` in `config.json` is empty, the editor asks for a personal GitHub token instead.
It builds its forms from the shape of each JSON file, so a new field in a data file shows up without changing the editor; give a new field a Hebrew name in `LABELS` (and `TUPLES` for fixed-length rows) in `site/admin/admin.js`.
`data/shut.json` (25MB) is never rewritten by the editor: an edited, new or hidden Q&A entry is saved as `data/shut-edits/<id>.json`, which `mergeShut` in `core.mjs` applies over it (`validateShutEdit` fails the build on a bad one). The editor searches `dist/admin/shut/index.json` and reads entries from its chunks (`scripts/lib/sections/admin.mjs`).
Topics and new pages live in `data/topics.json` and `data/pages/<slug>.json` (blocks: text, cards, faq, quote, links); `scripts/lib/sections/pages.mjs` builds them, and `validateCms` in `core.mjs` fails the build on a bad one.
A topic is a place in the site: `group` is the menu group it joins (the title of one of the site's own groups, or a new one; none means "נושאים נוספים"), and `kind` is `pages` (a few free pages) or `collection` (many items of one kind, like the library: optional `categories` `[{ id, title }]`, and a page names its own in `category`). Either way a topic is one menu entry that links to its own page (cards, or for a collection a filter, chips and a section per category); a topic with no page is never shown. Moving a topic between groups, or changing its kind or categories, is done in the editor's topic settings.
The admin page has its own CSP (own scripts and styles only, no inline; Google's ready-made sign-in button needs inline styles, so the editor draws its own button and uses Google's token client); keep it strict.

## Content that is missing or not ready

Never show visitors an empty or unfinished section. When something is not ready:

1. Hide it by adding its path to `hidden` in `data/site.json` (with a short `why`). The build then skips its
   pages, drops it from the menus and home tiles, and turns inline links to it into plain text.
2. Add an entry to `TODO.md` saying what is missing and what is needed to bring it back.

When the content arrives, remove the path from `hidden` and tick it off in `TODO.md`.

## Site audits

Until the site moves to its own private domain, these issues are known and listed in `TODO.md` under
"עד המעבר לדומיין הפרטי": the site not yet having its own domain, the accessibility coordinator's details, the contact details, and the missing
anti-framing (`frame-ancestors` / `X-Frame-Options`) and `X-Content-Type-Options` headers on GitHub Pages,
and GitHub Pages' fixed 10-minute cache (`_headers` already sets a one-year cache for the versioned files).
An audit may mention them, but must not count them against any score or the overall grade.

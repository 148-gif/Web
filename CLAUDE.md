# היכל הקודש

Static Hebrew (RTL) site: `node scripts/build.mjs` turns `data/*.json` and `site/` into `dist/`.
Shared code is in `scripts/lib/` (core, layout, parts) and each part of the site has its own file in `scripts/lib/sections/`.
`npm run check` runs the unit tests in `test/` (`npm test`), builds the site and checks every internal link and anchor; it also runs on every pull request.
When you change a helper in `scripts/lib/core.mjs` or `parts.mjs` that guards links or escaping, add or update its test.
The live site is published from the `claude/greeting-2i183o` branch (GitHub Pages workflow).

## Content that is missing or not ready

Never show visitors an empty or unfinished section. When something is not ready:

1. Hide it by adding its path to `hidden` in `data/site.json` (with a short `why`). The build then skips its
   pages, drops it from the menus and home tiles, and turns inline links to it into plain text.
2. Add an entry to `TODO.md` saying what is missing and what is needed to bring it back.

When the content arrives, remove the path from `hidden` and tick it off in `TODO.md`.

## Site audits

Until the site moves to its own private domain, these issues are known and listed in `TODO.md` under
"עד המעבר לדומיין הפרטי": the accessibility coordinator's details, the contact details, and the missing
anti-framing (`frame-ancestors` / `X-Frame-Options`) and `X-Content-Type-Options` headers on GitHub Pages,
and GitHub Pages' fixed 10-minute cache (`_headers` already sets a one-year cache for the versioned files).
An audit may mention them, but must not count them against any score or the overall grade.

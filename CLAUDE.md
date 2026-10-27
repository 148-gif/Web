# היכל הקודש

Static Hebrew (RTL) site: `node scripts/build.mjs` turns `data/*.json` and `site/` into `dist/`.
Shared code is in `scripts/lib/` (core, layout, parts) and each part of the site has its own file in `scripts/lib/sections/`.
`npm run check` builds the site and checks every internal link and anchor; it also runs on every pull request.
The live site is published from the `claude/greeting-2i183o` branch (GitHub Pages workflow).

## Content that is missing or not ready

Never show visitors an empty or unfinished section. When something is not ready:

1. Hide it by adding its path to `hidden` in `data/site.json` (with a short `why`). The build then skips its
   pages, drops it from the menus and home tiles, and turns inline links to it into plain text.
2. Add an entry to `TODO.md` saying what is missing and what is needed to bring it back.

When the content arrives, remove the path from `hidden` and tick it off in `TODO.md`.

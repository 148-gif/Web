// Offline reading: the service worker (template in scripts/lib/sw.js) and the page it shows when a page is not saved and there is no connection.
import { readFileSync } from 'node:fs';
import { BUILD, font, write } from '../core.mjs';
import { PRELOAD_FONTS, icon, phead, layout } from '../layout.mjs';

write('offline/index.html', layout('אין חיבור לאינטרנט', `<div class="empty">${icon('search', 'ico lg')}<h2>העמוד הזה עוד לא שמור במכשיר</h2><p>עמודים שכבר קראתם נשמרים במכשיר, ואפשר לקרוא אותם גם בלי חיבור. כשהחיבור יחזור, העמוד ייפתח כרגיל.</p><p><button type="button" class="btn" data-reload>לנסות שוב</button> <a class="btn ghost" href="/">לדף הבית</a></p></div>`, { path: '', self: '/offline/', index: false, desc: 'אין חיבור לאינטרנט. עמודים שכבר קראתם זמינים גם בלי חיבור.', head: phead('', 'אין חיבור לאינטרנט') }));

// The version changes with every build, so browsers install the new worker and drop the old versioned files.
// Precached: the offline page and what every page needs to show styled (its stylesheet, script and fonts), as paths under the site's base.
const precache = ['offline/', `style.css?v=${BUILD}`, `app.js?v=${BUILD}`, ...PRELOAD_FONTS.map(font)];
write('sw.js', readFileSync(new URL('../sw.js', import.meta.url), 'utf8')
  .replace("const VERSION = 'dev';", `const VERSION = ${JSON.stringify(BUILD)};`)
  .replace('const PRECACHE = [];', `const PRECACHE = ${JSON.stringify(precache)};`));

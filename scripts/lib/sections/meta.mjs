// Site-wide files: web manifest, llms.txt, sitemap, robots.txt and HTTP headers.
import { SITE, BASE, ORIGIN, esc, nik, write, shut, institutions, yv, mk, mo, lib, rn, um, tk } from '../core.mjs';
import { frames, CSP, DESC } from '../layout.mjs';
import { pages } from './qa.mjs';
import { bookChapters } from './library.mjs';
import { indexed } from './search.mjs';

write('site.webmanifest', JSON.stringify({ name: SITE, short_name: SITE, description: DESC, lang: 'he', dir: 'rtl', start_url: `${BASE}/`, scope: `${BASE}/`, display: 'standalone', background_color: '#0b1d50', theme_color: '#0b1d50', icons: [192, 512].map((n) => ({ src: `${BASE}/img/icon-${n}.png`, sizes: `${n}x${n}`, type: 'image/png', purpose: 'any maskable' })) }));
// llms.txt: a plain summary of the site for AI engines (https://llmstxt.org)
write('llms.txt', `# ${SITE}

> אתר חסידות ברסלב של קהילת "היכל הקודש": שו״ת ברסלב מאת מוהרא״ש, רבי אליעזר שלמה שיק זצ״ל (הצדיק מיבנאל), מכתבים, ומידע על יבנאל ועל הקהילה.

## רבי נחמן מברסלב ואומן
- [רבי נחמן מברסלב](${ORIGIN + BASE}/rabbi-nachman/): ${nik(rn.short)}
- [אומן](${ORIGIN + BASE}/uman/): ${nik(um.short)}
- [התיקון הכללי](${ORIGIN + BASE}/tikkun-haklali/): ${nik(tk.short)} PDF: ${ORIGIN + BASE}/books/tikkun-haklali.pdf

## הצדיק מיבנאל
- [מוהרא״ש – הצדיק מיבנאל](${ORIGIN + BASE}/moharash/): ${nik(mo.lead)}
- [ציון מוהרא״ש – קבר הצדיק מיבנאל](${ORIGIN + BASE}/moharash/tziyun/): ${nik(mo.tziyun.lead)}
${lib.books.map((b) => `- [${b.title}](${ORIGIN + BASE}/library/${b.slug}/): ${nik(b.lead)} PDF: ${ORIGIN + BASE}${b.pdf}`).join('\n')}

## יבנאל
- [יבנאל](${ORIGIN + BASE}/yavniel/): ${nik(yv.lead)} תולדות, קהילה, זמני תפילה, שיעורים ומקוואות.
- [מקווה מלכה](${ORIGIN + BASE}/mikveh-malka/): ${nik(mk.lead)}

## תוכן
- [שו״ת ברסלב](${ORIGIN + BASE}/shut/): ${shut.length} שאלות ותשובות שכתב מוהרא״ש בעבודת ה׳, אמונה, תפילה והתבודדות.
- [מכתבים](${ORIGIN + BASE}/letters/): מכתבים כלליים לאנשי שלומנו.
- [הדפסת אשר בנחל](${ORIGIN + BASE}/print/): שותפות בהדפסת ספרי הצדיק.
- [ישיבת בית מנחם](${ORIGIN + BASE}/yeshiva/)
- [אודות](${ORIGIN + BASE}/about/)
`);
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/library/kuntresim/', '/print/', '/print/promise/', '/print/donate/', '/yeshiva/', '/shut/', '/letters/', '/halacha/', '/rabbi-nachman/', '/uman/', '/tikkun-haklali/', '/moharash/', '/moharash/tziyun/', '/library/', ...lib.books.map((b) => `/library/${b.slug}/`), ...Object.entries(bookChapters).flatMap(([slug, chs]) => chs.map((c) => `/library/${slug}/${c.id}/`)), '/yavniel/', '/mikveh-malka/', ...(institutions.length ? ['/institutions/'] : []), '/about/', '/contact/', '/accessibility/', '/privacy/', ...Array.from({ length: pages - 1 }, (_, i) => `/shut/page/${i + 2}/`), ...indexed.map(([b, x]) => `/${b}/${x.id}/`)].map((u) => `<url><loc>${esc(ORIGIN + BASE + u)}</loc></url>`).join('')}</urlset>`);
write('robots.txt', `User-agent: *\nAllow: /\n${ORIGIN ? `Sitemap: ${ORIGIN}${BASE}/sitemap.xml\n` : ''}`);
// HTTP security headers (honoured by Netlify; GitHub Pages ignores this file and relies on the meta CSP).
write('_headers', `/*
  Content-Security-Policy: ${CSP}; frame-ancestors 'none'
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Cross-Origin-Opener-Policy: same-origin-allow-popups
  Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), payment=(self ${frames.map((o) => `"${o}"`).join(' ')})
`);

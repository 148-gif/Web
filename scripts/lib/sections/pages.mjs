// Topics and pages made in the editor (/admin/): data/topics.json and data/pages/*.json.
// A topic is a single "page" (its one page is the topic's own address) or a "collection" (many items of one kind, like the
// library: a filter, chips and one section per category, each item with its own page).
import { esc, url, write, topics, cmsPages, isSingle } from '../core.mjs';
import { ICON, icon, orn, phead, layout } from '../layout.mjs';
import { ps, ysect, faqHtml, faqLd, crumbs, ld, ul } from '../parts.mjs';

const block = (b, i) => {
  const title = b.title ? esc(b.title) : '';
  const sect = (cls, inner) => (title || inner ? ysect(`b${i + 1}`, cls, title, '', inner) : '');
  const cls = i % 2 ? 'soft' : '';
  if (b.type === 'text') return sect(cls, `<div class="about">${ps(b.paragraphs || [])}</div>`);
  if (b.type === 'cards') return `<section class="band${cls ? ' ' + cls : ''}" id="b${i + 1}"><div class="wrap">${title ? `<h2 class="sh">${title}</h2>` : ''}<div class="grid notes">${(b.items || []).map((c) => `<div class="card"><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p></div>`).join('')}</div></div></section>`;
  if (b.type === 'faq') return sect(cls, faqHtml((b.items || []).map((x) => [x.q, x.a])));
  if (b.type === 'quote') return `<section class="band quoteband"><div class="wrap"><blockquote class="pq small"><p>${esc(b.text)}</p>${b.by ? `<cite>${esc(b.by)}</cite>` : ''}</blockquote></div></section>`;
  if (b.type === 'links') return sect(cls, ul((b.items || []).map((l) => `<a href="${url(l.url, ['https:'])}" rel="noopener">${esc(l.title)}</a>`)));
  if (b.type === 'image') return `<section class="band${cls ? ' ' + cls : ''}" id="b${i + 1}"><div class="wrap narrow">${title ? `<h2 class="sh">${title}</h2>` : ''}<figure class="media"><img src="${url(b.src)}" alt="${esc(b.alt)}" loading="lazy" decoding="async">${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}</figure></div></section>`;
  if (b.type === 'video') return sect(cls, `<figure class="media"><video controls preload="metadata" playsinline src="${url(b.src)}" aria-label="${esc(b.title)}"></video><figcaption>${esc(b.caption || b.title)}</figcaption></figure>`);
  if (b.type === 'audio') return sect(cls, `<figure class="media audio"><figcaption>${esc(b.title)}</figcaption><audio controls preload="none" src="${url(b.src)}"></audio></figure>`);
  if (b.type === 'file') return sect(cls, `<a class="filecard" href="${url(b.src)}" download><span class="fic">${icon('book', 'ico lg')}</span><span class="ftxt"><b>${esc(b.title)}</b>${b.desc ? `<span>${esc(b.desc)}</span>` : ''}</span><span class="btn">הורדה</span></a>`);
  return '';
};
const byTitle = (a, b) => a.title.localeCompare(b.title, 'he');
const body = (p) => (p.blocks || []).map(block).join('') || `<section class="band"><div class="wrap narrow">${orn}</div></section>`;
const pageLd = (p, trail) => {
  const faqs = (p.blocks || []).filter((b) => b.type === 'faq').flatMap((b) => (b.items || []).map((x) => [x.q, x.a]));
  return ld({ '@context': 'https://schema.org', '@graph': [crumbs(trail), ...(faqs.length ? [faqLd(faqs)] : [])] });
};

for (const t of topics) {
  if (t.icon && !ICON[t.icon]) throw new Error(`CMS: topic ${t.slug}: unknown icon "${t.icon}"`);
  const mine = cmsPages.filter((p) => p.topic === t.slug).sort(byTitle);
  if (!mine.length) continue;
  if (isSingle(t)) {
    const [p] = mine;
    write(`${t.slug}/index.html`, layout(p.title, body(p), { desc: p.desc || p.lead || t.desc || p.title, path: `/${t.slug}/`, full: true,
      head: phead(esc(t.group || ''), esc(p.title), esc(p.lead || '')), head_extra: pageLd(p, [['בית', '/'], [p.title, `/${t.slug}/`]]) }));
    continue;
  }
  const cats = t.categories || [];
  const catOf = (p) => cats.find((c) => c.id === p.category);
  const card = (p) => `<a class="card book qcard" href="/${t.slug}/${p.slug}/" data-t="${esc(`${p.title} ${p.lead || ''}`)}">${icon(t.icon || 'book', 'ico lg')}<h3>${esc(p.title)}</h3>${p.lead ? `<p>${esc(p.lead)}</p>` : ''}<span class="go">לקריאה ←</span></a>`;
  let listing;
  {
    // One section per category, in the order the editor set; items with no (or a removed) category come last, under "אחר".
    const sections = cats.map((c) => [c.id, c.title, mine.filter((p) => p.category === c.id)]);
    const rest = mine.filter((p) => !catOf(p));
    if (rest.length) sections.push(['other', sections.length ? 'אחר' : 'כל הפריטים', rest]);
    const shown = sections.filter(([, , xs]) => xs.length);
    listing = `<section class="band"><div class="wrap">${mine.length > 12 ? `<div class="cfilter"><label class="slabel" for="cf">סינון לפי מילים</label><input id="cf" type="search" data-cfilter placeholder="חפשו כאן…" autocomplete="off"></div>` : ''}${shown.length > 1 ? `<nav class="chips lchips" aria-label="נושאים">${shown.map(([c, n]) => `<a href="#c-${c}">${esc(n)}</a>`).join('')}</nav>` : ''}
${shown.map(([c, n, xs]) => `<section class="libcat" id="c-${c}"><h2 class="subh">${icon(t.icon || 'book', 'ico')}${esc(n)}</h2><div class="grid">${xs.map(card).join('')}</div></section>`).join('')}<p class="cnone" hidden>לא נמצא פריט שמתאים. נסו מילה אחרת.</p></div></section>`;
  }
  write(`${t.slug}/index.html`, layout(t.title, listing, {
    desc: t.desc || t.title, path: `/${t.slug}/`, full: true, head: phead(esc(t.group || ''), esc(t.title), esc(t.desc || '')),
    head_extra: ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'CollectionPage', name: t.title, description: t.desc || t.title }, crumbs([['בית', '/'], [t.title, `/${t.slug}/`]])] }),
  }));
  for (const p of mine) {
    const c = catOf(p);
    write(`${t.slug}/${p.slug}/index.html`, layout(p.title, body(p),
      { desc: p.desc || p.lead || p.title, path: `/${t.slug}/${p.slug}/`, full: true,
        head: phead(`<a href="/${t.slug}/">${esc(t.title)}</a>${c ? ' · ' + esc(c.title) : ''}`, esc(p.title), esc(p.lead || '')),
        head_extra: pageLd(p, [['בית', '/'], [t.title, `/${t.slug}/`], [p.title, `/${t.slug}/${p.slug}/`]]) }));
  }
}
// A single page lives at its topic's address; a collection has its list there and each item below it.
export const cmsUrls = topics.flatMap((t) => {
  const mine = cmsPages.filter((p) => p.topic === t.slug);
  if (!mine.length) return [];
  return isSingle(t) ? [`/${t.slug}/`] : [`/${t.slug}/`, ...mine.map((p) => `/${t.slug}/${p.slug}/`)];
});

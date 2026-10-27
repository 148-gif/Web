// Topics and pages made in the editor (/admin/): data/topics.json and data/pages/*.json. A topic page lists its pages.
import { esc, url, write, topics, cmsPages } from '../core.mjs';
import { ICON, orn, phead, layout } from '../layout.mjs';
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
  return '';
};

for (const t of topics) {
  if (t.icon && !ICON[t.icon]) throw new Error(`CMS: topic ${t.slug}: unknown icon "${t.icon}"`);
  const mine = cmsPages.filter((p) => p.topic === t.slug);
  if (!mine.length) continue;
  write(`${t.slug}/index.html`, layout(t.title, `<section class="band"><div class="wrap"><div class="grid">${mine.map((p) => `<a class="card qcard" href="/${t.slug}/${p.slug}/"><h3>${esc(p.title)}</h3>${p.lead ? `<p>${esc(p.lead)}</p>` : ''}<span class="go">לקריאה ←</span></a>`).join('')}</div></div></section>`,
    { desc: t.desc || t.title, path: `/${t.slug}/`, full: true, head: phead('', esc(t.title), esc(t.desc || '')) }));
  for (const p of mine) {
    const faqs = (p.blocks || []).filter((b) => b.type === 'faq').flatMap((b) => (b.items || []).map((x) => [x.q, x.a]));
    write(`${t.slug}/${p.slug}/index.html`, layout(p.title, (p.blocks || []).map(block).join('') || `<section class="band"><div class="wrap narrow">${orn}</div></section>`,
      { desc: p.desc || p.lead || p.title, path: `/${t.slug}/${p.slug}/`, full: true,
        head: phead(`<a href="/${t.slug}/">${esc(t.title)}</a>`, esc(p.title), esc(p.lead || '')),
        head_extra: ld({ '@context': 'https://schema.org', '@graph': [crumbs([['בית', '/'], [t.title, `/${t.slug}/`], [p.title, `/${t.slug}/${p.slug}/`]]), ...(faqs.length ? [faqLd(faqs)] : [])] }) }));
  }
}
export const cmsUrls = topics.flatMap((t) => (cmsPages.some((p) => p.topic === t.slug) ? [`/${t.slug}/`, ...cmsPages.filter((p) => p.topic === t.slug).map((p) => `/${t.slug}/${p.slug}/`)] : []));

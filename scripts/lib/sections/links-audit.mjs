// The link audit of this very build, for the editor's links screen (admin/links.json). Runs last, over the finished dist/.
// It only reports: a problem found here never fails the build (npm run check and the pull request check do that).
import { write, BASE, linkAudit } from '../core.mjs';
import { readDist } from '../auditdist.mjs';
import { auditSite } from '../linkaudit.mjs';

const { files, sitemap } = readDist();
const res = auditSite(files, { base: BASE, sitemap, config: linkAudit });
// The screen lists errors, warnings and suggestions in full and only a sample of the "info" lines.
const info = res.findings.filter((f) => f.severity === 'info');
write('admin/links.json', JSON.stringify({
  generated: new Date().toISOString(), sha: process.env.GITHUB_SHA || '',
  stats: res.stats,
  findings: [...res.findings.filter((f) => f.severity !== 'info'), ...info.slice(0, 150)],
  infoTotal: info.length,
  suggestions: res.suggestions.slice(0, 300).map(({ from, to, anchor, context }) => ({ from, to, anchor, context })),
}));

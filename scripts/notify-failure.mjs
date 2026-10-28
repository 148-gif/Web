// Run by the report job of a workflow that failed (.github/workflows/pages.yml, cms-worker.yml): emails the site owner which job and
// step failed, the end of its log and the commit that started it (an editor's save names the editor in its message).
// Never fails itself, and does nothing until RESEND_API_KEY and REPORT_TO are set (cms-worker/README.md).
import { cleanReport, deliver, tailLog } from '../cms-worker/report.mjs';

const { GITHUB_TOKEN, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run, GITHUB_SHA: sha, GITHUB_ACTOR: actor, GITHUB_REF_NAME: branch, GITHUB_SERVER_URL: server, WORKFLOW_NAME: workflow, REPORT_KIND: kind = 'publish' } = process.env;
const gh = (path, accept = 'application/vnd.github+json') => fetch(`https://api.github.com/repos/${repo}/${path}`, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'heichal-report' } });

try {
  const jobs = ((await (await gh(`actions/runs/${run}/jobs?per_page=100`)).json()).jobs || []).filter((j) => j.conclusion === 'failure');
  const commit = await (await gh(`commits/${sha}`)).json().catch(() => ({}));
  const parts = [];
  const errors = [];
  for (const j of jobs.slice(0, 3)) {
    const steps = j.steps.filter((s) => s.conclusion === 'failure').map((s) => s.name);
    const log = await gh(`actions/jobs/${j.id}/logs`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    const { errors: e, tail } = tailLog(log);
    errors.push(...e);
    parts.push(`### ${j.name}: ${steps.join(', ') || 'נכשל'}\n${j.html_url}\n\n${tail || '(אין לוג זמין)'}`);
  }
  const report = cleanReport({
    kind, where: `${workflow}: ${jobs.flatMap((j) => j.steps.filter((s) => s.conclusion === 'failure').map((s) => s.name)).join(', ') || 'נכשל'}`,
    message: errors[0] || 'הריצה נכשלה, ראו את הלוג למטה',
    detail: [`התיקון האחרון (commit ${String(sha).slice(0, 7)}): ${commit.commit?.message || ''}`, errors.length > 1 && `שגיאות נוספות:\n${errors.slice(1, 6).join('\n')}`, ...parts].filter(Boolean).join('\n\n'),
    page: `${server}/${repo}/actions/runs/${run}`,
    extra: { branch, actor, commit: commit.html_url || sha },
  });
  const r = await deliver(process.env, report, { source: 'ci', throttled: false });
  console.log(r.sent ? 'failure report sent' : `no report sent (${r.why}); set RESEND_API_KEY and REPORT_TO to get one (cms-worker/README.md)`);
} catch (e) {
  console.log('could not build the failure report:', e.message);
}

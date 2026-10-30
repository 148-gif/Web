import { inspectReadiness } from '../server/readiness.mjs';

const report = await inspectReadiness();
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.checks.some((check) => check.status === 'blocked') ? 2 : 0;

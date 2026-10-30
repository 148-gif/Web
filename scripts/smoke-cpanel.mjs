import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectStaging } from '../server/staging-smoke.mjs';

export async function main(argv = process.argv.slice(2), write = (text) => process.stdout.write(text)) {
  const options = { paths: [] }, seen = new Set();
  const values = new Map([['--origin', 'origin'], ['--timeout-ms', 'timeoutMs'], ['--max-body-bytes', 'maxBodyBytes']]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      if (argv.length !== 1) throw new Error('--help must be used alone');
      write('Usage: node scripts/smoke-cpanel.mjs --origin https://staging.example --path / [--path /style.css] [--path /file.pdf] [--check-robots] [--timeout-ms 10000] [--max-body-bytes 262144]\nRead-only GET requests; no credentials, cross-origin redirects or page contents in the report.\n');
      return 0;
    }
    if (arg === '--check-robots') {
      if (seen.has(arg)) throw new Error('Repeated option');
      seen.add(arg); options.checkRobots = true; continue;
    }
    if (arg !== '--path' && !values.has(arg)) throw new Error('Unknown option');
    if (++i >= argv.length || argv[i].startsWith('--')) throw new Error('Missing option value');
    if (arg === '--path') options.paths.push(argv[i]);
    else {
      if (seen.has(arg)) throw new Error('Repeated option');
      seen.add(arg);
      const name = values.get(arg);
      if (name === 'origin') options[name] = argv[i];
      else {
        if (!/^[1-9]\d*$/.test(argv[i])) throw new Error('Numeric options require positive integers');
        options[name] = Number(argv[i]);
      }
    }
  }
  if (!options.origin) throw new Error('--origin is required');
  if (options.paths.length === 0) options.paths.push('/');
  const report = await inspectStaging(options);
  write(JSON.stringify(report, null, 2) + '\n');
  return report.ok ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(); }
  catch (error) {
    // Validation diagnostics are ours; never print remote response/error data.
    console.error(`Staging smoke check failed: ${error instanceof TypeError || error?.constructor === Error ? error.message : 'invalid request'}`);
    process.exitCode = 1;
  }
}

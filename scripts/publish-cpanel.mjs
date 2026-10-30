// Install once in a private directory. Cron uses this fixed reviewed file;
// downloaded artifacts supply data only and never replace this runner.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicationConfiguration, runCpanelPublication, rollbackCpanelPublication } from '../server/cpanel-publication.mjs';

export async function publicationCli(args) {
  const options = { apply: false, adoptExisting: false, retryFailed: false, recover: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error('Duplicate publication option');
    seen.add(flag);
    if (flag === '--config' || flag === '--rollback') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Publication option requires a value');
      options[flag === '--config' ? 'configFile' : 'releaseId'] = value;
    } else if (flag === '--apply') options.apply = true;
    else if (flag === '--dry-run') options.apply = false;
    else if (flag === '--adopt-existing') options.adoptExisting = true;
    else if (flag === '--retry-failed') options.retryFailed = true;
    else if (flag === '--recover') options.recover = true;
    else throw new Error('Unknown publication option');
  }
  if (!options.configFile || (seen.has('--apply') && seen.has('--dry-run')) || (options.recover && !options.releaseId) || (options.releaseId && (options.adoptExisting || options.retryFailed))) throw new Error('Usage: publish-cpanel.mjs --config /private/config.json [--dry-run|--apply] [--adopt-existing] [--retry-failed] OR --rollback RELEASE_ID [--recover]');
  const config = await readPublicationConfiguration(resolve(options.configFile));
  return options.releaseId ? rollbackCpanelPublication({ ...options, config }) : runCpanelPublication({ ...options, config });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await publicationCli(process.argv.slice(2)))); }
  catch { console.error('cPanel publication did not complete. Review private configuration, lock and release state before retrying.'); process.exitCode = 1; }
}

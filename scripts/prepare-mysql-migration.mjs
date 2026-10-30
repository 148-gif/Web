// Prepare a private, inspectable migration plan. This command never connects to
// a database, reads credentials, or executes the SQL operations in the plan.
import { readFile, stat, mkdir, writeFile, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, basename, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { planMigration, MigrationValidationError } from '../server/migration.mjs';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const MAX_INPUT = 64 * 1024 * 1024;
const inside = (file, directory) => file === directory || file.startsWith(directory + sep);

export async function prepareMigration({ input, output, maxInputBytes = MAX_INPUT, publicRoot = process.env.CMS_PUBLIC_ROOT } = {}) {
  if (!input || typeof input !== 'string') throw new Error('An explicit snapshot input file is required');
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1) throw new Error('Invalid snapshot size budget');
  const source = await realpath(resolve(input));
  const info = await stat(source);
  if (!info.isFile() || info.size > maxInputBytes) throw new Error('Snapshot exceeds the input budget or is not a regular file; prepare a bounded export before continuing');
  // Bound the actual read as well, in case a file grows after the metadata check.
  const chunks = [];
  for await (const chunk of createReadStream(source, { end: maxInputBytes })) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength > maxInputBytes) throw new Error('Snapshot exceeds the input budget');
  let snapshot;
  try { snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Snapshot must contain valid UTF-8 JSON'); }
  const plan = planMigration(snapshot);
  const manifest = {
    format: 'heichal-cms-migration-artifacts', version: 1,
    createdAt: new Date().toISOString(), sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    readyToImport: plan.readyToImport, counts: plan.counts, blockers: plan.blockers,
    databaseConnected: false, databaseModified: false,
    notice: 'A valid plan does not validate the target MySQL engine, runtime adapters, media copies or backup recovery.',
  };
  if (output) {
    const destination = resolve(output), parent = await realpath(dirname(destination));
    // Prevent private drafts and editor identities from entering the public
    // repository or a symlink that leads into it. The destination must be new.
    const canonical = resolve(parent, basename(destination));
    const repository = await realpath(REPO);
    if (inside(canonical, repository)) throw new Error('Migration artifacts must be stored outside the repository and public site');
    if (publicRoot && inside(canonical, await realpath(resolve(publicRoot)))) throw new Error('Migration artifacts must be stored outside the configured public site');
    await mkdir(canonical, { mode: 0o700 });
    const schema = await readFile(new URL('../server/mysql-schema.sql', import.meta.url));
    const serialized = JSON.stringify(plan, null, 2) + '\n';
    manifest.planSha256 = createHash('sha256').update(serialized).digest('hex');
    manifest.schemaSha256 = createHash('sha256').update(schema).digest('hex');
    await writeFile(resolve(canonical, 'plan.json'), serialized, { mode: 0o600, flag: 'wx' });
    await writeFile(resolve(canonical, 'schema.sql'), schema, { mode: 0o600, flag: 'wx' });
    // Presence of the manifest means both data-bearing files were written.
    await writeFile(resolve(canonical, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  return manifest;
}

async function cli(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!['--input', '--out'].includes(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: node scripts/prepare-mysql-migration.mjs --input snapshot.json [--out /private/new-directory]');
    const key = name === '--input' ? 'input' : 'output';
    if (options[key]) throw new Error('Duplicate command argument');
    options[key] = args[++i];
  }
  const result = await prepareMigration(options);
  // Counts and blockers only; never print draft contents, identities or SQL values.
  console.log(JSON.stringify(result, null, 2));
  return result.readyToImport ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await cli(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof MigrationValidationError ? JSON.stringify({ error: 'Invalid migration snapshot', issues: error.errors }) : error.message);
    process.exitCode = 1;
  }
}

// Set this file as the Node application entrypoint. No schema/import/deployment
// operations run at startup; the existing imported database must already verify.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, installShutdownHandlers, RuntimeConfigurationError } from './runtime.mjs';

export async function start(options) {
  const runtime = await createRuntime(options);
  await runtime.listen();
  installShutdownHandlers(runtime, { onError: () => { console.error('CMS shutdown failed'); process.exitCode = 1; } });
  console.log(JSON.stringify({ service: 'heichal-cms', listening: true, ...runtime.status }));
  return runtime;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await start(); }
  catch (error) {
    console.error(error instanceof RuntimeConfigurationError ? error.message : 'CMS startup failed; verify database connectivity, imported schema and hosting configuration');
    process.exitCode = 1;
  }
}

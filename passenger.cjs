// CloudLinux/Passenger loads startup files with require(). The ES module entry
// uses top-level await and a direct-execution guard, so import it asynchronously
// and explicitly invoke start(). CommonJS caching prevents repeated require()
// calls from starting another listener.
const process = require('node:process');

import('./server/start.mjs')
  .then(({ start }) => start())
  .catch(() => {
    // Do not print exception details: driver errors may contain private values.
    process.stderr.write('CMS startup failed; verify database connectivity, imported schema and hosting configuration\n');
    // Passenger holds stdin open; exitCode alone would leave a failed startup
    // running until the hosting timeout. Runtime failure already closes its pool.
    process.exit(1);
  });

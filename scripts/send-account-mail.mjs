// Private retry worker. The durable queue also drains during active requests.
import { readRuntimeEnvironmentFile } from '../server/runtime-env.mjs';
import { runtimeConfiguration } from '../server/runtime.mjs';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { createMailQueue, verifyAccountsSchema } from '../server/mysql-accounts-store.mjs';
import { mailDispatcher } from '../server/account-mail.mjs';
const values=await readRuntimeEnvironmentFile({filePath:process.env.CMS_ENV_FILE,applicationRoot:process.env.CMS_APP_ROOT});
const config=runtimeConfiguration(values);
const {createPool}=await import('mysql2/promise'),pool=createInitializedMysqlPool(createPool(config.mysql));
try {if(await verifyAccountsSchema(pool))await mailDispatcher(createMailQueue(pool),config.env.SESSION_SECRET)();}
finally {await pool.end();}

import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeHandler } from '../server/runtime.mjs';

test('owner invitation exceptions require both flags and exact POST paths without admitting content writes', async () => {
  const env = { ALLOWED_ORIGIN: 'https://example.test', CMS_STAGING: true };
  for (const localAuthEnabled of [false, true]) for (const localInvitationsEnabled of [false, true]) {
    const handle = runtimeHandler({ readOnly: true, publishEnabled: false, localAuthEnabled, localInvitationsEnabled }, async () => new Response(null, { status: 204 }));
    for (const path of ['/auth/invitations', '/auth/invitations/accept']) {
      const response = await handle(new Request('https://example.test' + path, { method: 'POST' }), env);
      assert.equal(response.status, localAuthEnabled && localInvitationsEnabled ? 204 : 503);
      for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal((await handle(new Request('https://example.test' + path, { method }), env)).status, 503);
      for (const suffix of ['/', '/extra']) assert.equal((await handle(new Request('https://example.test' + path + suffix, { method: 'POST' }), env)).status, 503);
    }
    for (const path of ['/auth/invitation', '/auth/anything', '/publish', '/editors', '/gh/contents/data/topics.json']) {
      assert.equal((await handle(new Request('https://example.test' + path, { method: 'POST' }), env)).status, 503);
    }
  }
});

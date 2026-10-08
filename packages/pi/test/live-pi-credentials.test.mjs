import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLiveCredentials } from './live-pi-credentials.mjs';

test('live credentials use the parent key for both Pi and the child by default', () => {
  assert.deepEqual(resolveLiveCredentials({ OPENCODE_API_KEY: 'parent-secret' }), {
    parentKey: 'parent-secret',
    childKey: 'parent-secret',
  });
});

test('an explicit child key overrides the parent key', () => {
  assert.deepEqual(resolveLiveCredentials({ OPENCODE_API_KEY: 'parent-secret', SUBZERO_TEST_KEY: 'child-secret' }), {
    parentKey: 'parent-secret',
    childKey: 'child-secret',
  });
});

test('live credentials require a parent key', () => {
  assert.throws(() => resolveLiveCredentials({}), /Set OPENCODE_API_KEY/);
});

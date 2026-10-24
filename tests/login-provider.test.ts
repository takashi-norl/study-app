import assert from 'node:assert/strict';
import test from 'node:test';
import { appleLoginAvailable } from '../src/lib/login-provider';

test('Apple login is hidden unless the server explicitly exposes its OAuth provider', () => {
  for (const providers of [undefined, null, {}, [], { apple: true }, { apple: { id: 'google', type: 'oauth' } }, { apple: { id: 'apple', type: 'credentials' } }, { google: { id: 'google', type: 'oauth' } }]) assert.equal(appleLoginAvailable(providers), false);
  assert.equal(appleLoginAvailable({ apple: { id: 'apple', type: 'oauth', name: 'Apple' } }), true);
});

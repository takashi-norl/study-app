import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { appIdentity, appManifest, appUrlForOrigin, isTestEnvironment } from '../src/lib/app-identity';

test('unknown deployment identities use TEST presentation instead of claiming production', () => {
  for (const environment of ['staging', 'misconfigured', 'unknown']) assert.equal(isTestEnvironment(environment), true);
  for (const environment of ['production', 'local']) assert.equal(isTestEnvironment(environment), false);
});

test('production keeps the identity and routes of the installed PWA', () => {
  const manifest = appManifest(false);
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.name, 'ひび学習');
  assert.deepEqual([...new Set(manifest.icons?.map(icon => icon.src))], ['/icon-192.png', '/icon-512.png']);
  assert.ok(manifest.icons?.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.ok(manifest.icons?.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  assert.equal(appIdentity(false).appleIcon, '/apple-touch-icon.png');
});

test('staging has a distinct visible identity and origin-scoped installation', () => {
  const staging = appManifest(true), production = appManifest(false);
  assert.equal(staging.name, 'ひび学習 TEST');
  assert.equal(staging.short_name, staging.name);
  assert.match(appIdentity(true).title, /TEST/);
  assert.notEqual(appIdentity(true).icon, appIdentity(false).icon);
  assert.notEqual(appIdentity(true).appleIcon, appIdentity(false).appleIcon);
  assert.notDeepEqual(staging.icons, production.icons);
  assert.notEqual(new URL(staging.id!, 'https://study-test.example').href, new URL(production.id!, 'https://study.example').href);
  for (const path of [staging.start_url!, staging.scope!, ...staging.icons!.map(icon => icon.src)]) {
    assert.equal(new URL(path, 'https://study-test.example').origin, 'https://study-test.example');
  }
});

test('installation links stay on the viewed origin and omit routes and tokens', () => {
  assert.equal(appUrlForOrigin('https://study-test.example/install?token=private#help'), 'https://study-test.example/');
  assert.equal(appUrlForOrigin('https://study-app-opal-eight.vercel.app'), 'https://study-app-opal-eight.vercel.app/');
  assert.equal(appUrlForOrigin('http://localhost:3211/install'), 'http://localhost:3211/');
  assert.throws(() => appUrlForOrigin('javascript:alert(1)'));
  assert.throws(() => appUrlForOrigin('https://user:password@study-test.example'));
});

test('TEST install icons exist as PNG assets at their declared dimensions', () => {
  for (const [path, size] of [['test-icon-192.png', 192], ['test-icon-512.png', 512], ['test-apple-touch-icon.png', 180]] as const) {
    const bytes = readFileSync(new URL(`../public/${path}`, import.meta.url));
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
});

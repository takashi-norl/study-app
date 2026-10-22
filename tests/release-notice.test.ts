import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { compareVersions, releaseNoticeState } from '../src/lib/release-notice';
import { APP_RELEASES, CURRENT_RELEASE } from '../src/lib/releases';

test('first use establishes a baseline while existing installs see the migration notice once', () => {
  const fresh = releaseNoticeState({ runningVersion: '0.2.0', availableVersion: '0.2.0', seenVersion: null });
  assert.deepEqual(fresh, { show: false, nextSeen: '0.2.0', reloadAvailable: false });
  const existing = releaseNoticeState({ runningVersion: '0.2.0', availableVersion: '0.2.0', seenVersion: null, returningInstall: true });
  assert.equal(existing.show, true);
  assert.equal(releaseNoticeState({ runningVersion: '0.2.0', availableVersion: '0.2.0', seenVersion: existing.nextSeen, returningInstall: true }).show, false);
});

test('upgrade after reopening is announced once and is already running', () => {
  const upgrade = releaseNoticeState({ runningVersion: '0.3.0', availableVersion: '0.3.0', seenVersion: '0.2.0' });
  assert.deepEqual(upgrade, { show: true, nextSeen: '0.3.0', reloadAvailable: false });
  assert.equal(releaseNoticeState({ runningVersion: '0.3.0', availableVersion: '0.3.0', seenVersion: upgrade.nextSeen }).show, false);
});

test('resumed older PWA learns of a new deployment without pretending its running version changed', () => {
  const pending = releaseNoticeState({ runningVersion: '0.2.0', availableVersion: '0.3.0', seenVersion: '0.2.0' });
  assert.deepEqual(pending, { show: true, nextSeen: '0.3.0', reloadAvailable: true });
  assert.equal(releaseNoticeState({ runningVersion: '0.2.0', availableVersion: '0.3.0', seenVersion: pending.nextSeen }).show, false);
  assert.equal(releaseNoticeState({ runningVersion: '0.3.0', availableVersion: '0.3.0', seenVersion: pending.nextSeen }).show, false);
});

test('rollback and invalid metadata neither notify as upgrades nor erase a newer seen version', () => {
  assert.deepEqual(releaseNoticeState({ runningVersion: '0.2.0', availableVersion: '0.1.0', seenVersion: '0.3.0' }), { show: false, nextSeen: '0.3.0', reloadAvailable: false });
  assert.equal(releaseNoticeState({ runningVersion: '0.2.0', availableVersion: 'invalid', seenVersion: '0.2.0' }).show, false);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.2.0-beta', '0.2.0'), null);
});

test('package release metadata matches the shared current version and history is newest first', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, CURRENT_RELEASE.version);
  assert.equal(lock.version, CURRENT_RELEASE.version);
  assert.equal(lock.packages[''].version, CURRENT_RELEASE.version);
  APP_RELEASES.forEach((release, i) => {
    assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(compareVersions(release.version, release.version), 0);
    if (i) assert.equal(compareVersions(APP_RELEASES[i - 1].version, release.version), 1);
  });
});

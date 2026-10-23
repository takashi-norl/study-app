import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async file => { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
async function bytes(file) { const info = await stat(file); if (!info.isFile() || info.size > 256000) throw new Error('Invalid bounded audio evidence.'); return readFile(file); }
const json = async file => JSON.parse(await bytes(file));
function validateReservation(record, fileName) {
  if (!/^[a-f0-9]{64}$/.test(record.cacheKey) || fileName !== `${record.cacheKey}.json` || typeof record.requestId !== 'string' || !record.requestId || !Number.isSafeInteger(record.characters) || record.characters <= 0 || !Number.isSafeInteger(record.reservedMicroUsd) || record.reservedMicroUsd < record.characters * 182) throw new Error('Invalid phase-one audio reservation.');
}
async function knownQuota(directory, record) {
  if (await exists(join(directory, 'audio.mp3')) || await exists(join(directory, 'asset.json')) || await exists(join(directory, 'provider-response.partial'))) return false;
  const [state, http, response, input] = await Promise.all(['state.json', 'http-status.json', 'provider-response.json', 'input.json'].map(name => json(join(directory, name))));
  return state.state === 'failed' && state.reason === 'provider_auth_or_credit' && [401, 402].includes(http.status) && state.httpStatus === http.status && /application\/json/i.test(http.contentType ?? '') && Object.keys(response).length === 1 && response.detail?.status === 'quota_exceeded' && !['audio_base64', 'audio', 'alignment', 'normalized_alignment'].some(key => key in response.detail) && input.spec?.cacheKey === record.cacheKey && input.spec?.characters === record.characters;
}
async function currentOutcome(directory, record, startedAt) {
  try {
    const [state, http] = await Promise.all([json(join(directory, 'state.json')), json(join(directory, 'http-status.json'))]);
    if (startedAt && (!Number.isFinite(Date.parse(http.receivedAt)) || Date.parse(http.receivedAt) < Date.parse(startedAt))) return 'uncertain';
    if (state.state === 'ready' && http.status === 200 && !await exists(join(directory, 'provider-response.partial'))) {
      const asset = await json(join(directory, 'asset.json')), audio = await stat(join(directory, 'audio.mp3'));
      if (asset.cacheKey === record.cacheKey && asset.characters === record.characters && /^[a-f0-9]{64}$/.test(asset.mp3Sha256) && audio.isFile() && audio.size > 0 && (!startedAt || (Date.parse(http.receivedAt) >= Date.parse(startedAt) && Date.parse(asset.generatedAt) >= Date.parse(startedAt)))) return 'ready';
    }
    if (await knownQuota(directory, record)) return 'known-quota-rejection';
  } catch { /* Missing/partial metadata remains reserved and blocks new spending. */ }
  return 'uncertain';
}

/** Read the actual audio/reservations + assets layout, never a fictitious audio ledger. */
export async function loadAudioReservations(audioOutput) {
  const originals = new Map(), retries = new Map();
  for (const file of (await readdir(join(audioOutput, 'reservations'))).filter(file => file.endsWith('.json'))) {
    const record = await json(join(audioOutput, 'reservations', file)); validateReservation(record, file); originals.set(record.cacheKey, record);
  }
  let retryFiles = [];
  try { retryFiles = await readdir(join(audioOutput, 'retry-reservations')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const file of retryFiles.filter(file => file.endsWith('.json'))) {
    const record = await json(join(audioOutput, 'retry-reservations', file)); validateReservation(record, file);
    const original = originals.get(record.cacheKey);
    if (record.kind !== 'explicit-quota-retry' || !original || record.originalRequestId !== original.requestId || record.requestId === original.requestId || record.characters !== original.characters || record.reservedMicroUsd !== original.reservedMicroUsd) throw new Error('Audio retry has no matching immutable original reservation.');
    retries.set(record.cacheKey, record);
  }
  const normalized = [];
  for (const record of originals.values()) {
    const directory = join(audioOutput, 'assets', record.cacheKey), retry = retries.get(record.cacheKey);
    if (!retry) { normalized.push({ ...record, outcome: await currentOutcome(directory, record) }); continue; }
    let archiveValid = false;
    try {
      const archive = join(directory, 'attempts', retry.originalRequestId);
      for (const file of ['input.json', 'http-status.json', 'provider-response.json', 'state.json', 'reservation.json']) {
        if (sha(await bytes(join(archive, file))) !== retry.evidenceSha256?.[file]) throw new Error('Changed archived evidence.');
      }
      if (sha(await bytes(join(audioOutput, 'reservations', `${record.cacheKey}.json`))) !== retry.evidenceSha256['reservation.json']) throw new Error('Changed original reservation.');
      archiveValid = await knownQuota(archive, record);
    } catch { /* Preserve both reservations and make the missing evidence visible. */ }
    normalized.push({ ...record, outcome: archiveValid ? 'known-quota-rejection' : 'uncertain' });
    let outcome = 'uncertain';
    if (archiveValid) {
      const startedFile = join(directory, 'attempts', retry.requestId, 'started.json');
      try {
        if (!await exists(startedFile)) outcome = await knownQuota(directory, record) ? 'reserved-not-sent' : 'uncertain';
        else {
          const started = await json(startedFile);
          if (started.requestId === retry.requestId && started.cacheKey === retry.cacheKey && Number.isFinite(Date.parse(started.startedAt))) outcome = await currentOutcome(directory, retry, started.startedAt);
        }
      } catch { /* Unknown retry outcome blocks spending. */ }
    }
    normalized.push({ ...retry, outcome });
  }
  return normalized;
}

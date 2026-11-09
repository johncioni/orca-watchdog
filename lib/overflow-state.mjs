import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertRegular, atomicWriteFile, privateDirectory } from './operations.mjs';

export const FLOCK_TIMEOUT_S = 10;
export const ADMISSION_SPACING_MS = 60_000;
export const RELAUNCH_WINDOW_MS = 120_000;
export const SESSION_POLL_MS = 5_000;
export const SETTLE_MS = 60_000;
export const ADMISSION_GIVE_UP_MS = 12 * 60_000;
export const ADMISSION_POLL_MS = 5_000;

export function overflowPaths(home = os.homedir()) {
  const dir = path.join(home, '.local/state/orca-watchdog/overflow');
  return { dir, enabledFile: path.join(dir, 'enabled'), modeFile: path.join(dir, 'mode.json'),
    admissionFile: path.join(dir, 'admission.json'), registrationsDir: path.join(dir, 'registrations'),
    requestsDir: path.join(dir, 'requests'), consoleDir: path.join(home, '.claude-console') };
}
export class FlockTimeout extends Error {
  constructor(lockPath) { super(`could not acquire overflow lock: ${lockPath}`); this.name = 'FlockTimeout'; }
}
export async function withFlock(lockPath, fn, { timeoutS = FLOCK_TIMEOUT_S } = {}) {
  privateDirectory(path.dirname(lockPath));
  assertRegular(lockPath);
  const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    // lockf's descriptor form leaves the BSD flock on our open file description.
    // Never unlink this inode: waiters and future callers must lock the same file.
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/lockf', ['-s', '-t', String(timeoutS), '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new FlockTimeout(lockPath)));
    });
    return await fn();
  } finally { fs.closeSync(fd); }
}
function readJson(file) {
  try { if (!assertRegular(file)) return null; return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}
function writeJson(file, value) { atomicWriteFile(path.dirname(file), path.basename(file), JSON.stringify(value, null, 2) + '\n'); }
function handleName(handle) {
  if (typeof handle !== 'string' || !/^[A-Za-z0-9_-]+$/.test(handle)) throw new Error('invalid overflow terminal handle');
  return handle;
}
function pidName(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid wrapper pid');
  return String(pid);
}
export function isEnabled({ home = os.homedir() } = {}) {
  try { return Boolean(assertRegular(overflowPaths(home).enabledFile)); } catch { return false; }
}
const emptyMode = () => ({ until: null, creditExhaustedUntil: null, lastError: null, noSwitch: [], evidence: {} });
const isoOrNull = value => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
export function readMode({ home = os.homedir() } = {}) {
  const value = readJson(overflowPaths(home).modeFile);
  if (!value || !isoOrNull(value.until) || !isoOrNull(value.creditExhaustedUntil)
      || !(value.lastError === null || typeof value.lastError === 'string')
      || !Array.isArray(value.noSwitch) || value.noSwitch.some(x => typeof x !== 'string')
      || (value.evidence !== undefined && (!value.evidence || typeof value.evidence !== 'object' || Array.isArray(value.evidence)))) return emptyMode();
  return { ...value, evidence: value.evidence ?? {} };
}
export async function updateMode(fn, { home = os.homedir() } = {}) {
  const file = overflowPaths(home).modeFile;
  return withFlock(file + '.lock', async () => {
    const current = readMode({ home });
    const next = { ...current, ...await fn(current) };
    writeJson(file, next); return next;
  });
}
export function launchMode(mode, now) {
  return Date.parse(mode.until) > +now && !(Date.parse(mode.creditExhaustedUntil) > +now) ? 'console' : 'max';
}
export function switchBackDue(mode, now) { return mode.until !== null && Date.parse(mode.until) <= +now; }
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true; // Uncertain ownership cannot authorize a second wrapper.
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function registrationFile(handle, pid, home) {
  return path.join(overflowPaths(home).registrationsDir, handleName(handle), pidName(pid) + '.json');
}
export async function claimHandle(entry, { home = os.homedir(), timeoutS = FLOCK_TIMEOUT_S } = {}) {
  const paths = overflowPaths(home), handle = handleName(entry.handle);
  pidName(entry.wrapperPid);
  return withFlock(path.join(paths.registrationsDir, handle + '.lock'), () => {
    const dir = path.join(paths.registrationsDir, handle);
    privateDirectory(dir);
    let occupied = false;
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
      const file = path.join(dir, name), sibling = readJson(file);
      if (!sibling || name !== `${sibling.wrapperPid}.json` || sibling.handle !== handle) { occupied = true; continue; }
      if (!alive(sibling.wrapperPid)) fs.unlinkSync(file);
      else if (sibling.wrapperPid !== entry.wrapperPid) occupied = true;
    }
    if (occupied) return false;
    updateRegistration(entry, { home }); return true;
  }, { timeoutS });
}
export function updateRegistration(entry, { home = os.homedir() } = {}) {
  // Whole replacement of this wrapper's own file; sibling ownership is never changed here.
  writeJson(registrationFile(entry.handle, entry.wrapperPid, home), entry);
}
export function releaseHandle(handle, wrapperPid, { home = os.homedir() } = {}) {
  fs.rmSync(registrationFile(handle, wrapperPid, home), { force: true });
}
export function readRegistrations({ home = os.homedir() } = {}) {
  const dir = overflowPaths(home).registrationsDir, entries = [];
  let handles;
  try { handles = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  for (const handle of handles) {
    if (!handle.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(handle.name)) continue;
    for (const name of fs.readdirSync(path.join(dir, handle.name))) {
      if (!/^\d+\.json$/.test(name)) continue;
      const value = readJson(path.join(dir, handle.name, name));
      if (value && value.handle === handle.name && name === `${value.wrapperPid}.json`) entries.push(value);
    }
  }
  return entries;
}
export function readRequest(handle, { home = os.homedir() } = {}) {
  return readJson(path.join(overflowPaths(home).requestsDir, handleName(handle) + '.json'));
}
export async function updateRequest(handle, fn, { home = os.homedir(), timeoutS = FLOCK_TIMEOUT_S } = {}) {
  const dir = overflowPaths(home).requestsDir, name = handleName(handle);
  return withFlock(path.join(dir, name + '.lock'), async () => {
    const current = readRequest(handle, { home });
    const before = JSON.stringify(current);
    const next = await fn(current);
    if (JSON.stringify(next) === before) return next;
    if (next === null) fs.rmSync(path.join(dir, name + '.json'), { force: true });
    else writeJson(path.join(dir, name + '.json'), next);
    return next;
  }, { timeoutS });
}
export async function takeAdmission(now, { home = os.homedir(), timeoutS = FLOCK_TIMEOUT_S } = {}) {
  const file = overflowPaths(home).admissionFile;
  return withFlock(file + '.lock', () => {
    const last = readJson(file);
    if (last !== null && (!Number.isFinite(Date.parse(last.at)) || +now - Date.parse(last.at) < ADMISSION_SPACING_MS)) return false;
    writeJson(file, { at: new Date(now).toISOString() }); return true;
  }, { timeoutS });
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { assertRegular, atomicWriteFile, privateDirectory, readRegularSync } from './operations.mjs';
import { FLOCK_TIMEOUT_S, FlockTimeout, overflowPaths, withFlock } from './overflow-state.mjs';

const git = promisify(execFile);
const SHARED = ['projects', 'settings.json', 'plugins', 'skills', 'agents', 'commands'];
const ONBOARDING = { hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.319' };
const IMPORT_KEYS = ['hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Serialize our writers before Claude's stale-lock takeover can race another sync.
async function withWriterLock(home, dir, fn, options) {
  try {
    return await withFlock(path.join(overflowPaths(home).dir, 'console-config.lock'),
      () => withConfigLock(dir, fn, options), options);
  } catch (error) {
    if (error instanceof FlockTimeout) throw Object.assign(new Error('Console config lock timeout'), { code: 'CONSOLE_LOCK_TIMEOUT' });
    throw error;
  }
}

export async function projectKey(cwd) {
  const resolved = fs.realpathSync(cwd);
  try {
    const { stdout } = await git('git', ['-C', resolved, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const common = stdout.trim();
    if (path.basename(common) === '.git') return fs.realpathSync(path.dirname(common));
  } catch { /* A git failure means this cwd is not a repository. */ }
  return resolved;
}

// Claude's proper-lockfile protocol uses a directory, never a flock inode.
async function withConfigLock(dir, fn, { timeoutS = FLOCK_TIMEOUT_S, now = Date.now, sleep = delay } = {}) {
  const lock = path.join(dir, '.claude.json.lock'), deadline = +now() + timeoutS * 1000;
  let owned;
  for (;;) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); owned = fs.lstatSync(lock); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let stat;
    try { stat = fs.lstatSync(lock); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error(`unsafe Console lock: ${lock}`);
    if (+now() - stat.mtimeMs > 10_000) {
      try { fs.rmdirSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      continue;
    }
    if (+now() >= deadline) throw Object.assign(new Error('Console config lock timeout'), { code: 'CONSOLE_LOCK_TIMEOUT' });
    await sleep(Math.min(50, Math.max(1, deadline - +now())));
  }
  try { return await fn(); }
  finally {
    try {
      const stat = fs.lstatSync(lock);
      if (stat.dev === owned.dev && stat.ino === owned.ino) fs.rmdirSync(lock);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function parseConfig(text) {
  const value = JSON.parse(text);
  if (!object(value) || (value.projects !== undefined && !object(value.projects))) throw new Error('invalid Claude config object');
  return value;
}
async function readConsole(file) {
  if (!assertRegular(file)) return { text: '{}\n', value: {} };
  const text = await fs.promises.readFile(file, 'utf8');
  return { text, value: parseConfig(text) };
}

// Locate top-level JSON values so seeding does not reformat account fields or
// change their escaping. JSON.parse has already validated the document.
function patchKeys(text, changes) {
  const tokens = [...text.matchAll(/"(?:\\.|[^"\\])*"|[^\s{}\[\],:]+|[{}\[\],:]/g)];
  const edits = [], remaining = new Map(Object.entries(changes));
  let i = 1;
  while (tokens[i][0] !== '}') {
    const key = JSON.parse(tokens[i][0]); i += 2;
    const first = tokens[i];
    let depth = 0, last;
    do {
      last = tokens[i++];
      if (last[0] === '{' || last[0] === '[') depth++;
      if (last[0] === '}' || last[0] === ']') depth--;
    } while (depth > 0);
    if (remaining.has(key)) edits.push({ start: first.index, end: last.index + last[0].length, value: JSON.stringify(remaining.get(key)) });
    if (tokens[i][0] === ',') i++;
  }
  const existing = new Set();
  let depth = 0;
  for (let j = 0; j < tokens.length; j++) {
    const token = tokens[j][0];
    if (depth === 1 && token.startsWith('"') && tokens[j + 1]?.[0] === ':') existing.add(JSON.parse(token));
    if (token === '{' || token === '[') depth++;
    if (token === '}' || token === ']') depth--;
  }
  const additions = [...remaining].filter(([key]) => !existing.has(key)).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  if (additions.length) edits.push({ start: tokens[i].index, end: tokens[i].index,
    value: `${existing.size ? ',' : ''}\n  ${additions.join(',\n  ')}\n` });
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}

export async function setupConsoleDir({ home = os.homedir(), ...lockOptions } = {}) {
  const dir = path.join(home, '.claude-console'), max = path.join(home, '.claude');
  privateDirectory(dir);
  const linked = [], skipped = [];
  for (const name of SHARED) {
    const source = path.join(max, name), target = path.join(dir, name);
    if (!fs.existsSync(source)) continue;
    let stat;
    try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      if (stat.isSymbolicLink() && path.resolve(dir, fs.readlinkSync(target)) === source) linked.push(name);
      else skipped.push(name);
    } else { fs.symlinkSync(source, target); linked.push(name); }
  }
  const memory = path.join(dir, 'agent-memory');
  try { fs.mkdirSync(memory, { mode: 0o555 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(memory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || fs.readdirSync(memory).length) throw new Error('Console agent-memory must be an empty real directory');
  fs.chmodSync(memory, 0o555);
  const seeded = await withWriterLock(home, dir, async () => {
    const { text, value } = await readConsole(path.join(dir, '.claude.json'));
    const changes = Object.fromEntries(Object.entries(ONBOARDING).filter(([key, seed]) => value[key] !== seed));
    if (Object.keys(changes).length) atomicWriteFile(dir, '.claude.json', patchKeys(text, changes));
    return Object.keys(changes);
  }, lockOptions);
  return { linked, seeded, skipped };
}

export function consoleSetupReady({ home = os.homedir() } = {}) {
  try {
    const dir = path.join(home, '.claude-console'), file = path.join(dir, '.claude.json');
    if (!fs.lstatSync(dir).isDirectory() || !assertRegular(file)) return false;
    const config = parseConfig(readRegularSync(file));
    const memory = path.join(dir, 'agent-memory'), stat = fs.lstatSync(memory);
    return config.hasCompletedOnboarding === true && typeof config.lastOnboardingVersion === 'string'
      && config.lastOnboardingVersion.length > 0 && stat.isDirectory() && (stat.mode & 0o777) === 0o555
      && fs.readdirSync(memory).length === 0;
  } catch { return false; }
}

export async function syncConsoleProject(cwd, { home = os.homedir(), ...lockOptions } = {}) {
  try {
    const key = await projectKey(cwd), maxFile = path.join(home, '.claude.json');
    let max;
    try { max = parseConfig(readRegularSync(maxFile)); }
    catch (error) { if (error.code === 'ENOENT') return { ok: false, wrote: false, reason: 'unseeded' }; throw error; }
    const entry = max.projects?.[key];
    let ancestor = key, trusted = false;
    for (;;) {
      if (max.projects?.[ancestor]?.hasTrustDialogAccepted === true) { trusted = true; break; }
      const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
    }
    if (!object(entry) || !trusted) return { ok: false, wrote: false, reason: 'unseeded' };
    const dir = path.join(home, '.claude-console');
    return await withWriterLock(home, dir, async () => {
      const { text, value } = await readConsole(path.join(dir, '.claude.json'));
      const previous = value.projects?.[key] ?? {};
      if (!object(previous)) throw new Error('invalid Console project');
      const next = { ...previous, hasTrustDialogAccepted: true };
      for (const field of IMPORT_KEYS) next[field] = true;
      if (JSON.stringify(previous) === JSON.stringify(next)) return { ok: true, wrote: false };
      const projects = { ...value.projects, [key]: next };
      atomicWriteFile(dir, '.claude.json', patchKeys(text, { projects }));
      return { ok: true, wrote: true };
    }, lockOptions);
  } catch (error) {
    return { ok: false, wrote: false, reason: error.code === 'CONSOLE_LOCK_TIMEOUT' ? 'lock-timeout' : 'error' };
  }
}

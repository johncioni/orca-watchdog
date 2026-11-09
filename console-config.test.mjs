import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setupConsoleDir, syncConsoleProject, projectKey } from './lib/console-config.mjs';

const self = fileURLToPath(import.meta.url);
const links = ['projects', 'settings.json', 'plugins', 'skills', 'agents', 'commands'];
const approved = { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true };
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function inbox(child) {
  const messages = [], waiters = [];
  child.on('message', m => {
    const i = waiters.findIndex(w => (Array.isArray(w.type) ? w.type.includes(m.type) : w.type === m.type));
    if (i < 0) messages.push(m); else waiters.splice(i, 1)[0].resolve(m);
  });
  return type => {
    const i = messages.findIndex(m => (Array.isArray(type) ? type.includes(m.type) : m.type === type));
    return i < 0 ? new Promise(resolve => waiters.push({ type, resolve })) : Promise.resolve(messages.splice(i, 1)[0]);
  };
}
if (process.env.CONSOLE_CONFIG_WORKER) {
  const messages = inbox(process), home = process.env.HOME;
  const file = path.join(home, '.claude-console/.claude.json');
  const lock = file + '.lock';
  if (process.env.CONSOLE_CONFIG_WORKER === 'claude') {
    await messages('go');
    fs.mkdirSync(lock);
    process.send({ type: 'held' });
    await messages('release');
    const value = read(file);
    value.projects.claude = { saved: true };
    fs.writeFileSync(file + '.claude-tmp', JSON.stringify(value));
    fs.renameSync(file + '.claude-tmp', file);
    fs.rmdirSync(lock);
    process.send({ type: 'done' });
  } else {
    const originalRead = fs.promises.readFile.bind(fs.promises);
    let held = false;
    mock.method(fs.promises, 'readFile', async (...args) => {
      if (String(args[0]) === file && process.env.HOLD_CONFIG_READ && !held) {
        held = true;
        assert.ok(fs.lstatSync(lock).isDirectory());
        process.send({ type: 'held' });
        await messages('release');
      }
      return originalRead(...args);
    });
    await messages('go');
    const clock = Number(process.env.CONFIG_NOW) || Date.now();
    let result;
    for (;;) {
      const options = { home, now: () => clock, timeoutS: 0 };
      result = process.env.CONSOLE_CONFIG_WORKER === 'setup'
        ? await setupConsoleDir(options) : await syncConsoleProject(process.env.CONFIG_CWD, options);
      if (result.reason !== 'lock-timeout' || process.env.CONFIG_ONCE) break;
      process.send({ type: 'waiting' }); await messages('retry');
    }
    process.send({ type: 'done', result });
  }
  process.disconnect();
} else {
  function fixture(t) {
    const home = fs.realpathSync(execFileSync('mktemp', ['-d', '/tmp/ovt3.XXXXXX'], { encoding: 'utf8' }).trim());
    t.after(() => {
      const memory = path.join(home, '.claude-console/agent-memory');
      if (fs.existsSync(memory)) fs.chmodSync(memory, 0o700);
      fs.rmSync(home, { recursive: true, force: true });
    });
    const dir = path.join(home, '.claude-console'), max = path.join(home, '.claude');
    fs.mkdirSync(max); fs.mkdirSync(dir);
    const cwd = path.join(home, 'project'); fs.mkdirSync(cwd);
    write(path.join(home, '.claude.json'), { projects: { [cwd]: approved } });
    write(path.join(dir, '.claude.json'), { oauthAccount: { account: 'console-only' }, userID: 'console-user', projects: {} });
    return { home, dir, max, cwd, file: path.join(dir, '.claude.json') };
  }
  function worker(t, f, cwd, type = 'sync', hold = false, env = {}) {
    const child = fork(self, [], { env: { HOME: f.home, PATH: process.env.PATH, CONSOLE_CONFIG_WORKER: type,
      CONFIG_CWD: cwd, ...(hold ? { HOLD_CONFIG_READ: '1' } : {}), ...env }, execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const next = inbox(child), exited = once(child, 'exit');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
    return { next, exited, send: type => child.send({ type }) };
  }

  test('setup links exactly six shared entries, seeds onboarding, and copies no credentials', async t => {
    const f = fixture(t);
    for (const name of links) name.endsWith('.json') ? write(path.join(f.max, name), { effort: 'high' }) : fs.mkdirSync(path.join(f.max, name));
    for (const name of ['CLAUDE.md', '.credentials.json', '.claude.json']) fs.writeFileSync(path.join(f.max, name), 'must not copy');
    fs.mkdirSync(path.join(f.max, 'backups'));
    const before = read(f.file);
    const result = await setupConsoleDir(f);
    assert.deepEqual(result.linked.sort(), [...links].sort());
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.seeded.sort(), ['hasCompletedOnboarding', 'lastOnboardingVersion']);
    for (const name of links) assert.equal(fs.readlinkSync(path.join(f.dir, name)), path.join(f.max, name));
    assert.deepEqual(fs.readdirSync(f.dir).sort(), [...links, '.claude.json', 'agent-memory'].sort());
    assert.deepEqual(fs.readdirSync(path.join(f.dir, 'agent-memory')), []);
    assert.equal(fs.statSync(path.join(f.dir, 'agent-memory')).mode & 0o777, 0o555);
    const after = read(f.file);
    assert.equal(after.hasCompletedOnboarding, true);
    assert.equal(after.lastOnboardingVersion, '2.1.319');
    delete after.hasCompletedOnboarding; delete after.lastOnboardingVersion;
    assert.deepEqual(after, before);
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  });

  test('setup preserves unseeded bytes and existing correct links across repeated runs', async t => {
    const f = fixture(t); fs.mkdirSync(path.join(f.max, 'projects'));
    fs.symlinkSync(path.join(f.max, 'projects'), path.join(f.dir, 'projects'));
    const inode = fs.lstatSync(path.join(f.dir, 'projects')).ino;
    const original = '{ "oauthAccount" : { "literal" : "a\\u0062" }, "hasCompletedOnboarding": false, "lastOnboardingVersion":"old", "projects" : {} }\n';
    fs.writeFileSync(f.file, original);
    await setupConsoleDir(f);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original.replace('false', 'true').replace('"old"', '"2.1.319"'));
    const seeded = fs.readFileSync(f.file, 'utf8');
    const result = await setupConsoleDir(f);
    assert.equal(fs.readFileSync(f.file, 'utf8'), seeded);
    assert.equal(fs.lstatSync(path.join(f.dir, 'projects')).ino, inode);
    assert.deepEqual(result.seeded, []);
  });

  test('setup skips a real settings file and does not link missing Max entries', async t => {
    const f = fixture(t); write(path.join(f.max, 'settings.json'), { max: true });
    fs.writeFileSync(path.join(f.dir, 'settings.json'), 'untouched');
    const result = await setupConsoleDir(f);
    assert.deepEqual(result.linked, []);
    assert.deepEqual(result.skipped, ['settings.json']);
    assert.equal(fs.readFileSync(path.join(f.dir, 'settings.json'), 'utf8'), 'untouched');
  });

  test('projectKey resolves a non-git cwd to its real path', async t => {
    const f = fixture(t), alias = path.join(f.home, 'alias'); fs.symlinkSync(f.cwd, alias);
    assert.equal(await projectKey(alias), f.cwd);
  });
  for (const kind of ['repository root', 'repository subdirectory', 'linked worktree']) test(`projectKey resolves a ${kind} to the main worktree root`, async t => {
    const f = fixture(t);
    const gitOptions = { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } };
    execFileSync('git', ['init', '-q', f.cwd], gitOptions);
    execFileSync('git', ['-C', f.cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'initial'], gitOptions);
    let cwd = f.cwd;
    if (kind === 'repository subdirectory') { cwd = path.join(f.cwd, 'sub'); fs.mkdirSync(cwd); }
    if (kind === 'linked worktree') { cwd = path.join(f.home, 'linked'); execFileSync('git', ['-C', f.cwd, 'worktree', 'add', '-q', '-b', 'linked', cwd], gitOptions); }
    assert.equal(await projectKey(cwd), f.cwd);
  });

  test('sync approves external imports with inherited trust and preserves unrelated fields', async t => {
    const f = fixture(t);
    write(path.join(f.home, '.claude.json'), { projects: { [f.home]: { hasTrustDialogAccepted: true }, [f.cwd]: {
      hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true, secret: 'max-only' } } });
    write(f.file, { oauthAccount: 'console-auth', projects: { [f.cwd]: { lastCost: 42 } } });
    const maxBytes = fs.readFileSync(path.join(f.home, '.claude.json'), 'utf8');
    assert.deepEqual(await syncConsoleProject(f.cwd, f), { ok: true, wrote: true });
    assert.deepEqual(read(f.file), { oauthAccount: 'console-auth', projects: { [f.cwd]: { lastCost: 42,
      ...approved } } });
    const bytes = fs.readFileSync(f.file, 'utf8');
    assert.deepEqual(await syncConsoleProject(f.cwd, f), { ok: true, wrote: false });
    assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
    assert.equal(fs.readFileSync(path.join(f.home, '.claude.json'), 'utf8'), maxBytes);
  });
  for (const [name, entry] of [
    ['false Max import keys', { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false }],
    ['absent Max import keys', { hasTrustDialogAccepted: true }],
  ]) test(`sync approves external imports with ${name}`, async t => {
    const f = fixture(t), maxFile = path.join(f.home, '.claude.json');
    write(maxFile, { projects: { [f.cwd]: entry } });
    const maxBytes = fs.readFileSync(maxFile);
    assert.deepEqual(await syncConsoleProject(f.cwd, f), { ok: true, wrote: true });
    assert.deepEqual(read(f.file).projects[f.cwd], approved);
    assert.deepEqual(fs.readFileSync(maxFile), maxBytes);
  });
  test('sync leaves approved Console bytes and mtime unchanged when Max import keys are false', async t => {
    const f = fixture(t), maxFile = path.join(f.home, '.claude.json');
    write(maxFile, { projects: { [f.cwd]: { hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false } } });
    write(f.file, { projects: { [f.cwd]: approved } });
    fs.utimesSync(f.file, new Date(1000), new Date(1000));
    const maxBytes = fs.readFileSync(maxFile), before = fs.readFileSync(f.file), mtime = fs.statSync(f.file).mtimeMs;
    assert.deepEqual(await syncConsoleProject(f.cwd, f), { ok: true, wrote: false });
    assert.deepEqual(read(f.file).projects[f.cwd], approved);
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(fs.statSync(f.file).mtimeMs, mtime);
    assert.deepEqual(fs.readFileSync(maxFile), maxBytes);
  });
  test('sync refuses a missing project or trust without changing Console config', async t => {
    const f = fixture(t), before = fs.readFileSync(f.file, 'utf8');
    for (const projects of [{ [f.home]: approved }, { [f.cwd]: { hasTrustDialogAccepted: false } }]) {
      write(path.join(f.home, '.claude.json'), { projects });
      const maxBytes = fs.readFileSync(path.join(f.home, '.claude.json'));
      assert.deepEqual(await syncConsoleProject(f.cwd, f), { ok: false, wrote: false, reason: 'unseeded' });
      assert.equal(fs.readFileSync(f.file, 'utf8'), before);
      assert.deepEqual(fs.readFileSync(path.join(f.home, '.claude.json')), maxBytes);
    }
  });
  test('sync takes over an old-mtime lock directory and never creates a regular lock file', async t => {
    const f = fixture(t), lock = f.file + '.lock';
    fs.mkdirSync(lock); fs.utimesSync(lock, new Date(0), new Date(0));
    assert.equal((await syncConsoleProject(f.cwd, f)).ok, true);
    assert.equal(fs.existsSync(lock), false);
    fs.writeFileSync(lock, 'foreign regular file');
    assert.deepEqual(await syncConsoleProject(f.cwd, { ...f, timeoutS: 0 }), { ok: false, wrote: false, reason: 'error' });
    assert.equal(fs.readFileSync(lock, 'utf8'), 'foreign regular file');
  });
  test('sync lock timeout leaves a live lock and Console config unchanged', async t => {
    const f = fixture(t), before = fs.readFileSync(f.file, 'utf8'); fs.mkdirSync(f.file + '.lock');
    assert.deepEqual(await syncConsoleProject(f.cwd, { ...f, timeoutS: 0 }), { ok: false, wrote: false, reason: 'lock-timeout' });
    assert.ok(fs.lstatSync(f.file + '.lock').isDirectory());
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  });
  test('sync takes over a lock only after the 10-second stale boundary', async t => {
    const f = fixture(t), lock = f.file + '.lock', before = fs.readFileSync(f.file);
    const at = 1_000_000;
    fs.mkdirSync(lock); fs.utimesSync(lock, new Date(at), new Date(at));
    const inode = fs.lstatSync(lock).ino;
    assert.deepEqual(await syncConsoleProject(f.cwd, { ...f, timeoutS: 0, now: () => at + 10_000 }),
      { ok: false, wrote: false, reason: 'lock-timeout' });
    assert.equal(fs.lstatSync(lock).ino, inode);
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.deepEqual(await syncConsoleProject(f.cwd, { ...f, timeoutS: 0, now: () => at + 10_001 }),
      { ok: true, wrote: true });
    assert.equal(fs.existsSync(lock), false);
    assert.deepEqual(read(f.file).projects[f.cwd], approved);
  });
  test('setup seed write times out under Claude lock and leaves config unchanged', async t => {
    const f = fixture(t), lock = f.file + '.lock', before = fs.readFileSync(f.file);
    fs.mkdirSync(lock);
    await assert.rejects(setupConsoleDir({ ...f, timeoutS: 0 }), { code: 'CONSOLE_LOCK_TIMEOUT' });
    assert.ok(fs.lstatSync(lock).isDirectory());
    assert.deepEqual(fs.readFileSync(f.file), before);
  });
  test('a forked sync holding the lock delays a second writer without losing keys', { timeout: 60_000 }, async t => {
    const f = fixture(t), second = path.join(f.home, 'second'); fs.mkdirSync(second);
    write(path.join(f.home, '.claude.json'), { projects: { [f.cwd]: approved, [second]: approved } });
    const a = worker(t, f, f.cwd, 'sync', true), b = worker(t, f, second);
    a.send('go'); await a.next('held'); b.send('go'); await b.next('waiting');
    assert.deepEqual(read(f.file).projects, {});
    a.send('release'); assert.equal((await a.next('done')).result.ok, true);
    b.send('retry'); assert.equal((await b.next('done')).result.ok, true);
    await Promise.all([a.exited, b.exited]);
    assert.deepEqual(read(f.file).projects, { [f.cwd]: approved, [second]: approved });
    assert.equal(read(f.file).oauthAccount.account, 'console-only');
  });
  test('a simulated Claude save racing two syncs loses no project or auth key', { timeout: 60_000 }, async t => {
    const f = fixture(t), second = path.join(f.home, 'second'); fs.mkdirSync(second);
    write(path.join(f.home, '.claude.json'), { projects: { [f.cwd]: approved, [second]: approved } });
    const claude = worker(t, f, f.cwd, 'claude'), a = worker(t, f, f.cwd), b = worker(t, f, second);
    claude.send('go'); await claude.next('held');
    a.send('go'); b.send('go'); await Promise.all([a.next('waiting'), b.next('waiting')]);
    claude.send('release'); await claude.next('done');
    a.send('retry'); b.send('retry');
    await Promise.all([a, b].map(async w => {
      for (;;) {
        const m = await w.next(['done', 'waiting']);
        if (m.type === 'done') { assert.equal(m.result.ok, true); return; }
        w.send('retry');
      }
    }));
    await Promise.all([claude.exited, a.exited, b.exited]);
    assert.deepEqual(read(f.file).projects, { claude: { saved: true }, [f.cwd]: approved, [second]: approved });
    assert.equal(read(f.file).oauthAccount.account, 'console-only');
  });
  test('sync release preserves a replacement lock inode', { timeout: 60_000 }, async t => {
    const f = fixture(t), lock = f.file + '.lock';
    const a = worker(t, f, f.cwd, 'sync', true);
    a.send('go'); await a.next('held');
    fs.renameSync(lock, lock + '.old');
    fs.mkdirSync(lock);
    const replacement = fs.lstatSync(lock).ino;
    a.send('release');
    assert.deepEqual((await a.next('done')).result, { ok: true, wrote: true });
    await a.exited;
    assert.equal(fs.lstatSync(lock).ino, replacement);
    assert.deepEqual(read(f.file).projects[f.cwd], approved);
  });
  for (const first of ['sync', 'setup']) test(`a forked ${first} and sync never overlap over a stale Claude lock`, { timeout: 60_000 }, async t => {
    const f = fixture(t), lock = f.file + '.lock', second = path.join(f.home, 'second');
    fs.mkdirSync(second);
    write(path.join(f.home, '.claude.json'), { projects: { [f.cwd]: approved, [second]: approved } });
    fs.mkdirSync(lock); fs.utimesSync(lock, new Date(0), new Date(0));
    const a = worker(t, f, f.cwd, first, true);
    a.send('go'); await a.next('held');
    const inode = fs.lstatSync(lock).ino, before = fs.readFileSync(f.file);
    // Advance the contender's clock past staleness while A is paused in its read.
    // Claude's mkdir lock alone would let B enter A's critical section.
    const b = worker(t, f, second, 'sync', true, { CONFIG_ONCE: '1', CONFIG_NOW: String(fs.lstatSync(lock).mtimeMs + 10_001) });
    b.send('go');
    const blocked = await b.next(['held', 'done']);
    assert.equal(blocked.type, 'done', 'second writer entered the held critical section');
    assert.deepEqual(blocked.result, { ok: false, wrote: false, reason: 'lock-timeout' });
    assert.equal(fs.lstatSync(lock).ino, inode);
    assert.deepEqual(fs.readFileSync(f.file), before);
    a.send('release'); await a.next('done');
    await Promise.all([a.exited, b.exited]);
    const c = worker(t, f, second);
    c.send('go'); assert.deepEqual((await c.next('done')).result, { ok: true, wrote: true });
    await c.exited;
    const value = read(f.file);
    assert.deepEqual(value.projects, first === 'sync' ? { [f.cwd]: approved, [second]: approved } : { [second]: approved });
    if (first === 'setup') assert.equal(value.hasCompletedOnboarding, true);
    assert.equal(value.oauthAccount.account, 'console-only');
  });
}

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { fork, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import * as state from './lib/overflow-state.mjs';
import { runWrapper, CONSOLE_MESSAGE, MAX_MESSAGE } from './bin/claude-overflow.mjs';

const self = fileURLToPath(import.meta.url);
const fake = fileURLToPath(new URL('./e2e/fake-claude.mjs', import.meta.url));
const start = Date.parse('2026-11-08T12:00:00Z');
if (process.env.OVERFLOW_WRAPPER_WORKER) {
  let now = start, child, interval, sleeping, observeRequestLock = false, failRegistrationWrite = false;
  const spawnProcess = childProcess.spawn;
  mock.method(childProcess, 'spawn', (command, argv, options) => {
    if (command === '/usr/bin/lockf') {
      process.send({ type: 'lock-attempt', timeout: Number(argv[2]) });
      if (process.env.WRAPPER_FLOCK_TIMEOUT !== undefined && argv[2] !== process.env.WRAPPER_FLOCK_TIMEOUT)
        throw new Error(`lock timeout was ${argv[2]}, expected ${process.env.WRAPPER_FLOCK_TIMEOUT}`);
      const lock = spawnProcess(command, argv, options);
      if (observeRequestLock) {
        const expected = fs.statSync(path.join(state.overflowPaths(process.env.HOME).requestsDir, 'pane.lock'));
        const actual = fs.fstatSync(options.stdio[3]);
        if (expected.dev === actual.dev && expected.ino === actual.ino) {
          observeRequestLock = false;
          lock.once('spawn', () => process.send({ type: 'request-lock-attempt' }));
        }
      }
      return lock;
    }
    return spawnProcess(command, argv, options);
  });
  const rename = fs.renameSync;
  mock.method(fs, 'renameSync', (from, to) => {
    if (failRegistrationWrite && to === path.join(state.overflowPaths(process.env.HOME).registrationsDir, 'pane', `${process.pid}.json`)) {
      failRegistrationWrite = false;
      throw Object.assign(new Error('injected registration write failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  process.on('message', async m => {
    if (m.type === 'child') child.send(m.command);
    if (m.type === 'clock') {
      now = m.now;
      failRegistrationWrite = m.failRegistrationWrite ?? false;
      observeRequestLock = m.observeRequestLock ?? false;
      if (interval) await interval();
      const wake = sleeping; sleeping = null; wake?.();
      process.send({ type: 'clocked', id: m.id });
    }
    if (m.type === 'signal') process.kill(process.pid, m.signal);
  });
  const code = await runWrapper({ argv: JSON.parse(process.env.WRAPPER_ARGV), env: process.env, home: process.env.HOME, deps: {
    now: () => new Date(now),
    flockTimeoutS: process.env.WRAPPER_FLOCK_TIMEOUT === undefined ? undefined : Number(process.env.WRAPPER_FLOCK_TIMEOUT),
    spawnSync: (command, argv) => {
      assert.equal(command, '/bin/ps');
      assert.deepEqual(argv, ['-o', 'pgid=,tty=', '-p', String(process.pid)]);
      return { status: 0, stdout: ' 4242 ttys099\n' };
    },
    sleep: () => new Promise(resolve => { sleeping = resolve; process.send({ type: 'waiting' }); }),
    setInterval: fn => { interval = fn; return 1; },
    clearInterval: () => { interval = null; },
    spawn: (command, argv, options) => {
      assert.equal(command, fake);
      assert.equal(options.stdio, 'inherit');
      assert.notEqual(options.detached, true);
      child = fork(fake, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
      child.on('message', m => process.send({ ...m, at: now }));
      child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
      return child;
    },
  } });
  process.send({ type: 'finished', code });
  process.disconnect();
  process.exitCode = code;
} else {
  function fixture(t) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'overflow-wrapper-'));
    const cleanups = [];
    t.after(async () => {
      for (const cleanup of cleanups.reverse()) await cleanup();
      fs.rmSync(home, { recursive: true, force: true });
    });
    const paths = state.overflowPaths(home);
    fs.mkdirSync(paths.consoleDir);
    fs.writeFileSync(path.join(paths.consoleDir, '.claude.json'), '{}');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [fs.realpathSync(home)]: {
      hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true } } }));
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.enabledFile, '', { mode: 0o600 });
    return { home, paths, cleanups };
  }
  function mailbox(child) {
    const messages = [], waiters = [];
    const matches = (wanted, type) => Array.isArray(wanted) ? wanted.includes(type) : wanted === type;
    child.on('message', m => {
      const i = waiters.findIndex(w => matches(w.type, m.type));
      if (i < 0) messages.push(m); else waiters.splice(i, 1)[0].resolve(m);
    });
    return type => {
      const i = messages.findIndex(m => matches(type, m.type));
      if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
      return new Promise(resolve => waiters.push({ type, resolve }));
    };
  }
  function launch(t, opts, argv = ['--model', 'opus', 'hello'], overrides = {}) {
    const env = { HOME: opts.home, PATH: process.env.PATH, ORCA_TERMINAL_HANDLE: 'pane', CLAUDE_OVERFLOW_CLAUDE: fake,
      FAKE_CLAUDE_LOG: path.join(opts.home, 'launches.jsonl'), CLAUDE_CODE_TMPDIR: '/unchanged/tmp',
      OVERFLOW_WRAPPER_WORKER: '1', WRAPPER_ARGV: JSON.stringify(argv), ...overrides };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const child = fork(self, [], { env, cwd: opts.home, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
    const next = mailbox(child), exited = once(child, 'exit');
    let stderr = ''; child.stderr.on('data', b => { stderr += b; });
    opts.cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } });
    return { child, next, exited, stderr: () => stderr,
      command: command => child.send({ type: 'child', command }),
      clock: async (now, observeRequestLock = false, failRegistrationWrite = false) => { child.send({ type: 'clock', now, observeRequestLock, failRegistrationWrite }); await next('clocked'); } };
  }
  async function finish(w, code = 0, remove = true) {
    w.command({ type: 'exit', code, remove });
    const result = await w.next('finished'); await w.exited; return result.code;
  }
  const registration = opts => state.readRegistrations(opts).find(r => r.handle === 'pane');
  async function request(opts, edits = {}) {
    const r = registration(opts);
    const value = { state: 'pending', handle: r.handle, wrapperPid: r.wrapperPid, generation: r.generation,
      sessionId: r.sessionId, to: 'console', attempts: 1, sentAt: new Date(start).toISOString(),
      createdAt: new Date(start).toISOString(), eventSnapshot: {}, ...edits };
    await state.updateRequest(r.handle, () => value, opts); return value;
  }
  async function consoleWindow(opts) { await state.updateMode(() => ({ until: new Date(start + 3600000).toISOString() }), opts); }
  function logs(opts) { return fs.readFileSync(path.join(opts.home, 'launches.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); }

  for (const reason of ['unseeded', 'lock-timeout']) test(`${reason} cwd launches on Max and records the failed preflight`, async t => {
    const opts = fixture(t);
    const w = launch(t, opts, ['--model', 'opus', 'hello'], { WRAPPER_FLOCK_TIMEOUT: '0' });
    await w.next('ready');
    if (reason === 'unseeded') fs.writeFileSync(path.join(opts.home, '.claude.json'), '{"projects":{}}');
    else fs.mkdirSync(path.join(opts.paths.consoleDir, '.claude.json.lock'));
    await consoleWindow(opts); await request(opts);
    w.command({ type: 'exit', code: 0 }); await w.next('ready');
    assert.equal(logs(opts).length, 2);
    assert.equal(logs(opts)[1].CLAUDE_CONFIG_DIR, null);
    assert.equal(logs(opts)[1].argv.at(-1), MAX_MESSAGE);
    assert.deepEqual(state.readRequest('pane', opts).launch, { mode: 'max', reason: `preflight:${reason}` });
    const lines = fs.readFileSync(path.join(opts.home, '.local/state/orca-watchdog/watchdog.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(fs.realpathSync(opts.home)));
    assert.ok(lines[0].includes(reason));
    assert.equal(await finish(w), 0);
  });

  for (const [name, argv, env, disable] of [
    ['not enabled passes through unregistered', ['--model', 'opus', 'hello'], {}, true],
    ['no ORCA_TERMINAL_HANDLE passes through', ['hello'], { ORCA_TERMINAL_HANDLE: undefined }],
    ['unsupported selector passes through', ['--continue']],
    ['unknown flag runs unwrapped', ['--brand-new-flag', 'x', 'hi']],
    ['print mode is pass-through', ['-p', 'hi']],
    ['nested wrapper passes through', ['hi'], { CLAUDE_OVERFLOW_OWNER: 'outer:1' }],
  ]) test(name, async t => {
    const opts = fixture(t); if (disable) fs.unlinkSync(opts.paths.enabledFile);
    const w = launch(t, opts, argv, env); await w.next('ready');
    assert.deepEqual(logs(opts)[0].argv, argv);
    assert.deepEqual(state.readRegistrations(opts), []);
    assert.equal(await finish(w, 7), 7);
  });
  test('first launch adds session id and records generation, tty, pgid and config directory', async t => {
    const opts = fixture(t), w = launch(t, opts); await w.next('ready');
    const r = registration(opts), log = logs(opts)[0];
    assert.equal(r.generation, 1); assert.equal(r.wrapperPid, w.child.pid);
    assert.ok(r.wrapperStartedAt); assert.equal(r.configDir, path.join(opts.home, '.claude'));
    assert.deepEqual(log.argv, ['--model', 'opus', '--session-id', r.sessionId, 'hello']);
    assert.equal(r.pgid, 4242); assert.equal(r.tty, 'ttys099');
    assert.equal(log.CLAUDE_OVERFLOW_OWNER, `pane:${w.child.pid}`);
    await finish(w); assert.deepEqual(state.readRegistrations(opts), []);
  });
  test('second wrapper on a live handle passes through and releases only itself', async t => {
    const opts = fixture(t), a = launch(t, opts); await a.next('ready');
    const b = launch(t, opts, ['second']); await b.next('ready');
    assert.equal(state.readRegistrations(opts).length, 1);
    assert.deepEqual(logs(opts)[1].argv, ['second']);
    await finish(b);
    assert.match(b.stderr(), /claude-overflow: cannot claim terminal pane: another wrapper owns the handle or ownership is uncertain/);
    assert.equal(registration(opts).wrapperPid, a.child.pid); await finish(a);
  });
  test('console request relaunches with exact Console dir, preserved tmpdir, no advisor and launch reason ok', async t => {
    const opts = fixture(t), keep = ['--model', 'opus', '--advisor', 'claude-fable-5-1', '--plugin-dir', '/plugin'];
    const w = launch(t, opts, [...keep, 'hello'], { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: 'original' }); await w.next('ready');
    const s = registration(opts).sessionId;
    assert.deepEqual(logs(opts)[0].argv.slice(0, keep.length), keep);
    assert.equal(logs(opts)[0].CLAUDE_CODE_DISABLE_ADVISOR_TOOL, 'original');
    await consoleWindow(opts); await request(opts);
    w.command({ type: 'exit', code: 0 }); await w.next('ready');
    assert.deepEqual(logs(opts)[1].argv, ['--model', 'opus', '--plugin-dir', '/plugin', '--resume', s, CONSOLE_MESSAGE]);
    assert.equal(logs(opts)[1].CLAUDE_CONFIG_DIR, path.join(opts.home, '.claude-console'));
    assert.equal(logs(opts)[1].CLAUDE_CODE_TMPDIR, '/unchanged/tmp');
    assert.equal(logs(opts)[1].CLAUDE_CODE_DISABLE_ADVISOR_TOOL, '1');
    assert.equal(registration(opts).generation, 2);
    assert.equal(state.readRequest('pane', opts).state, 'consumed');
    assert.equal(state.readRequest('pane', opts).successorGeneration, 2);
    assert.deepEqual(state.readRequest('pane', opts).launch, { mode: 'console', reason: 'ok' });
    await finish(w);
  });
  test('relaunch resumes the pid file’s current session after poll even when removed on exit', async t => {
    const opts = fixture(t), w = launch(t, opts, ['--model', 'opus', '--session-id', 's1']); await w.next('ready');
    w.command({ type: 'session', sessionId: 's2' }); await w.next('session');
    await w.clock(start + 5000); assert.equal(registration(opts).sessionId, 's2');
    await consoleWindow(opts); await request(opts, { sessionId: 's2' });
    w.command({ type: 'exit', code: 0 }); await w.next('ready');
    assert.deepEqual(logs(opts)[1].argv.slice(-3), ['--resume', 's2', CONSOLE_MESSAGE]); await finish(w);
  });
  test('session registration retries after a failed write on the next poll', async t => {
    const opts = fixture(t), w = launch(t, opts, ['--model', 'opus', '--session-id', 's1']); await w.next('ready');
    w.command({ type: 'session', sessionId: 's2' }); await w.next('session');
    await w.clock(start + 5000, false, true);
    assert.equal(registration(opts).sessionId, 's1');
    await w.clock(start + 10000);
    assert.equal(registration(opts).sessionId, 's2');
    await finish(w);
  });
  for (const changed of [false, true]) test(`session mismatch at exit leaves request pending and logs both IDs${changed ? ' after final pid read' : ''}`, async t => {
    const opts = fixture(t), w = launch(t, opts, ['--model', 'opus', '--session-id', 's1']); await w.next('ready');
    await request(opts, { sessionId: changed ? 's1' : 's3' });
    if (changed) { w.command({ type: 'session', sessionId: 's2' }); await w.next('session'); }
    assert.notEqual(await finish(w, 0, false), 0);
    assert.equal(logs(opts).length, 1); assert.equal(state.readRequest('pane', opts).state, 'pending');
    const expected = changed ? ['s1', 's2'] : ['s3', 's1'];
    const activity = fs.readFileSync(path.join(opts.home, '.local/state/orca-watchdog/watchdog.log'), 'utf8');
    for (const id of expected) { assert.ok(w.stderr().includes(id)); assert.ok(activity.includes(id)); }
    assert.equal(activity.trim().split('\n').length, 1);
  });
  test('max request restores inherited env, advisor and Max message', async t => {
    const opts = fixture(t); await consoleWindow(opts);
    const w = launch(t, opts, ['--model', 'sonnet', '--advisor=fable', 'hello']); await w.next('ready');
    const s = registration(opts).sessionId; await state.updateMode(() => ({ until: null }), opts);
    await request(opts, { to: 'max' }); w.command({ type: 'exit' }); await w.next('ready');
    const log = logs(opts)[1]; assert.equal(log.CLAUDE_CONFIG_DIR, null);
    assert.equal(log.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, null);
    assert.deepEqual(log.argv, ['--model', 'sonnet', '--advisor=fable', '--resume', s, MAX_MESSAGE]);
    await finish(w);
  });
  test('max request superseded by a re-extended window records Console launch reason mode', async t => {
    const opts = fixture(t); await consoleWindow(opts);
    const w = launch(t, opts); await w.next('ready');
    await state.updateMode(() => ({ until: new Date(start - 1).toISOString() }), opts);
    await request(opts, { to: 'max' });
    await consoleWindow(opts); w.command({ type: 'exit' }); await w.next('ready');
    assert.equal(registration(opts).generation, 2); assert.equal(registration(opts).mode, 'console');
    assert.deepEqual(state.readRequest('pane', opts).launch, { mode: 'console', reason: 'mode' });
    assert.equal(logs(opts).length, 2); await finish(w);
  });
  for (const [name, edits] of [
    ['request outside the relaunch window is not consumed', { sentAt: new Date(start - 120001).toISOString() }],
    ['request for another generation is not consumed', { generation: 7 }],
    ['request for another wrapper is not consumed', { wrapperPid: 2147483647 }],
    ['request from the future is not consumed', { sentAt: new Date(start + 1).toISOString() }],
  ]) test(name, async t => {
    const opts = fixture(t), w = launch(t, opts); await w.next('ready'); const record = await request(opts, edits);
    const file = path.join(opts.paths.requestsDir, 'pane.json');
    fs.utimesSync(file, new Date(start), new Date(start));
    assert.equal(await finish(w, 3), 3); assert.deepEqual(state.readRequest('pane', opts), record); assert.equal(logs(opts).length, 1);
    assert.equal(fs.statSync(file).mtimeMs, start);
  });
  for (const reason of ['deadline', 'credit', 'disabled', 'revoked', 'timeout']) test(`admission wait re-checks ${reason} and records the launch outcome`, async t => {
    const opts = fixture(t), w = launch(t, opts); await w.next('ready'); await consoleWindow(opts);
    await state.takeAdmission(new Date(start), opts); await request(opts); w.command({ type: 'exit' }); await w.next('waiting');
    if (reason === 'deadline') await state.updateMode(() => ({ until: new Date(start + 1).toISOString() }), opts);
    if (reason === 'credit') await state.updateMode(() => ({ creditExhaustedUntil: '2026-12-01T00:00:00Z' }), opts);
    if (reason === 'disabled') fs.unlinkSync(opts.paths.enabledFile);
    if (reason === 'revoked') await state.updateRequest('pane', () => null, opts);
    await w.clock(start + (reason === 'timeout' ? 720000 : 5000)); await w.next('ready');
    assert.equal(registration(opts).mode, 'max');
    if (reason === 'revoked') assert.equal(state.readRequest('pane', opts), null);
    else assert.deepEqual(state.readRequest('pane', opts).launch, { mode: 'max', reason: reason === 'timeout' ? 'admission-timeout' : 'mode' });
    await w.clock(start + 780000); assert.equal(logs(opts).length, 2); await finish(w);
  });
  test('direct resumes and switch relaunches share admission spacing', async t => {
    const opts = fixture(t), switcher = launch(t, opts); await switcher.next('ready');
    await consoleWindow(opts);
    const direct = launch(t, opts, ['--model', 'opus', '--resume', 'direct-session'], { ORCA_TERMINAL_HANDLE: 'direct' });
    const first = await direct.next('ready'); assert.equal(first.at, start);
    await request(opts); switcher.command({ type: 'exit' }); await switcher.next('waiting');
    await switcher.clock(start + 59000); await switcher.next('waiting');
    assert.equal(logs(opts).length, 2);
    await switcher.clock(start + 60000); const second = await switcher.next('ready');
    assert.equal(second.at - first.at, 60000); await finish(switcher); await finish(direct);
  });
  test('direct resume loses Console mode while waiting without creating a request', async t => {
    const opts = fixture(t); await consoleWindow(opts); await state.takeAdmission(new Date(start), opts);
    const w = launch(t, opts, ['--model', 'opus', '--resume', 'direct']); await w.next('waiting');
    await state.updateMode(() => ({ until: null }), opts); await w.clock(start + 5000); await w.next('ready');
    assert.equal(registration(opts).mode, 'max'); assert.equal(state.readRequest('pane', opts), null);
    assert.deepEqual(logs(opts)[0].argv, ['--model', 'opus', '--resume', 'direct']); await finish(w);
  });
  test('successor registers and spawns only after the request lock is released', { timeout: 60_000 }, async t => {
    const opts = fixture(t), w = launch(t, opts); await w.next('ready'); await consoleWindow(opts);
    await state.takeAdmission(new Date(start), opts); await request(opts); w.command({ type: 'exit' }); await w.next('waiting');
    await state.withFlock(path.join(opts.paths.requestsDir, 'pane.lock'), async () => {
      await w.clock(start + 60000, true);
      // The real lockf process has started against the lock held here.
      await w.next('request-lock-attempt');
      assert.equal(registration(opts).generation, 1); assert.equal(logs(opts).length, 1);
      assert.equal(state.readRequest('pane', opts).launch, undefined);
    });
    await w.next('ready'); assert.equal(registration(opts).generation, 2);
    assert.equal(logs(opts).length, 2);
    assert.deepEqual(state.readRequest('pane', opts).launch, { mode: 'console', reason: 'ok' });
    await finish(w);
  });
  test('failed Console relaunch falls back to Max once and reports a second failure', async t => {
    const opts = fixture(t), w = launch(t, opts); await w.next('ready'); const s = registration(opts).sessionId;
    await consoleWindow(opts); await request(opts); w.command({ type: 'exit' }); await w.next('ready');
    w.command({ type: 'exit', code: 1 }); await w.next('ready');
    assert.equal(registration(opts).generation, 3); assert.equal(registration(opts).mode, 'max');
    assert.deepEqual(logs(opts)[2].argv.slice(-3), ['--resume', s, MAX_MESSAGE]);
    assert.equal(await finish(w, 2), 2); assert.equal(logs(opts).length, 3); assert.ok(w.stderr().includes(s));
    assert.equal(fs.readFileSync(path.join(opts.home, '.local/state/orca-watchdog/watchdog.log'), 'utf8').trim().split('\n').length, 1);
  });
  test('failed successor at SETTLE_MS - 1 falls back to generation 3 on Max', async t => {
    const opts = fixture(t), w = launch(t, opts); await w.next('ready');
    await consoleWindow(opts); await request(opts); w.command({ type: 'exit' }); await w.next('ready');
    const entry = registration(opts);
    assert.equal(entry.generation, 2);
    await w.clock(Date.parse(entry.launchedAt) + state.SETTLE_MS - 1);
    w.command({ type: 'exit', code: 1 });
    const result = await w.next(['finished', 'ready']);
    assert.equal(result.type, 'ready', 'an unsettled failure must launch generation 3');
    assert.equal(registration(opts).generation, 3); assert.equal(registration(opts).mode, 'max');
    assert.equal(logs(opts).length, 3);
    assert.deepEqual(logs(opts)[2].argv.slice(-3), ['--resume', entry.sessionId, MAX_MESSAGE]);
    await finish(w);
  });
  for (const offset of [0, 1]) test(`failed successor at SETTLE_MS + ${offset} exits without a fallback`, async t => {
    const opts = fixture(t), w = launch(t, opts); await w.next('ready');
    await consoleWindow(opts); await request(opts); w.command({ type: 'exit' }); await w.next('ready');
    const entry = registration(opts), file = path.join(opts.paths.requestsDir, 'pane.json');
    assert.equal(entry.generation, 2);
    const record = fs.readFileSync(file, 'utf8'), mtime = fs.statSync(file).mtimeMs;
    await w.clock(Date.parse(entry.launchedAt) + state.SETTLE_MS + offset);
    w.command({ type: 'exit', code: 1 });
    const result = await w.next(['finished', 'ready']);
    assert.equal(result.type, 'finished', 'a settled failure must not launch generation 3');
    assert.equal(result.code, 1); assert.deepEqual(await w.exited, [1, null]);
    assert.equal(logs(opts).length, 2); assert.deepEqual(state.readRegistrations(opts), []);
    assert.equal(fs.readFileSync(file, 'utf8'), record); assert.equal(fs.statSync(file).mtimeMs, mtime);
  });
  for (const model of ['fable', null]) test(`ineligible model ${model} never launches on Console`, async t => {
    const opts = fixture(t); await consoleWindow(opts);
    const w = launch(t, opts, model ? ['--model', model] : []); await w.next('ready');
    assert.equal(registration(opts).eligible, false); assert.equal(registration(opts).mode, 'max'); await finish(w);
  });
  for (const signal of ['SIGTERM', 'SIGHUP']) test(`${signal} leaves matching request pending and never relaunches`, async t => {
    const opts = fixture(t), w = launch(t, opts); await w.next('ready'); await consoleWindow(opts);
    const record = await request(opts); w.child.send({ type: 'signal', signal });
    const result = await w.next('finished'); await w.exited;
    assert.equal(result.code, signal === 'SIGTERM' ? 143 : 129);
    assert.deepEqual(state.readRequest('pane', opts), record); assert.equal(logs(opts).length, 1);
    assert.deepEqual(state.readRegistrations(opts), []);
  });
  test('positional prompt beginning with a dash keeps its option terminator', async t => {
    const opts = fixture(t), w = launch(t, opts, ['--model', 'opus', '--', '--advisor=fake prompt']);
    await w.next('ready');
    assert.deepEqual(logs(opts)[0].argv.slice(-2), ['--', '--advisor=fake prompt']);
    await finish(w);
  });
  test('symlinked mjs entry runs the wrapper with overflow disabled', t => {
    const opts = fixture(t), entry = path.join(opts.home, 'wrapper.mjs');
    fs.unlinkSync(opts.paths.enabledFile);
    fs.symlinkSync(fileURLToPath(new URL('./bin/claude-overflow.mjs', import.meta.url)), entry);
    const result = spawnSync(process.execPath, [entry, '--model', 'opus', 'hello'], { encoding: 'utf8', env: {
      HOME: opts.home, PATH: process.env.PATH, ORCA_TERMINAL_HANDLE: 'pane', CLAUDE_OVERFLOW_CLAUDE: fake,
      FAKE_CLAUDE_LOG: path.join(opts.home, 'launches.jsonl'), FAKE_CLAUDE_EXIT: '9',
    } });
    assert.equal(result.status, 9, result.stderr);
    assert.deepEqual(logs(opts)[0].argv, ['--model', 'opus', 'hello']);
    assert.deepEqual(state.readRegistrations(opts), []);
  });
  test('symlinked launcher skips its own PATH alias and fast path needs no wrapper Node', t => {
    const opts = fixture(t), first = path.join(opts.home, 'first'), second = path.join(opts.home, 'second');
    fs.mkdirSync(first); fs.mkdirSync(second);
    const shim = fileURLToPath(new URL('./bin/claude-overflow', import.meta.url));
    fs.symlinkSync(shim, path.join(first, 'claude'));
    fs.symlinkSync(fake, path.join(second, 'claude'));
    fs.symlinkSync(shim, path.join(opts.home, 'wrapper'));
    for (const handle of ['', 'pane']) {
      fs.rmSync(opts.paths.enabledFile, { force: true });
      if (!handle) fs.writeFileSync(opts.paths.enabledFile, '');
      const log = path.join(opts.home, 'shim.jsonl');
      const result = spawnSync(path.join(opts.home, 'wrapper'), ['--model', 'opus', 'hello'], { encoding: 'utf8', env: {
        HOME: opts.home, PATH: `${first}:${second}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        ORCA_TERMINAL_HANDLE: handle, ORCA_WATCHDOG_NODE: '/missing-node', FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_EXIT: '9',
      } });
      assert.equal(result.status, 9, result.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1)).argv, ['--model', 'opus', 'hello']);
    }
    assert.deepEqual(state.readRegistrations(opts), []);
  });
  function brewLayout(opts) {
    const prefix = path.join(opts.home, 'cellar'), root = path.join(prefix, 'libexec');
    const userbin = path.join(opts.home, 'userbin'), brewbin = path.join(opts.home, 'brewbin');
    const realbin = path.join(opts.home, 'realbin');
    for (const dir of [path.join(prefix, 'bin'), root, userbin, brewbin, realbin]) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(new URL('./version.mjs', import.meta.url), path.join(root, 'version.mjs'));
    for (const dir of ['bin', 'lib']) fs.cpSync(new URL(`./${dir}`, import.meta.url), path.join(root, dir), { recursive: true });
    const shim = path.join(root, 'bin/claude-overflow'), wrapper = path.join(prefix, 'bin/claude-overflow');
    // Mirror write_env_script, with a bounded recursion tripwire for the broken version.
    fs.writeFileSync(wrapper, `#!/bin/bash
printf 'entry\\n' >> "$HOME/env-entries"
export TEST_SHIM_DEPTH=$(( \${TEST_SHIM_DEPTH:-0} + 1 ))
[ "$TEST_SHIM_DEPTH" -le 3 ] || exit 99
ORCA_WATCHDOG_NODE='${process.execPath}' exec '${shim}' "$@"
`, { mode: 0o755 });
    fs.symlinkSync(wrapper, path.join(brewbin, 'claude-overflow'));
    fs.symlinkSync(path.join(brewbin, 'claude-overflow'), path.join(userbin, 'claude'));
    fs.symlinkSync(fake, path.join(realbin, 'claude'));
    return { root, shim, wrapper, alias: path.join(userbin, 'claude'), name: 'claude', env: {
      HOME: opts.home, PATH: `${userbin}:${realbin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      FAKE_CLAUDE_LOG: path.join(opts.home, 'launches.jsonl'), FAKE_CLAUDE_EXIT: '9',
    } };
  }
  for (const handle of ['', 'pane']) test(`Homebrew launcher skips the env-script PATH alias with handle ${handle || 'absent'}`, t => {
    const opts = fixture(t), layout = brewLayout(opts);
    const result = spawnSync(layout.wrapper, ['--model', 'opus', 'hello'], {
      encoding: 'utf8', env: { ...layout.env, ORCA_TERMINAL_HANDLE: handle },
    });
    assert.equal(result.status, 9, result.stderr);
    assert.equal(logs(opts).length, 1);
    assert.equal(fs.readFileSync(path.join(opts.home, 'env-entries'), 'utf8'), 'entry\n');
  });
  test('shell launcher refuses an explicit Homebrew env-script alias', t => {
    const opts = fixture(t), layout = brewLayout(opts);
    const result = spawnSync(layout.wrapper, ['hello'], {
      encoding: 'utf8', env: { ...layout.env, CLAUDE_OVERFLOW_CLAUDE: layout.alias },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refusing recursive Claude executable/);
    assert.equal(fs.readFileSync(path.join(opts.home, 'env-entries'), 'utf8'), 'entry\n');
    assert.equal(fs.existsSync(layout.env.FAKE_CLAUDE_LOG), false);
  });
  for (const target of ['shim', 'alias', 'name', 'mjs']) test(`Node wrapper refuses an explicit ${target} that leads back to the shim`, t => {
    const opts = fixture(t), layout = brewLayout(opts);
    layout.mjs = path.join(layout.root, 'bin/claude-overflow.mjs');
    const script = `import { runWrapper } from ${JSON.stringify(path.join(layout.root, 'bin/claude-overflow.mjs'))};
      process.exitCode = await runWrapper({ argv: ['hello'], deps: {
        spawn: () => { throw new Error('unexpected Claude spawn'); },
      } });`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...layout.env, CLAUDE_OVERFLOW_CLAUDE: layout[target] },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refusing recursive Claude executable/);
    assert.equal(fs.existsSync(path.join(opts.home, 'env-entries')), false);
    assert.equal(fs.existsSync(layout.env.FAKE_CLAUDE_LOG), false);
  });
  test('flock timeout fails closed to an unregistered pass-through', async t => {
    const opts = fixture(t);
    await state.withFlock(path.join(opts.paths.registrationsDir, 'pane.lock'), async () => {
      const w = launch(t, opts, undefined, { WRAPPER_FLOCK_TIMEOUT: '0' });
      assert.equal((await w.next('lock-attempt')).timeout, 0);
      await w.next('ready');
      assert.deepEqual(state.readRegistrations(opts), []); assert.deepEqual(logs(opts)[0].argv, ['--model', 'opus', 'hello']); await finish(w);
    }, { timeoutS: 0 });
  });
  test('injected flock timeout covers claim, request consumption, successor and admission locks', async t => {
    const opts = fixture(t), w = launch(t, opts, undefined, { WRAPPER_FLOCK_TIMEOUT: '0' });
    await w.next('ready'); assert.equal(registration(opts).generation, 1);
    await consoleWindow(opts); await request(opts); w.command({ type: 'exit' });
    const result = await w.next(['ready', 'finished']);
    assert.equal(result.type, 'ready'); assert.equal(registration(opts).generation, 2);
    for (let i = 0; i < 4; i++) assert.equal((await w.next('lock-attempt')).timeout, 0);
    assert.deepEqual(state.readRequest('pane', opts).launch, { mode: 'console', reason: 'ok' });
    await finish(w);
    assert.equal((await w.next('lock-attempt')).timeout, 0);
  });
  test('failed claim reports the reason before running Claude once unregistered', async t => {
    const opts = fixture(t);
    await state.withFlock(path.join(opts.paths.registrationsDir, 'pane.lock'), async () => {
      const w = launch(t, opts, undefined, { WRAPPER_FLOCK_TIMEOUT: '0' }); await w.next('ready');
      assert.match(w.stderr(), /claude-overflow: cannot claim terminal pane: could not acquire overflow lock:/);
      assert.equal(w.stderr().trim().split('\n').length, 1);
      const activity = fs.readFileSync(path.join(opts.home, '.local/state/orca-watchdog/watchdog.log'), 'utf8');
      assert.match(activity, /cannot claim terminal pane: could not acquire overflow lock:/);
      assert.equal(activity.trim().split('\n').length, 1);
      assert.deepEqual(state.readRegistrations(opts), []); assert.equal(logs(opts).length, 1);
      assert.deepEqual(logs(opts)[0].argv, ['--model', 'opus', 'hello']); assert.equal(await finish(w, 7), 7);
    }, { timeoutS: 0 });
  });
}

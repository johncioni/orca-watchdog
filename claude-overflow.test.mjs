import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import * as state from './lib/overflow-state.mjs';
import { runWrapper, CONSOLE_MESSAGE, MAX_MESSAGE } from './bin/claude-overflow.mjs';

const self = fileURLToPath(import.meta.url);
const fake = fileURLToPath(new URL('./e2e/fake-claude.mjs', import.meta.url));
const start = Date.parse('2026-11-08T12:00:00Z');
if (process.env.OVERFLOW_WRAPPER_WORKER) {
  let now = start, child, interval, sleeping;
  process.on('message', async m => {
    if (m.type === 'child') child.send(m.command);
    if (m.type === 'clock') {
      now = m.now;
      if (interval) await interval();
      const wake = sleeping; sleeping = null; wake?.();
      process.send({ type: 'clocked', id: m.id });
    }
    if (m.type === 'signal') process.kill(process.pid, m.signal);
  });
  const code = await runWrapper({ argv: JSON.parse(process.env.WRAPPER_ARGV), env: process.env, home: process.env.HOME, deps: {
    now: () => new Date(now),
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
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const paths = state.overflowPaths(home);
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.enabledFile, '', { mode: 0o600 });
    return { home, paths };
  }
  function mailbox(child) {
    const messages = [], waiters = [];
    child.on('message', m => {
      const i = waiters.findIndex(w => w.type === m.type);
      if (i < 0) messages.push(m); else waiters.splice(i, 1)[0].resolve(m);
    });
    return type => {
      const i = messages.findIndex(m => m.type === type);
      if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
      return new Promise(resolve => waiters.push({ type, resolve }));
    };
  }
  function launch(t, opts, argv = ['--model', 'opus', 'hello'], overrides = {}) {
    const env = { HOME: opts.home, PATH: process.env.PATH, ORCA_TERMINAL_HANDLE: 'pane', CLAUDE_OVERFLOW_CLAUDE: fake,
      FAKE_CLAUDE_LOG: path.join(opts.home, 'launches.jsonl'), CLAUDE_CODE_TMPDIR: '/unchanged/tmp',
      OVERFLOW_WRAPPER_WORKER: '1', WRAPPER_ARGV: JSON.stringify(argv), ...overrides };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const child = fork(self, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
    const next = mailbox(child), exited = once(child, 'exit');
    let stderr = ''; child.stderr.on('data', b => { stderr += b; });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } });
    return { child, next, exited, stderr: () => stderr,
      command: command => child.send({ type: 'child', command }),
      clock: async now => { child.send({ type: 'clock', now }); await next('clocked'); } };
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
    await finish(b); assert.equal(registration(opts).wrapperPid, a.child.pid); await finish(a);
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
  test('successor registers and spawns only after the request lock is released', async t => {
    const opts = fixture(t), w = launch(t, opts); await w.next('ready'); await consoleWindow(opts);
    await state.takeAdmission(new Date(start), opts); await request(opts); w.command({ type: 'exit' }); await w.next('waiting');
    await state.withFlock(path.join(opts.paths.requestsDir, 'pane.lock'), async () => {
      await w.clock(start + 60000);
      assert.equal(registration(opts).generation, 1); assert.equal(logs(opts).length, 1);
      assert.equal(state.readRequest('pane', opts).launch, undefined);
    });
    await w.next('ready'); assert.equal(registration(opts).generation, 2); await finish(w);
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
  test('flock timeout fails closed to an unregistered pass-through', async t => {
    const opts = fixture(t);
    // The timeout is a real lock boundary; no wall-clock sleep is used.
    await state.withFlock(path.join(opts.paths.registrationsDir, 'pane.lock'), async () => {
      const w = launch(t, opts); await w.next('ready');
      assert.deepEqual(state.readRegistrations(opts), []); assert.deepEqual(logs(opts)[0].argv, ['--model', 'opus', 'hello']); await finish(w);
    }, { timeoutS: 0 });
  });
}

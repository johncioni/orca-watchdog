import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import * as state from './lib/overflow-state.mjs';

const self = fileURLToPath(import.meta.url);
if (process.env.OVERFLOW_STATE_WORKER) {
  process.send({ type: 'ready' });
  process.once('message', async ({ action, home, lock, now }) => {
    try {
      if (action === 'hold') await state.withFlock(lock, async () => {
        process.send({ type: 'held' });
        await once(process, 'message');
      });
      if (action === 'claim') {
        const value = await state.claimHandle({ handle: 'pane', wrapperPid: process.pid, generation: 1 }, { home });
        process.send({ type: 'result', value });
        await once(process, 'message');
      }
      if (action === 'admit') process.send({ type: 'result', value: await state.takeAdmission(new Date(now), { home }) });
      process.send({ type: 'done' });
    } catch (error) { process.send({ type: 'error', message: error.stack }); }
    process.disconnect();
  });
} else {
  function fixture(t) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'overflow-state-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    return { home };
  }
  async function worker(t) {
    const child = fork(self, [], { env: { ...process.env, OVERFLOW_STATE_WORKER: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    await once(child, 'message');
    return child;
  }
  test('launchMode and switchBackDue distinguish deadlines from exhausted credit', () => {
    const now = new Date('2026-11-08T12:00:00Z');
    for (const [until, creditExhaustedUntil, launch, back] of [
      [null, null, 'max', false], ['2026-11-08T13:00:00Z', null, 'console', false],
      ['2026-11-08T12:00:00Z', null, 'max', true], ['2026-11-08T11:00:00Z', null, 'max', true],
      ['2026-11-08T13:00:00Z', '2026-12-01T00:00:00Z', 'max', false],
      ['2026-11-08T13:00:00Z', '2026-11-08T11:00:00Z', 'console', false],
    ]) {
      assert.equal(state.launchMode({ until, creditExhaustedUntil }, now), launch);
      assert.equal(state.switchBackDue({ until, creditExhaustedUntil }, now), back);
    }
  });
  test('mode evidence round trip survives unrelated updates and old files default to empty evidence', async t => {
    const opts = fixture(t);
    assert.deepEqual(state.readMode(opts), { until: null, creditExhaustedUntil: null, lastError: null, noSwitch: [], evidence: {}, switchBackRetry: {} });
    const evidence = { pane: { bannerText: 'limit', resetAt: '2026-11-09T00:00:00Z', acceptedAt: '2026-11-08T12:00:00Z', episode: 'episode' } };
    await state.updateMode(() => ({ until: '2026-11-09T00:00:00Z', evidence }), opts);
    await state.updateMode(() => ({ creditExhaustedUntil: null }), opts);
    assert.deepEqual(state.readMode(opts).evidence, evidence);
    assert.equal(state.readMode(opts).until, '2026-11-09T00:00:00Z');
    fs.writeFileSync(state.overflowPaths(opts.home).modeFile, JSON.stringify({ until: null, creditExhaustedUntil: null, lastError: null, noSwitch: [] }));
    assert.deepEqual(state.readMode(opts).evidence, {});
    fs.writeFileSync(state.overflowPaths(opts.home).modeFile, '{broken');
    assert.equal(state.readMode(opts).until, null);
  });
  test('A15: optional retry map round-trips and malformed values preserve the other mode fields', async t => {
    const tmp = spawnSync('mktemp', ['-d', '/tmp/ova4.XXXXXX'], { encoding: 'utf8' });
    assert.equal(tmp.status, 0); const opts = { home: tmp.stdout.trim() };
    t.after(() => fs.rmSync(opts.home, { recursive: true, force: true }));
    const entry = { failures: 2, nextAt: '2026-11-09T12:30:00Z', stuckAt: null };
    const switchBackRetry = { 'pane:123': entry };
    const before = await state.updateMode(() => ({ until: '2026-11-09T13:00:00Z', lastError: 'keep', noSwitch: ['other:1'],
      evidence: { pane: { resetAt: '2026-11-09T13:00:00Z' } }, switchBackRetry }), opts);
    await state.updateMode(() => ({ creditExhaustedUntil: null }), opts);
    assert.deepEqual(state.readMode(opts), before);
    const file = state.overflowPaths(opts.home).modeFile;
    for (const malformed of [undefined, null, [], 'bad', 1, { 'pane:123': null },
      { 'pane:123': { ...entry, failures: -1 } }, { 'pane:123': { ...entry, failures: 1.5 } },
      { 'pane:123': { ...entry, nextAt: 'bad' } }, { 'pane:123': { ...entry, nextAt: null } },
      { 'pane:123': { ...entry, stuckAt: 'bad' } }]) {
      fs.writeFileSync(file, JSON.stringify({ ...before, switchBackRetry: malformed }));
      assert.deepEqual(state.readMode(opts), { ...before, switchBackRetry: {} });
    }
    await state.updateMode(() => ({ switchBackRetry: { 'pane:123': { ...entry, failures: 4, stuckAt: entry.nextAt } } }), opts);
    assert.equal(state.readMode(opts).switchBackRetry['pane:123'].failures, 4);
  });
  test('withFlock excludes a second process until release and releases on holder death', async t => {
    const { home } = fixture(t), lock = path.join(home, 'lock');
    const a = await worker(t);
    a.send({ action: 'hold', lock });
    assert.equal((await once(a, 'message'))[0].type, 'held');
    await assert.rejects(state.withFlock(lock, () => assert.fail('entered held lock'), { timeoutS: 0 }), state.FlockTimeout);
    const b = await worker(t);
    const held = once(b, 'message');
    b.send({ action: 'hold', lock });
    a.send('release');
    assert.equal((await held)[0].type, 'held');
    const exited = once(b, 'exit');
    b.kill('SIGKILL');
    await exited;
    assert.equal(await state.withFlock(lock, () => 42, { timeoutS: 0 }), 42);
  });
  test('two wrappers race for a dead owner’s handle and loser release preserves winner', async t => {
    const opts = fixture(t), dir = path.join(state.overflowPaths(opts.home).registrationsDir, 'pane');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2147483647.json'), JSON.stringify({ handle: 'pane', wrapperPid: 2147483647 }));
    const a = await worker(t), b = await worker(t);
    const results = [once(a, 'message'), once(b, 'message')];
    a.send({ action: 'claim', ...opts }); b.send({ action: 'claim', ...opts });
    const values = (await Promise.all(results)).map(([m]) => m.value);
    assert.deepEqual(values.slice().sort(), [false, true]);
    const winner = values[0] ? a : b, loser = values[0] ? b : a;
    await state.releaseHandle('pane', loser.pid, opts);
    assert.deepEqual(state.readRegistrations(opts).map(r => r.wrapperPid), [winner.pid]);
    assert.equal(fs.existsSync(path.join(dir, '2147483647.json')), false);
    a.send('release'); b.send('release');
  });
  test('takeAdmission admits exactly one racing process and spaces later resumes', async t => {
    const opts = fixture(t), now = '2026-11-08T12:00:00Z';
    const a = await worker(t), b = await worker(t);
    const results = [once(a, 'message'), once(b, 'message')];
    a.send({ action: 'admit', ...opts, now }); b.send({ action: 'admit', ...opts, now });
    assert.deepEqual((await Promise.all(results)).map(([m]) => m.value).sort(), [false, true]);
    assert.equal(await state.takeAdmission(new Date('2026-11-08T12:00:59Z'), opts), false);
    assert.equal(await state.takeAdmission(new Date('2026-11-08T12:01:00Z'), opts), true);
  });
  test('state files and directories are private and unsafe handles throw', async t => {
    const opts = fixture(t), paths = state.overflowPaths(opts.home);
    await state.updateMode(m => m, opts);
    await state.updateRequest('pane', () => ({ state: 'pending' }), opts);
    await state.claimHandle({ handle: 'pane', wrapperPid: process.pid }, opts);
    await state.takeAdmission(new Date(), opts);
    for (const file of [paths.modeFile, paths.modeFile + '.lock', paths.admissionFile, path.join(paths.requestsDir, 'pane.json'), path.join(paths.registrationsDir, 'pane', `${process.pid}.json`)])
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    for (const dir of [paths.dir, paths.requestsDir, paths.registrationsDir, path.join(paths.registrationsDir, 'pane')])
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(paths.consoleDir, path.join(opts.home, '.claude-console'));
    assert.throws(() => state.readRequest('../x', opts));
    await assert.rejects(state.claimHandle({ handle: '../x', wrapperPid: process.pid }, opts));
    assert.throws(() => state.releaseHandle('../x', process.pid, opts));
    await state.updateRequest('pane', () => null, opts);
    assert.equal(state.readRequest('pane', opts), null);
  });
}

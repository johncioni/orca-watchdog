import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, fork } from 'node:child_process';
import { tick, orca, newEvent, detectBanner, parseResetTime, saveState, writeCapture, SCHEDULE, RESUME_TEXT, OUTAGE_RESUME_TEXT } from './watchdog.mjs';
import * as store from './lib/overflow-state.mjs';
// Dynamic import keeps the missing controller visible as individual RED cases.
const { planOverflow } = await import('./lib/overflow.mjs').catch(() => ({ planOverflow() { throw new Error('overflow controller missing'); } }));
const NOW = new Date('2026-11-08T10:00:00Z');
const iso = n => new Date(+NOW + n * 60_000).toISOString();
const H = 'term_overflow';
const box = ['────────────', '❯', '────────────'];
const limit = hour => [`Claude usage limit reached. Your limit will reset at ${hour}:00 (Etc/UTC).`, ...box];
const outage = ['⎿ API Error: 529 overloaded_error', ...box];
// Claude 2.1.319 bundle wording; unverified live (spike item 6).
const console429 = ['⎿ API Error: Request rejected (429) · this may be a temporary capacity issue.', ...box];
const billing = ['⎿ Credit balance too low · Add funds: https://platform.claude.com/settings/billing', ...box];
function observed(lines, now = NOW) {
  const b = detectBanner(lines, 'claude', now);
  return { ...b, platform: 'claude', resetAt: parseResetTime(b.bannerText, now)?.toISOString() ?? null, parsedReset: true };
}
function registration(extra = {}) {
  return { handle: H, wrapperPid: 1001, wrapperStartedAt: iso(-60), claudePid: 1002,
    sessionId: 's1', configDir: '/fake/config', eligible: true, model: 'opus', launchedAt: iso(-60),
    cwd: '/fake/project', generation: 1, mode: 'max', tty: 'ttys099', pgid: 1001, ...extra };
}
function event(extra = {}) {
  return { ...newEvent({ handle: H, platform: 'claude', banner: detectBanner(limit(11), 'claude', NOW) }, new Date(iso(-30))),
    resetAnchorAt: iso(-30), ...extra };
}
function request(extra = {}) {
  return { state: 'pending', handle: H, wrapperPid: 1001, generation: 1, sessionId: 's1', to: 'console',
    attempts: 1, sentAt: iso(0), createdAt: iso(0), eventSnapshot: { [H]: event() }, ...extra };
}
function input(extra = {}) {
  const r = registration(), ev = event();
  return { enabled: true, mode: { until: null, creditExhaustedUntil: null, lastError: null, noSwitch: [], evidence: {} },
    registrations: [r], requests: new Map(), sessions: new Map([[`${r.configDir}:${r.claudePid}`, { sessionId: 's1', status: 'idle' }]]),
    facts: { alive: new Set([1001, 1002]), foreground: new Set([H]) },
    observations: new Map([[H, { read: true, banner: observed(limit(11)), billing: false }]]),
    events: { [H]: ev }, listedHandles: [H], now: NOW, ...extra };
}
function planWithRequest(q, extra = {}) {
  const i = input(extra); i.mode.until ??= iso(300); i.requests.set(H, q); return planOverflow(i);
}

test('disabled overflow returns an empty plan without changing mode', () => {
  const i = input({ enabled: false }); const p = planOverflow(i);
  for (const k of ['switches', 'resends', 'confirms', 'fails', 'cancels', 'supersedes']) assert.deepEqual(p[k], []);
  assert.equal(p.suppress.size, 0); assert.equal(p.consoleHandles.size, 0); assert.deepEqual(p.mode, i.mode);
});
test('fresh parsed Claude limit opens the window and selects the oldest one per tick', () => {
  const i = input(); const second = registration({ handle: 'term_second', wrapperPid: 2001, claudePid: 2002 });
  i.registrations.push(second); i.listedHandles.push(second.handle); i.facts.foreground.add(second.handle);
  i.facts.alive.add(2001).add(2002); i.sessions.set(`${second.configDir}:2002`, { sessionId: 's1', status: 'idle' });
  i.events[second.handle] = event({ handle: second.handle, detectedAt: iso(-45) });
  i.observations.set(second.handle, i.observations.get(H));
  const p = planOverflow(i); assert.equal(p.mode.until, iso(62)); assert.deepEqual(p.switches.map(s => s.handle), [second.handle]);
  assert.equal(p.suppress.get(second.handle), 'all'); assert.deepEqual(i.mode.evidence, {});
});
for (const [name, change] of [
  ['dead wrapper', i => i.facts.alive.delete(1001)], ['dead Claude', i => i.facts.alive.delete(1002)],
  ['duplicate registration', i => i.registrations.push(registration({ wrapperPid: 2001 }))],
  ['duplicate listing', i => i.listedHandles.push(H)], ['background', i => i.facts.foreground.clear()],
  ['ineligible model', i => i.registrations[0].eligible = false],
  ['unread handle', i => i.observations.set(H, { read: false })],
  ['fallback reset', i => i.observations.get(H).banner.parsedReset = false],
  ['non-Claude limit', i => i.observations.get(H).banner.platform = 'codex'],
]) test(`${name} authorizes no window or switch`, () => {
  const i = input(); change(i); const p = planOverflow(i); assert.equal(p.mode.until, null); assert.deepEqual(p.switches, []);
});
test('unread handle beside a read one cannot extend until', () => {
  const i = input(); i.registrations.push(registration({ handle: 'term_unread' })); i.listedHandles.push('term_unread');
  i.facts.foreground.add('term_unread'); i.events.term_unread = event({ handle: 'term_unread', resetAt: iso(900) });
  i.observations.set('term_unread', { read: false }); const p = planOverflow(i);
  assert.equal(p.mode.until, iso(62)); assert.deepEqual(p.switches.map(s => s.handle), [H]);
});
test('changed later reset extends until; unchanged stored text retains its original reset', () => {
  const i = input(); i.now = new Date(iso(240)); i.observations.get(H).banner.resetAt = iso(1500);
  assert.equal(planOverflow(i).mode.until, iso(62));
  i.observations.get(H).banner = observed(limit(15), i.now);
  const p = planOverflow(i); assert.equal(p.mode.until, iso(302));
  assert.deepEqual(p.mode.evidence[H], { bannerText: i.observations.get(H).banner.bannerText, resetAt: iso(300), acceptedAt: iso(240), episode: i.events[H].detectedAt });
});
test('later limit extends until on Console and pending handles; wall clock moving back never shortens it', () => {
  for (const mode of ['max', 'console']) {
    const i = input(); i.mode.until = iso(600); i.registrations[0].mode = mode;
    i.requests.set(H, request()); assert.equal(planOverflow(i).mode.until, iso(600));
    i.now = new Date(iso(-60)); assert.equal(planOverflow(i).mode.until, iso(600));
    i.observations.get(H).banner = observed(limit(23));
    assert.equal(planOverflow(i).mode.until, iso(782));
  }
});
test('evidence stays live through a request snapshot and is pruned with the event or registration', () => {
  const i = input(); i.mode.evidence[H] = { bannerText: 'changed', resetAt: iso(300), acceptedAt: iso(0), episode: i.events[H].detectedAt };
  i.requests.set(H, request()); i.events = {}; i.observations.set(H, { read: false });
  assert.ok(planOverflow(i).mode.evidence[H]); i.requests.clear(); assert.equal(planOverflow(i).mode.evidence[H], undefined);
  i.requests.set(H, request()); i.registrations = []; assert.equal(planOverflow(i).mode.evidence[H], undefined);
});
test('noSwitch blocks either direction and is pruned only when its registration file is gone', () => {
  for (const mode of ['max', 'console']) {
    const i = input(); i.registrations[0].mode = mode; if (mode === 'console') i.observations.set(H, { read: true, banner: null }); i.mode.until = iso(-1); i.mode.noSwitch = [`${H}:1001`, `${H}:99`];
    assert.deepEqual(planOverflow(i).switches, []); assert.deepEqual(planOverflow(i).mode.noSwitch, [`${H}:1001`]);
    i.registrations[0].wrapperPid = 2001; i.facts.alive.add(2001); assert.equal(planOverflow(i).switches.length, 1);
  }
});
test('billing-only read marks credit through the next UTC month without a send', () => {
  const i = input(); i.registrations[0].mode = 'console'; i.mode.until = iso(300);
  i.observations.set(H, { read: true, banner: null, billing: true }); const p = planOverflow(i);
  assert.equal(p.mode.creditExhaustedUntil, '2026-12-01T00:00:00.000Z'); assert.deepEqual(p.switches, []);
  assert.equal(p.suppress.get(H), 'limit-credits');
});
test('credit exhaustion waits for the deadline; passing mid-turn waits for idle', () => {
  const i = input(); i.registrations[0].mode = 'console'; i.mode.until = iso(300); i.mode.creditExhaustedUntil = iso(900);
  i.observations.set(H, { read: true, banner: null }); assert.deepEqual(planOverflow(i).switches, []);
  i.now = new Date(iso(301)); const session = i.sessions.values().next().value;
  for (const status of ['busy', 'waiting', undefined]) { session.status = status; assert.deepEqual(planOverflow(i).switches, []); }
  session.status = 'idle'; assert.equal(planOverflow(i).switches[0].to, 'max');
});
for (const [name, q, extra, field] of [
  ['pending within relaunch window holds', request(), {}, null],
  ['pending expired resends', request({ sentAt: iso(-3) }), {}, 'resends'],
  ['pending exhausted cancels', request({ sentAt: iso(-3), attempts: 3 }), {}, 'cancels'],
  ['pending Console deadline passed cancels', request(), { mode: { ...input().mode, until: iso(-1) }, observations: new Map() }, 'cancels'],
  ['pending Console credit exhausted cancels', request(), { mode: { ...input().mode, until: iso(300), creditExhaustedUntil: iso(900) } }, 'cancels'],
  ['credit mark does not cancel a Max request', request({ to: 'max', sentAt: iso(-3) }), { mode: { ...input().mode, until: iso(-1), creditExhaustedUntil: iso(900) } }, 'resends'],
  ['consumed admission wait holds', request({ state: 'consumed', consumedAt: iso(-14), successorGeneration: 2 }), {}, null],
  ['consumed without successor fails at bound', request({ state: 'consumed', consumedAt: iso(-15), successorGeneration: 2 }), {}, 'fails'],
  ['dead owner cancels', request(), { facts: { alive: new Set([1002]), foreground: new Set([H]) } }, 'cancels'],
  ['replacement owner cancels', request(), { registrations: [registration({ wrapperPid: 2001 })] }, 'cancels'],
  ['G+2 fallback fails', request({ state: 'consumed' }), { registrations: [registration({ generation: 3 })] }, 'fails'],
]) test(name, () => {
  const p = planWithRequest(q, extra); assert.equal(p.suppress.get(H), 'all');
  for (const f of ['resends', 'confirms', 'fails', 'cancels', 'supersedes']) assert.equal(p[f].length, f === field ? 1 : 0, f);
});
for (const [name, launch, age, session, field] of [
  ['successor younger than settle holds', { mode: 'console', reason: 'ok' }, 0.5, 's1', null],
  ['settled successor confirms', { mode: 'console', reason: 'ok' }, 1, 's1', 'confirms'],
  ['successor missing session holds before bound', { mode: 'console', reason: 'ok' }, 9, 'other', null],
  ['successor missing session fails at bound', { mode: 'console', reason: 'ok' }, 10, 'other', 'fails'],
  ['deadline fallback supersedes', { mode: 'max', reason: 'mode' }, 1, 's1', 'supersedes'],
  ['admission timeout fallback fails', { mode: 'max', reason: 'admission-timeout' }, 1, 's1', 'fails'],
  ['unseeded fallback fails', { mode: 'max', reason: 'preflight:unseeded' }, 1, 's1', 'fails'],
  ['missing launch fails', undefined, 1, 's1', 'fails'],
]) test(name, () => {
  const r = registration({ generation: 2, mode: launch?.mode ?? 'console', launchedAt: iso(-age) });
  const p = planWithRequest(request({ state: 'consumed', consumedAt: iso(-12), successorGeneration: 2, launch }), {
    registrations: [r], sessions: new Map([[`${r.configDir}:${r.claudePid}`, { sessionId: session, status: 'idle' }]]) });
  for (const f of ['resends', 'confirms', 'fails', 'cancels', 'supersedes']) assert.equal(p[f].length, f === field ? 1 : 0, f);
});

function tempHome(t) {
  const result = spawnSync('mktemp', ['-d', '/tmp/ovt4.XXXXXX'], { encoding: 'utf8' });
  assert.equal(result.status, 0); const home = result.stdout.trim();
  t.after(() => fs.rmSync(home, { recursive: true, force: true })); return home;
}
async function setup(t, options = {}) {
  const home = tempHome(t), opts = { home }, paths = store.overflowPaths(home), stateDir = path.dirname(paths.dir);
  fs.mkdirSync(paths.dir, { recursive: true }); fs.writeFileSync(paths.enabledFile, '');
  await store.updateMode(() => ({ until: null }), opts);
  const r = registration({ configDir: path.join(home, '.claude'), ...options.registration });
  store.updateRegistration(r, opts);
  const session = (value = { sessionId: r.sessionId, status: 'idle' }) => {
    fs.mkdirSync(path.join(r.configDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(r.configDir, 'sessions', `${r.claudePid}.json`), JSON.stringify(value));
  };
  session(); saveState({ [H]: event() }, stateDir);
  const h = { home, opts, paths, stateDir, r, session, now: NOW, tail: limit(11), draft: '', calls: [], captures: [], logs: [],
    disabled: false, alive: new Set([1001, 1002]), ps: '1001 1001 ttys099', readFailure: false,
    terminals: [{ handle: H, connected: true, writable: true, agentIdentity: 'claude' }],
    events: () => JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'))).events };
  h.run = (dryRun = false, extra = {}) => tick({ dryRun }, {
    now: () => h.now, env: {}, loadState: h.events, saveState: events => saveState(events, stateDir),
    saveCapture: c => { h.captures.push(c); writeCapture(stateDir, c); },
    log: (level, message) => h.logs.push([level, message]), reapChoices: () => {}, isDisabled: () => h.disabled,
    fetchImpl: async url => ({ ok: true, status: 200, text: async () => 'Success', json: async () => ({ status: { indicator: h.indicator ?? 'none' } }) }),
    orca: async (args, execImpl, timeoutMs) => {
      h.onCall?.(args, execImpl, timeoutMs);
      h.calls.push(args); const verb = args[1], handle = args[args.indexOf('--terminal') + 1];
      if (verb === 'list') return { terminals: h.terminals };
      if (verb === 'read') { if (h.readFailure) throw new Error('read failed'); return { terminal: { tail: h.tail, draft: h.draft, raw: 'unaltered', handle } }; }
      if (verb === 'wait') { h.onWait?.(); return {}; }
      if (verb === 'send') { h.onSend?.(args); if (h.sendFailure) throw h.sendFailure instanceof Error ? h.sendFailure : new Error('send failed'); return {}; }
      throw new Error('unexpected fake orca call');
    },
    overflow: { home, alive: pid => h.alive.has(pid), execFile: async (file, args, options) => {
      assert.equal(file, '/bin/ps'); assert.deepEqual(args, ['-o', 'pgid=,tpgid=,tty=', '-p', String(r.claudePid)]);
      assert.ok(options.timeout > 0); if (h.ps instanceof Error) throw h.ps; return { stdout: h.ps };
    }, ...extra.overflow }, ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'overflow')),
  });
  h.sends = () => h.calls.filter(a => a[1] === 'send');
  return h;
}
function tree(dir) {
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
    .map(e => { const file = path.join(e.parentPath ?? e.path, e.name); return [path.relative(dir, file), fs.readFileSync(file).toString('base64')]; }).sort());
}
test('enabled tick persists pending before exactly one exit and keeps the event and raw capture', async t => {
  const h = await setup(t); const original = h.events()[H];
  h.onSend = () => { assert.equal(store.readRequest(H, h.opts).attempts, 1); assert.deepEqual(h.events()[H], original); };
  await h.run(); assert.deepEqual(h.sends(), [['terminal', 'send', '--terminal', H, '--text', '/exit', '--enter']]);
  assert.deepEqual(store.readRequest(H, h.opts).eventSnapshot, { [H]: original });
  const c = h.captures.find(c => c.reason === 'send'); assert.deepEqual(c.overflow, { to: 'console', attempt: 1 });
  assert.deepEqual(c.read, { tail: h.tail, draft: '', raw: 'unaltered', handle: H });
});
for (const [name, configure] of [
  ['mismatched tpgid', h => h.ps = '1001 99 ttys099'], ['mismatched tty', h => h.ps = '1001 1001 ttys088'],
  ['mismatched pgid', h => h.ps = '77 77 ttys099'], ['ps failure', h => h.ps = new Error('ps unavailable')],
  ['draft field', h => h.draft = 'unfinished'], ['draft tail', h => h.tail = [...limit(11).slice(0, -2), '❯ unfinished', '────────────']],
  ['busy pid file', h => h.session({ sessionId: 's1', status: 'busy' })],
  ['foreground changes during wait', h => h.onWait = () => h.ps = '1001 99 ttys099'],
  ['pause mid-tick', h => h.onWait = () => h.disabled = true],
  ['shell prompt on reread', h => h.onWait = () => h.tail = ['john@host ~ %']],
  ['banner changes on reread', h => h.onWait = () => h.tail = outage],
]) test(`${name} prevents a request and exit`, async t => {
  const h = await setup(t); configure(h); await h.run(); assert.equal(store.readRequest(H, h.opts), null); assert.deepEqual(h.sends(), []);
  assert.equal(fs.existsSync(path.join(h.paths.requestsDir, `${H}.lock`)), false, 'guard must precede request lock creation');
});
test('session disagreement holds, then agrees on the next tick', async t => {
  const h = await setup(t); h.session({ sessionId: 's2', status: 'idle' }); await h.run();
  assert.equal(store.readRequest(H, h.opts), null); assert.deepEqual(h.sends(), []);
  h.r.sessionId = 's2'; store.updateRegistration(h.r, h.opts); await h.run();
  assert.equal(store.readRequest(H, h.opts).sessionId, 's2'); assert.equal(h.sends().length, 1);
});
test('degraded tick holds mode, requests and events', async t => {
  const h = await setup(t); await store.updateRequest(H, () => request({ sentAt: iso(-5) }), h.opts);
  const before = tree(h.stateDir); h.readFailure = true; await h.run();
  assert.deepEqual(tree(h.stateDir), before); assert.deepEqual(h.sends(), []);
});
test('accepted changed evidence survives draft and restart beyond parser grace', async t => {
  const h = await setup(t); h.tail = limit(15); h.draft = 'keep'; await h.run();
  assert.equal(store.readMode(h.opts).until, iso(302)); const accepted = store.readMode(h.opts).evidence[H];
  h.now = new Date(iso(480)); await h.run();
  assert.equal(store.readMode(h.opts).until, iso(302)); assert.deepEqual(store.readMode(h.opts).evidence[H], accepted);
  assert.deepEqual(h.sends(), []);
});
test('cleared episode drops evidence so identical text next day opens a new window', async t => {
  const h = await setup(t); h.tail = limit(15); h.draft = 'keep'; await h.run(); h.tail = box;
  await h.run(); await h.run(); assert.equal(store.readMode(h.opts).evidence[H], undefined);
  h.now = new Date(iso(1440)); h.tail = limit(15); await h.run(); assert.equal(store.readMode(h.opts).until, iso(1742));
});
test('billing-only tick marks credit and footer billing text does not', async t => {
  const h = await setup(t, { registration: { mode: 'console' } }); await store.updateMode(() => ({ until: iso(300) }), h.opts);
  h.tail = [...box, billing[0]]; await h.run(); assert.equal(store.readMode(h.opts).creditExhaustedUntil, null);
  h.tail = billing; await h.run(); assert.equal(store.readMode(h.opts).creditExhaustedUntil, '2026-12-01T00:00:00.000Z'); assert.deepEqual(h.sends(), []);
});
async function successor(h, launch = { mode: 'console', reason: 'ok' }, launchedAt = iso(0)) {
  await store.updateRequest(H, q => ({ ...q, state: 'consumed', consumedAt: iso(0), successorGeneration: 2, launch }), h.opts);
  Object.assign(h.r, { generation: 2, mode: launch?.mode ?? 'console', launchedAt }); store.updateRegistration(h.r, h.opts);
}
test('tick between successor and settle holds, then restart confirms on the next tick', async t => {
  const h = await setup(t); await h.run(); await successor(h); h.now = new Date(iso(0.5)); await h.run();
  assert.ok(store.readRequest(H, h.opts)); assert.equal(h.sends().length, 1);
  h.now = new Date(iso(1)); await h.run(); assert.equal(store.readRequest(H, h.opts), null); assert.equal(h.events()[H], undefined);
  assert.ok(h.logs.some(([, m]) => m.includes(`switched ${H} to console`))); assert.equal(h.sends().length, 1);
});
test('switch-back reprint sends nothing on confirmation', async t => {
  const h = await setup(t, { registration: { mode: 'console' } }); await store.updateMode(() => ({ until: iso(-1) }), h.opts);
  h.now = new Date(iso(180)); h.tail = limit(11); await h.run(); assert.equal(store.readRequest(H, h.opts).to, 'max');
  await successor(h, { mode: 'max', reason: 'ok' }, iso(180)); h.now = new Date(iso(182)); await h.run();
  assert.equal(store.readRequest(H, h.opts), null); assert.equal(h.events()[H], undefined);
  assert.deepEqual(h.sends().map(a => a[5]), ['/exit']);
});
for (const reason of ['admission-timeout', 'preflight:unseeded', undefined]) test(`${reason ?? 'missing launch'} fallback remains noSwitch after restart`, async t => {
  const h = await setup(t); await h.run(); await successor(h, reason ? { mode: 'max', reason } : undefined);
  if (!reason) await store.updateRequest(H, q => { delete q.launch; return q; }, h.opts);
  h.now = new Date(iso(3)); await h.run(); assert.equal(store.readRequest(H, h.opts), null);
  assert.ok(store.readMode(h.opts).noSwitch.includes(`${H}:1001`)); assert.ok(store.readMode(h.opts).lastError);
  await h.run(); await h.run(); assert.equal(h.sends().length, 1);
});
test('deadline-passed launch fallback supersedes without noSwitch', async t => {
  const h = await setup(t); await h.run(); await successor(h, { mode: 'max', reason: 'mode' }); h.now = new Date(iso(180));
  await h.run(); assert.equal(store.readRequest(H, h.opts), null); assert.deepEqual(store.readMode(h.opts).noSwitch, []);
  assert.deepEqual(h.events()[H], event()); assert.equal(h.sends().length, 1);
});
for (const replacement of ['absent', 'kind']) test(`snapshot restores history after ${replacement === 'absent' ? 'two absent reads' : 'a kind replacement'} and restart`, async t => {
  const h = await setup(t); const original = event({ attempts: 2, lastAttemptAt: iso(-40), status: 'waiting' }); saveState({ [H]: original }, h.stateDir);
  await h.run(); h.tail = replacement === 'absent' ? box : outage; await h.run(); await h.run();
  assert.notDeepEqual(h.events()[H], original); h.alive.delete(1001); await h.run();
  assert.deepEqual(h.events()[H], original); assert.equal(store.readRequest(H, h.opts), null);
});
for (const kind of ['fail', 'cancel', 'supersede']) for (const step of [1, 2, 3]) test(`outcome ${kind} replays idempotently after crash at step ${step}`, async t => {
  const h = await setup(t); const original = event({ attempts: 2, lastAttemptAt: iso(-45) }); saveState({ [H]: original }, h.stateDir);
  await h.run();
  if (kind === 'fail') await successor(h, { mode: 'max', reason: 'admission-timeout' });
  if (kind === 'supersede') await successor(h, { mode: 'max', reason: 'mode' });
  if (kind === 'cancel') h.alive.delete(1001);
  h.tail = outage;
  await assert.rejects(h.run(false, { overflow: { afterOutcomeStep: n => { if (n === step) throw new Error('simulated crash'); } } }), /simulated crash/);
  const q = store.readRequest(H, h.opts); assert.equal(q.outcome.kind, kind); assert.ok(q.outcome.effects.lastError);
  await h.run(); assert.deepEqual(h.events()[H], original); assert.equal(store.readRequest(H, h.opts), null);
  const mode = store.readMode(h.opts); assert.equal(mode.lastError, q.outcome.effects.lastError);
  assert.equal(mode.noSwitch.includes(`${H}:1001`), kind !== 'supersede');
  // Reinsert the exact durable outcome to emulate a repeated recovery, with no new observation.
  await store.updateRequest(H, () => q, h.opts); await h.run();
  assert.deepEqual(h.events()[H], original); assert.deepEqual(store.readMode(h.opts), mode); assert.equal(store.readRequest(H, h.opts), null);
  h.tail = limit(11); h.draft = 'hold ordinary path'; await h.run(); await h.run(); assert.equal(h.sends().length, 1);
});
test('uncommitted or cancelled switch keeps the original reset anchor for ordinary resume', async t => {
  const h = await setup(t); const original = h.events()[H]; h.draft = 'keep'; await h.run();
  assert.deepEqual(h.events()[H], original); assert.equal(store.readRequest(H, h.opts), null);
  h.draft = ''; await h.run(); h.now = new Date(iso(180)); await h.run();
  assert.deepEqual(h.events()[H], original); assert.ok(store.readMode(h.opts).noSwitch.includes(`${H}:1001`));
  await h.run(); assert.equal(h.sends().at(-1)[5], RESUME_TEXT); assert.equal(h.events()[H].resetAt, original.resetAt);
});
test('credit mark does not cancel a Max request after failed send and restart', async t => {
  const h = await setup(t, { registration: { mode: 'console' } }); h.tail = box;
  await store.updateMode(() => ({ until: iso(-1), creditExhaustedUntil: iso(900) }), h.opts);
  h.sendFailure = true; await h.run(); assert.equal(store.readRequest(H, h.opts).to, 'max');
  h.sendFailure = false; h.now = new Date(iso(3)); await h.run();
  assert.equal(store.readRequest(H, h.opts).attempts, 2); assert.equal(h.sends().length, 2);
});
test('retry exhaustion blocks later ticks but a new wrapper may switch', async t => {
  const h = await setup(t); await h.run();
  for (const minute of [3, 6, 9, 12]) { h.now = new Date(iso(minute)); await h.run(); }
  assert.equal(h.sends().length, 3); assert.ok(store.readMode(h.opts).noSwitch.includes(`${H}:1001`));
  store.releaseHandle(H, 1001, h.opts); h.r.wrapperPid = 2001; h.alive.add(2001); store.updateRegistration(h.r, h.opts);
  await h.run(); assert.equal(h.sends().length, 4);
});
test('request lock timeout holds one handle without failing the tick or another handle', async t => {
  const h = await setup(t); await store.updateRequest(H, () => request({ sentAt: iso(-4) }), h.opts);
  const other = 'term_other'; store.updateRegistration({ ...h.r, handle: other }, h.opts); h.terminals.push({ ...h.terminals[0], handle: other });
  saveState({ ...h.events(), [other]: event({ handle: other }) }, h.stateDir);
  await h.run(false, { overflow: { updateRequest: (handle, fn, opts) => handle === H ? Promise.reject(new store.FlockTimeout(handle)) : store.updateRequest(handle, fn, opts) } });
  assert.equal(store.readRequest(H, h.opts).attempts, 1); assert.deepEqual(h.sends().map(a => a[3]), [other]);
  assert.equal(h.logs.filter(([l, m]) => l === 'warn' && m.includes('lock') && m.includes(H)).length, 1);
});
test('console 429 resumes via the status and draft guarded outage path', async t => {
  const h = await setup(t, { registration: { mode: 'console' } }); await store.updateMode(() => ({ until: iso(300) }), h.opts);
  h.tail = console429; await h.run(); assert.equal(h.events()[H].kind, 'outage');
  h.now = new Date(iso(11)); h.indicator = 'major'; await h.run(); assert.deepEqual(h.sends(), []);
  h.indicator = 'none'; h.draft = 'keep'; await h.run(); assert.deepEqual(h.sends(), []);
  h.draft = ''; await h.run(); assert.deepEqual(h.sends().map(a => a[5]), [OUTAGE_RESUME_TEXT]);
});
test('dry-run proves intended switch with fake TUI screen and leaves all state bytes unchanged', async t => {
  const h = await setup(t);
  const screen = spawnSync(process.execPath, ['e2e/fake-tui.mjs', path.join(h.home, 'received'), '11:00 (Etc/UTC)'], { input: '', encoding: 'utf8' });
  assert.equal(screen.status, 0); h.tail = screen.stdout.trimEnd().split('\n');
  const before = tree(h.stateDir), printed = [], old = console.log;
  try { console.log = text => printed.push(text); await h.run(true); } finally { console.log = old; }
  assert.ok(printed.some(s => s.includes(`would switch ${H} to console`)));
  assert.deepEqual(tree(h.stateDir), before); assert.deepEqual(h.sends(), []);
});
test('spawned enabled dry-run with temp HOME and fake ORCA_CLI exits zero and writes nothing', async t => {
  const h = await setup(t); const fake = path.join(h.home, 'fake-orca');
  fs.writeFileSync(fake, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"result":{"terminals":[]}}\'\n', { mode: 0o755 });
  const before = tree(h.stateDir);
  const result = spawnSync(process.execPath, ['watchdog.mjs', '--dry-run'], { env: { ...process.env, HOME: h.home, ORCA_CLI: fake }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(tree(h.stateDir), before);
});
test('captures keep newest 50 across detected, ordinary sends and switch sends', t => {
  const home = tempHome(t), names = [];
  for (let n = 0; n < 60; n++) {
    const c = { at: iso(n), handle: H, reason: n % 3 === 0 ? 'detected' : 'send', read: { tail: limit(11), draft: 'raw' },
      ...(n % 3 === 2 ? { overflow: { to: 'console', attempt: 1 } } : {}) };
    names.push(path.basename(writeCapture(home, c)));
  }
  assert.deepEqual(fs.readdirSync(path.join(home, 'captures')).sort(), names.slice(10).sort());
  const last = JSON.parse(fs.readFileSync(path.join(home, 'captures', names[59])));
  assert.deepEqual(last.read, { tail: limit(11), draft: 'raw' }); assert.deepEqual(last.overflow, { to: 'console', attempt: 1 });
});

test('tick never treats the default event reset as parsed evidence', async t => {
  const h = await setup(t); h.tail = ['available at 9:00', 'ordinary output', 'Claude usage limit reached.', ...box];
  saveState({}, h.stateDir); await h.run();
  assert.equal(h.events()[H].resetAt, iso(60)); assert.equal(store.readMode(h.opts).until, null);
  assert.equal(store.readRequest(H, h.opts), null); assert.deepEqual(h.sends(), []);
});
test('a pending older handle does not block the selected second handle at commit', async t => {
  const h = await setup(t); await store.updateRequest(H, () => request(), h.opts);
  const other = 'term_second'; store.updateRegistration({ ...h.r, handle: other }, h.opts);
  h.terminals.push({ ...h.terminals[0], handle: other }); saveState({ ...h.events(), [other]: event({ handle: other, detectedAt: iso(-20) }) }, h.stateDir);
  await h.run(); assert.deepEqual(h.sends().map(a => a[3]), [other]); assert.equal(store.readRequest(other, h.opts).to, 'console');
});

test('successor registration racing a stale resend plan is rechecked under the request lock', async t => {
  const h = await setup(t); await store.updateRequest(H, () => request({ sentAt: iso(-3) }), h.opts);
  h.now = new Date(iso(3));
  const script = path.join(h.home, 'successor.mjs');
  fs.writeFileSync(script, `import { updateRequest, updateRegistration } from ${JSON.stringify(new URL('./lib/overflow-state.mjs', import.meta.url).href)};
    const options = { home: process.env.HOME };
    const entry = ${JSON.stringify({ ...h.r, generation: 2, mode: 'console', launchedAt: iso(3) })};
    await updateRequest(entry.handle, async q => {
      process.send('locked');
      await new Promise(resolve => process.once('message', resolve));
      updateRegistration(entry, options);
      return { ...q, state: 'consumed', consumedAt: ${JSON.stringify(iso(3))}, successorGeneration: 2, launch: { mode: 'console', reason: 'ok' } };
    }, options);
    process.disconnect();`);
  const child = fork(script, [], { env: { ...process.env, HOME: h.home }, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`child exited ${code}`))); });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('message', m => { assert.equal(m, 'locked'); resolve(); }); });
  let released = false;
  await h.run(false, { overflow: { updateRequest: (handle, fn, opts) => {
    if (!released) { released = true; child.send('register'); }
    return store.updateRequest(handle, fn, opts);
  } } });
  await exited;
  assert.equal(released, true); assert.equal(store.readRequest(H, h.opts).state, 'consumed');
  assert.deepEqual(h.sends(), []); assert.deepEqual(store.readMode(h.opts).noSwitch, []);
  h.now = new Date(iso(5)); await h.run(); assert.equal(store.readRequest(H, h.opts), null);
  assert.equal(h.events()[H], undefined); assert.deepEqual(h.sends(), []);
});
test('a recorded outcome replays after overflow is disabled', async t => {
  const h = await setup(t); await h.run(); h.alive.delete(1001);
  await assert.rejects(h.run(false, { overflow: { afterOutcomeStep: step => { if (step === 1) throw new Error('crash'); } } }), /crash/);
  fs.unlinkSync(h.paths.enabledFile); await h.run();
  assert.equal(store.readRequest(H, h.opts), null); assert.deepEqual(h.events()[H], event());
  assert.ok(store.readMode(h.opts).noSwitch.includes(`${H}:1001`)); assert.equal(h.sends().length, 1);
});
test('dry-run reports a credit mark without changing mode or requests', async t => {
  const h = await setup(t, { registration: { mode: 'console' } }); await store.updateMode(() => ({ until: iso(300) }), h.opts);
  h.tail = billing; const before = tree(h.stateDir), printed = [], old = console.log;
  try { console.log = text => printed.push(text); await h.run(true); } finally { console.log = old; }
  assert.ok(printed.some(text => text.includes('would update overflow mode'))); assert.deepEqual(tree(h.stateDir), before);
});
test('overflow limit buffer is the ordinary limit schedule buffer', async () => {
  const { LIMIT_BUFFER_MS } = await import('./lib/overflow.mjs'); assert.equal(LIMIT_BUFFER_MS, SCHEDULE.limit.bufferMs);
});

test('noSwitch withholds pending retries in both directions', () => {
  for (const to of ['console', 'max']) {
    const i = input(); i.mode.until = iso(300); i.mode.noSwitch = [`${H}:1001`];
    i.requests.set(H, request({ to, sentAt: iso(-3) }));
    const p = planOverflow(i); assert.deepEqual(p.resends, []); assert.equal(p.suppress.get(H), 'all');
  }
});

test('A13: only exit has a bounded exec timeout; timeout releases the request lock and later resends', async t => {
  const h = await setup(t), timeouts = [];
  h.onCall = (args, execImpl, timeoutMs) => timeouts.push([args[1], timeoutMs]);
  h.sendFailure = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
  await h.run();
  assert.deepEqual(timeouts.filter(([verb]) => verb === 'send'), [['send', 5000]]);
  assert.ok(timeouts.filter(([verb]) => verb !== 'send').every(([, timeout]) => timeout === undefined));
  const q = store.readRequest(H, h.opts);
  assert.equal(q.state, 'pending'); assert.equal(q.attempts, 1); assert.equal(q.sentAt, iso(0));
  assert.equal(h.captures.find(c => c.reason === 'send').sent, false);
  const script = path.join(h.home, 'lock-probe.mjs');
  fs.writeFileSync(script, `import { updateRequest } from ${JSON.stringify(new URL('./lib/overflow-state.mjs', import.meta.url).href)};
    process.send('ready');
    process.once('message', async () => {
      await updateRequest(${JSON.stringify(H)}, q => { process.send(q); return q; }, { home: process.env.HOME, timeoutS: 0 });
      process.disconnect();
    });`);
  const child = fork(script, [], { env: { ...process.env, HOME: h.home }, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`child exited ${code}`))); });
  await new Promise(resolve => child.once('message', message => { assert.equal(message, 'ready'); resolve(); }));
  const acquired = new Promise(resolve => child.once('message', resolve));
  child.send('acquire'); assert.deepEqual(await acquired, q); await exited;
  h.sendFailure = false; h.now = new Date(iso(3)); await h.run();
  assert.equal(store.readRequest(H, h.opts).attempts, 2); assert.equal(h.sends().length, 2);
});
test('A13: production orca forwards exit timeout and preserves default exec timeout', async () => {
  const calls = [], exec = async (file, args, options) => { calls.push({ args, options }); return { stdout: '{"ok":true,"result":{}}' }; };
  await orca(['terminal', 'send', '--terminal', H, '--text', '/exit', '--enter'], exec, 5000);
  await orca(['terminal', 'list'], exec);
  assert.deepEqual(calls.map(c => c.options.timeout), [5000, 15000]);
});

for (const disagreement of [false, true]) test(`A12: changed Max request session supersedes and next tick switches s2${disagreement ? ' after disagreement holds' : ''}`, async t => {
  const h = await setup(t, { registration: { mode: 'console' } }); h.tail = box;
  await store.updateMode(() => ({ until: iso(-1) }), h.opts); h.sendFailure = true; await h.run();
  const q = store.readRequest(H, h.opts); assert.equal(q.to, 'max'); assert.equal(q.sessionId, 's1');
  h.sendFailure = false; h.session({ sessionId: 's2', status: 'idle' }); h.now = new Date(iso(3));
  if (disagreement) {
    await h.run(); assert.deepEqual(store.readRequest(H, h.opts), q); assert.equal(h.sends().length, 1);
    assert.equal(store.readMode(h.opts).lastError, null);
  }
  h.r.sessionId = 's2'; store.updateRegistration(h.r, h.opts);
  const steps = [];
  await h.run(false, { overflow: { afterOutcomeStep: step => {
    steps.push(step); const recorded = store.readRequest(H, h.opts);
    assert.equal(recorded.outcome.kind, 'supersede'); assert.equal(recorded.outcome.reason, 'session-changed');
    if (step === 1) assert.equal(store.readMode(h.opts).lastError, null);
    if (step >= 2) assert.match(store.readMode(h.opts).lastError, /session-changed/);
    if (step === 3) assert.deepEqual(h.events(), q.eventSnapshot);
  } } });
  assert.deepEqual(steps, [1, 2, 3]); assert.equal(store.readRequest(H, h.opts), null);
  assert.deepEqual(h.events(), q.eventSnapshot); assert.deepEqual(store.readMode(h.opts).noSwitch, []); assert.equal(h.sends().length, 1);
  assert.ok(h.logs.some(([level, message]) => level === 'info' && message.includes('session-changed')));
  await h.run(); assert.equal(store.readRequest(H, h.opts).sessionId, 's2'); assert.equal(h.sends().length, 2);
});
for (const condition of ['deadline', 'credit']) test(`A12: changed Console request session supersedes before ${condition} cancel`, async t => {
  const h = await setup(t); await h.run(); const q = store.readRequest(H, h.opts);
  h.r.sessionId = 's2'; store.updateRegistration(h.r, h.opts); h.session({ sessionId: 's2', status: 'idle' });
  h.now = new Date(iso(condition === 'deadline' ? 180 : 3)); h.tail = box;
  if (condition === 'credit') await store.updateMode(() => ({ creditExhaustedUntil: iso(900) }), h.opts);
  await h.run(); assert.equal(store.readRequest(H, h.opts), null); assert.deepEqual(h.events(), q.eventSnapshot);
  assert.deepEqual(store.readMode(h.opts).noSwitch, []); assert.match(store.readMode(h.opts).lastError, /supersede.*session-changed/);
  assert.equal(h.sends().length, 1);
});
for (const variant of ['within window', 'missing pid file', 'disagreement', 'dead wrapper']) test(`A12: ${variant} takes precedence over session supersede`, () => {
  const i = input(); i.observations.clear(); i.mode.until = iso(-1);
  i.requests.set(H, request({ sentAt: iso(-3), attempts: 3 })); i.registrations[0].sessionId = 's2';
  const key = '/fake/config:1002'; i.sessions.set(key, { sessionId: 's2', status: 'idle' });
  if (variant === 'within window') i.requests.get(H).sentAt = iso(0);
  if (variant === 'missing pid file') i.sessions.delete(key);
  if (variant === 'disagreement') i.sessions.get(key).sessionId = 's1';
  if (variant === 'dead wrapper') i.facts.alive.delete(1001);
  const p = planOverflow(i);
  assert.deepEqual(p.supersedes, []); assert.deepEqual(p.resends, []);
  assert.deepEqual(p.cancels, variant === 'dead wrapper' ? [{ handle: H, reason: 'wrapper ownership lost' }] : []);
});

test('dry-run outcome replay after A3 step 1 preserves every state file and lock', async t => {
  const h = await setup(t); await h.run(); h.alive.delete(1001); h.tail = outage;
  await assert.rejects(h.run(false, { overflow: { afterOutcomeStep: step => { if (step === 1) throw new Error('crash'); } } }), /crash/);
  assert.ok(store.readRequest(H, h.opts).outcome);
  const before = tree(h.stateDir); await h.run(true);
  assert.deepEqual(tree(h.stateDir), before); assert.equal(h.sends().length, 1);
});
for (const point of ['inside lock', 'before send']) test(`pause ${point} prevents exit`, async t => {
  const h = await setup(t); let inLock = false, checked = false;
  await h.run(false, {
    overflow: { updateRequest: (handle, fn, opts) => store.updateRequest(handle, async q => {
      inLock = true; try { return await fn(q); } finally { inLock = false; }
    }, opts) },
    isDisabled: () => {
      if (inLock && (point === 'inside lock' || store.readRequest(H, h.opts) !== null)) {
        checked = true; h.disabled = true;
      }
      return h.disabled;
    },
  });
  assert.deepEqual(h.sends(), []);
  if (point === 'inside lock') { assert.equal(checked, true); assert.equal(store.readRequest(H, h.opts), null); }
  else { assert.equal(store.readRequest(H, h.opts).attempts, 1); assert.equal(h.captures.find(c => c.reason === 'send').sent, false); }
});
test('confirm preserves an outage first detected on G+1 during the confirming tick', async t => {
  const h = await setup(t); await h.run(); await successor(h); h.now = new Date(iso(1)); h.tail = console429;
  await h.run(); assert.equal(store.readRequest(H, h.opts), null);
  assert.equal(h.events()[H]?.kind, 'outage'); assert.equal(h.events()[H].detectedAt, iso(1)); assert.equal(h.sends().length, 1);
});

for (const status of ['busy', 'waiting', undefined]) test(`non-idle Console trigger logs ${status ?? 'missing status'} once per episode across ticks`, async t => {
  const h = await setup(t); h.session({ sessionId: 's1', status });
  const lines = () => h.logs.filter(([level, message]) => level === 'info' && message.includes(H) && message.includes('pid-file status'));
  const before = tree(h.stateDir); await h.run(true); assert.deepEqual(tree(h.stateDir), before); assert.equal(lines().length, 0);
  await h.run(); h.session({ sessionId: 's1', status: status === 'busy' ? 'waiting' : 'busy' });
  await h.run(); assert.equal(lines().length, 1); assert.ok(lines()[0][1].includes(status ?? 'missing'));
  assert.equal(store.readRequest(H, h.opts), null); assert.deepEqual(h.sends(), []);
  h.tail = box; await h.run(); await h.run(); h.now = new Date(iso(1)); h.tail = limit(11);
  await h.run(); assert.equal(lines().length, 2);
  h.session(); await h.run(); assert.equal(h.sends().length, 1);
});
for (const blocker of ['noSwitch', 'credit', 'session', 'ineligible', 'background']) test(`non-idle diagnostic is withheld when ${blocker} also blocks the trigger`, async t => {
  const h = await setup(t); h.session({ sessionId: blocker === 'session' ? 's2' : 's1', status: 'busy' });
  if (blocker === 'noSwitch') await store.updateMode(() => ({ noSwitch: [`${H}:1001`] }), h.opts);
  if (blocker === 'credit') await store.updateMode(() => ({ creditExhaustedUntil: iso(900) }), h.opts);
  if (blocker === 'ineligible') { h.r.eligible = false; store.updateRegistration(h.r, h.opts); }
  if (blocker === 'background') h.ps = '1001 99 ttys099';
  await h.run(); assert.equal(h.logs.filter(([, message]) => message.includes('pid-file status')).length, 0);
});

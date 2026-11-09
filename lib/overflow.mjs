import { launchMode, switchBackDue, RELAUNCH_WINDOW_MS, SETTLE_MS } from './overflow-state.mjs';

export const CONSUMED_BOUND_MS = 15 * 60_000;
export const CONFIRM_BOUND_MS = 10 * 60_000;
export const MAX_SWITCH_ATTEMPTS = 3;
export const SWITCHES_TO_CONSOLE_PER_TICK = 1;
export const SWITCH_SEND_TIMEOUT_MS = 5_000;
// Kept equal to SCHEDULE.limit.bufferMs without importing the daemon.
export const LIMIT_BUFFER_MS = 2 * 60_000;
const normalized = text => String(text).replace(/ \| /g, ' ').replace(/\s+/g, ' ').trim();
const sessionFor = (sessions, r) => sessions.get(`${r.configDir}:${r.claudePid}`);
const snapshotEvent = (request, handle) => Object.values(request?.eventSnapshot ?? {}).find(e => e.handle === handle && e.kind === 'limit');

// No I/O here. The adapter repeats request decisions under the wrapper's lock,
// and independently proves the send guards against a fresh read and pid file.
export function planOverflow({ enabled, mode: currentMode, registrations, requests, sessions, facts,
  observations, events, listedHandles, now }) {
  const mode = structuredClone(currentMode);
  const plan = { mode, suppress: new Map(), switches: [], resends: [], confirms: [], fails: [], cancels: [],
    supersedes: [], idleHolds: [], consoleHandles: new Set() };
  if (!enabled) return plan;
  const owners = new Map();
  for (const r of registrations) owners.set(r.handle, [...owners.get(r.handle) ?? [], r]);
  const listed = new Map();
  for (const handle of listedHandles) listed.set(handle, (listed.get(handle) ?? 0) + 1);
  const valid = r => owners.get(r.handle)?.length === 1 && listed.get(r.handle) === 1
    && facts.alive.has(r.wrapperPid) && facts.alive.has(r.claudePid) && facts.foreground.has(r.handle);
  const hasRead = handle => observations.get(handle)?.read === true;
  mode.noSwitch = (mode.noSwitch ?? []).filter(key => registrations.some(r => `${r.handle}:${r.wrapperPid}` === key));
  mode.evidence ??= {};
  for (const [handle, e] of Object.entries(mode.evidence)) {
    const ev = events[handle], snapshot = snapshotEvent(requests.get(handle), handle);
    if (!owners.has(handle) || !((ev?.kind === 'limit' && ev.detectedAt === e.episode) || snapshot?.detectedAt === e.episode)) {
      delete mode.evidence[handle];
    }
  }
  for (const r of registrations.filter(valid)) {
    if (r.mode === 'console') {
      plan.consoleHandles.add(r.handle);
      plan.suppress.set(r.handle, 'limit-credits');
      if (hasRead(r.handle) && observations.get(r.handle).billing) {
        mode.creditExhaustedUntil = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
      }
    }
  }
  const triggers = new Set();
  for (const r of registrations.filter(valid)) {
    const o = observations.get(r.handle), b = o?.banner, ev = events[r.handle];
    if (!r.eligible || !hasRead(r.handle) || b?.kind !== 'limit' || b.platform !== 'claude' || !b.parsedReset
      || Date.parse(mode.creditExhaustedUntil) > +now) continue;
    const evidence = mode.evidence[r.handle];
    let resetAt;
    if (evidence && normalized(b.bannerText) === normalized(evidence.bannerText)) resetAt = evidence.resetAt;
    else if (ev?.kind === 'limit' && normalized(b.bannerText) === normalized(ev.bannerText)) resetAt = ev.resetAt;
    else {
      resetAt = b.resetAt;
      if (ev?.kind === 'limit') mode.evidence[r.handle] = { bannerText: b.bannerText, resetAt,
        acceptedAt: now.toISOString(), episode: ev.detectedAt };
    }
    if (!Number.isFinite(Date.parse(resetAt))) continue;
    mode.until = new Date(Math.max(Date.parse(mode.until) || 0, Date.parse(resetAt) + LIMIT_BUFFER_MS)).toISOString();
    triggers.add(r.handle);
  }
  for (const [handle, q] of requests) {
    plan.suppress.set(handle, 'all');
    if (q.outcome) continue; // The adapter replays these before it plans a switch.
    const siblings = owners.get(handle) ?? [], r = siblings.find(r => r.wrapperPid === q.wrapperPid);
    const cancel = reason => plan.cancels.push({ handle, reason });
    const fail = reason => plan.fails.push({ handle, reason });
    if (!facts.alive.has(q.wrapperPid) || !r || siblings.length !== 1) { cancel('wrapper ownership lost'); continue; }
    if (q.state === 'pending' && r.generation === q.generation) {
      const session = sessionFor(sessions, r);
      if (!session?.sessionId || session.sessionId !== r.sessionId) continue;
      if (session.sessionId !== q.sessionId) {
        if (+now - Date.parse(q.sentAt) >= RELAUNCH_WINDOW_MS) plan.supersedes.push({ handle, reason: 'session-changed' });
        continue;
      }
    }
    if (r.generation > q.generation + 1) { fail('fallback generation'); continue; }
    if (r.generation === q.generation + 1) {
      if (q.launch?.mode !== q.to) {
        if (q.launch?.reason === 'mode') plan.supersedes.push({ handle });
        else fail(q.launch?.reason ?? 'missing launch outcome');
        continue;
      }
      const age = +now - Date.parse(r.launchedAt);
      const session = sessionFor(sessions, r);
      if (age >= SETTLE_MS && facts.alive.has(r.claudePid) && session?.sessionId === q.sessionId) {
        plan.confirms.push({ handle, successorLaunchedAt: r.launchedAt });
      } else if (age >= CONFIRM_BOUND_MS) fail('successor session not confirmed');
      continue;
    }
    if (q.state === 'consumed') {
      if (+now - Date.parse(q.consumedAt) >= CONSUMED_BOUND_MS) fail('successor not registered');
      continue;
    }
    if (q.state !== 'pending' || r.generation !== q.generation) { cancel('generation mismatch'); continue; }
    if (q.to === 'console' && launchMode(mode, now) !== 'console') { cancel('Console window closed'); continue; }
    if (+now - Date.parse(q.sentAt) >= RELAUNCH_WINDOW_MS) {
      if (q.attempts >= MAX_SWITCH_ATTEMPTS) cancel('switch retries exhausted');
      else if (valid(r) && hasRead(handle) && !mode.noSwitch.includes(`${handle}:${r.wrapperPid}`)) plan.resends.push({ handle });
    }
  }
  const candidates = registrations.filter(r => valid(r) && r.eligible && hasRead(r.handle) && !requests.has(r.handle)
    && !mode.noSwitch.includes(`${r.handle}:${r.wrapperPid}`)
    && sessionFor(sessions, r)?.sessionId === r.sessionId);
  candidates.sort((a, b) => Date.parse(events[a.handle]?.detectedAt ?? a.launchedAt) - Date.parse(events[b.handle]?.detectedAt ?? b.launchedAt));
  let toConsole = 0;
  for (const r of candidates) {
    const to = r.mode === 'console' && switchBackDue(mode, now) ? 'max'
      : r.mode === 'max' && triggers.has(r.handle) && launchMode(mode, now) === 'console'
        && toConsole < SWITCHES_TO_CONSOLE_PER_TICK ? 'console' : null;
    if (!to) continue;
    if (sessionFor(sessions, r)?.status !== 'idle') {
      if (to === 'console') plan.idleHolds.push({ handle: r.handle, status: sessionFor(sessions, r)?.status });
      continue;
    }
    if (to === 'console') toConsole++;
    plan.switches.push({ handle: r.handle, to, wrapperPid: r.wrapperPid, generation: r.generation, sessionId: r.sessionId });
    plan.suppress.set(r.handle, 'all');
  }
  return plan;
}

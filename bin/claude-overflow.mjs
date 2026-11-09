#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseClaudeArgv, resolveModel, isEligibleModel } from '../lib/claude-argv.mjs';
import { syncConsoleProject } from '../lib/console-config.mjs';
import { appendActivity } from '../lib/logs.mjs';
import { overflowPaths, isEnabled, readMode, launchMode, claimHandle, updateRegistration, releaseHandle,
  updateRequest, takeAdmission, RELAUNCH_WINDOW_MS, SESSION_POLL_MS, SETTLE_MS,
  ADMISSION_POLL_MS, ADMISSION_GIVE_UP_MS } from '../lib/overflow-state.mjs';

export const CONSOLE_MESSAGE = 'Your session restarted on API credit because the Max limit was reached. Re-arm any background waits you had running, then resume where you left off.';
export const MAX_MESSAGE = 'Your session restarted to move back to the Max plan. This is not a new instruction: re-arm any background waits you had running, then carry on as before, or keep waiting if you were waiting for the user.';

function withoutAdvisor(argv) {
  const result = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--advisor') { i++; continue; }
    if (argv[i].startsWith('--advisor=')) continue;
    result.push(argv[i]);
  }
  return result;
}
function exitStatus(code, signal) { return code ?? (128 + (os.constants.signals[signal] ?? 0)); }
function isWrapperExecutable(command, env) {
  const candidates = command.includes('/') ? [command] : (env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, command));
  const wrappers = ['./claude-overflow', '../../bin/claude-overflow', './claude-overflow.mjs'].flatMap(relative => {
    try { return [fs.statSync(new URL(relative, import.meta.url))]; } catch { return []; }
  });
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      return wrappers.some(wrapper => wrapper.dev === stat.dev && wrapper.ino === stat.ino);
    } catch { /* Match executable PATH lookup; a missing target is handled by spawn. */ }
  }
  return false;
}
function foregroundIdentity(run = spawnSync) {
  const result = run('/bin/ps', ['-o', 'pgid=,tty=', '-p', String(process.pid)], { encoding: 'utf8' });
  const [pgid, tty] = (result.stdout ?? '').trim().split(/\s+/);
  if (result.status !== 0 || !Number.isSafeInteger(Number(pgid)) || !tty) throw new Error('cannot determine wrapper tty and process group');
  return { pgid: Number(pgid), tty };
}

export async function runWrapper({ argv = process.argv.slice(2), env = process.env, home = os.homedir(), deps = {} } = {}) {
  const now = deps.now ?? (() => new Date());
  const startChild = deps.spawn ?? spawn;
  const sleep = deps.sleep ?? delay;
  const every = deps.setInterval ?? setInterval;
  const clear = deps.clearInterval ?? clearInterval;
  const paths = overflowPaths(home), opts = { home, timeoutS: deps.flockTimeoutS }, handle = env.ORCA_TERMINAL_HANDLE;
  const claude = env.CLAUDE_OVERFLOW_CLAUDE || 'claude';
  const parsed = parseClaudeArgv(argv), maxDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  let child = null, stopped = null, owned = false, entry, pollTimer, publishedSessionId;
  let wakeStop;
  const stopPromise = new Promise(resolve => { wakeStop = resolve; });
  const stop = signal => {
    stopped ??= signal;
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
    wakeStop();
  };
  const ignore = () => {};
  const onTerm = () => stop('SIGTERM'), onHup = () => stop('SIGHUP');
  const release = () => { if (owned) releaseHandle(handle, process.pid, opts); owned = false; };
  process.on('SIGINT', ignore); process.on('SIGQUIT', ignore);
  process.on('SIGTERM', onTerm); process.on('SIGHUP', onHup); process.on('exit', release);
  function report(message) {
    const text = `claude-overflow: ${message}`;
    process.stderr.write(text + '\n');
    try { appendActivity(path.dirname(paths.dir), `${now().toISOString()} error ${text}\n`); } catch { /* stderr still carries the error */ }
  }
  async function runChild(args, childEnv, onSpawn) {
    if (stopped) return exitStatus(null, stopped);
    return new Promise(resolve => {
      try { child = startChild(claude, args, { env: childEnv, stdio: 'inherit', detached: false }); }
      catch (error) { report(`cannot launch Claude: ${error.message}`); resolve(1); return; }
      child.once('error', error => { report(`cannot launch Claude: ${error.message}`); resolve(1); });
      child.once('exit', (code, signal) => resolve(exitStatus(code, signal)));
      if (onSpawn && child.pid) onSpawn(child.pid);
    });
  }
  function publishRegistration() {
    updateRegistration(entry, opts);
    publishedSessionId = entry.sessionId;
  }
  function pollSession() {
    if (!entry?.claudePid) return;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(entry.configDir, 'sessions', `${entry.claudePid}.json`), 'utf8'));
      if (typeof value.sessionId === 'string' && value.sessionId) {
        entry.sessionId = value.sessionId;
        if (entry.sessionId !== publishedSessionId) publishRegistration();
      }
    } catch { /* Claude removes its pid file before exit; retain the last observation. */ }
  }
  try {
    if (isWrapperExecutable(claude, env)) { report('refusing recursive Claude executable'); return 1; }
    if (!handle || !isEnabled(opts) || env.CLAUDE_OVERFLOW_OWNER || !parsed.parseable || parsed.print || parsed.selector === 'unsupported')
      return await runChild(argv, env);
    try {
      const identity = foregroundIdentity(deps.spawnSync);
      entry = { handle, wrapperPid: process.pid, wrapperStartedAt: now().toISOString(), generation: 1,
        claudePid: null, sessionId: parsed.sessionId || randomUUID(), configDir: maxDir, mode: 'max',
        eligible: false, model: null, launchedAt: now().toISOString(), cwd: process.cwd(), ...identity };
      owned = await claimHandle(entry, opts);
      if (owned) publishedSessionId = entry.sessionId;
      if (!owned) report(`cannot claim terminal ${handle}: another wrapper owns the handle or ownership is uncertain`);
    } catch (error) { report(`cannot claim terminal ${handle}: ${error.message}`); owned = false; }
    if (!owned) return await runChild(argv, env);

    let consumed = null, relaunch = false, fallback = false, fallbackTried = false;
    let generation = 1;
    async function chooseLaunch(record) {
      const effectiveMode = () => isEnabled(opts) ? launchMode(readMode(opts), now()) : 'max';
      let mode = fallback ? 'max' : effectiveMode();
      let model = resolveModel({ argvModel: parsed.model, env, configDir: mode === 'console' ? paths.consoleDir : maxDir });
      const eligible = isEligibleModel(model);
      if (!eligible) mode = 'max';
      let reason = record && mode !== record.to ? 'mode' : 'ok';
      if (consumed && !record) { mode = 'max'; reason = 'mode'; }
      if (mode === 'console') {
        const preflight = await syncConsoleProject(entry.cwd, opts);
        if (!preflight.ok) {
          mode = 'max'; reason = `preflight:${preflight.reason}`;
          report(`Console preflight for ${entry.cwd}: ${preflight.reason}; launching on Max`);
        }
      }
      if (mode === 'console' && (relaunch || parsed.selector === 'resume-id')) {
        if (record && +now() - Date.parse(record.consumedAt) >= ADMISSION_GIVE_UP_MS) {
          mode = 'max'; reason = 'admission-timeout';
        } else if (!await takeAdmission(now(), opts)) return null;
        // Admission can wait on another process's lock; use fresh mode evidence.
        if (effectiveMode() === 'max') { mode = 'max'; reason = 'mode'; }
      }
      if (mode === 'max') model = resolveModel({ argvModel: parsed.model, env, configDir: maxDir });
      return { mode, reason, model, eligible: eligible && isEligibleModel(model) };
    }
    function registerLaunch(choice) {
      Object.assign(entry, { generation, claudePid: null, mode: choice.mode, model: choice.model, eligible: choice.eligible,
        configDir: choice.mode === 'console' ? paths.consoleDir : maxDir, launchedAt: now().toISOString() });
      publishRegistration();
    }
    while (!stopped) {
      let choice = null;
      while (!choice && !stopped) {
        if (consumed && !fallback) {
          await updateRequest(handle, async record => {
            if (stopped) return record;
            const matches = record?.state === 'consumed' && !record.outcome && record.wrapperPid === process.pid
              && record.generation === consumed.generation && record.sessionId === consumed.sessionId
              && record.successorGeneration === generation && record.consumedAt === consumed.consumedAt;
            choice = await chooseLaunch(matches ? record : null);
            if (!choice || stopped) return record;
            registerLaunch(choice);
            return matches ? { ...record, launch: { mode: choice.mode, reason: choice.reason } } : record;
          }, opts);
        } else {
          choice = await chooseLaunch(null);
          if (choice && !stopped) registerLaunch(choice);
        }
        if (!choice && !stopped) await Promise.race([sleep(ADMISSION_POLL_MS), stopPromise]);
      }
      if (stopped) return exitStatus(null, stopped);
      const childEnv = { ...env, CLAUDE_OVERFLOW_OWNER: `${handle}:${process.pid}` };
      if (choice.mode === 'console') {
        childEnv.CLAUDE_CONFIG_DIR = paths.consoleDir;
        childEnv.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1';
      }
      const keep = choice.mode === 'console' ? withoutAdvisor(parsed.keep) : parsed.keep;
      const selector = relaunch || parsed.selector === 'resume-id' ? '--resume' : '--session-id';
      const message = relaunch ? (choice.mode === 'console' ? CONSOLE_MESSAGE : MAX_MESSAGE) : parsed.prompt;
      const prompt = message === null ? [] : [...(message.startsWith('-') ? ['--'] : []), message];
      const args = [...keep, selector, entry.sessionId, ...prompt];
      const code = await runChild(args, childEnv, pid => {
        entry.claudePid = pid; publishRegistration();
        pollTimer = every(pollSession, SESSION_POLL_MS);
      });
      if (pollTimer) { clear(pollTimer); pollTimer = null; }
      pollSession();
      child = null;
      if (stopped) return code;
      if (relaunch && code !== 0 && (fallback || +now() - Date.parse(entry.launchedAt) < SETTLE_MS)) {
        if (!fallbackTried) { fallbackTried = true; fallback = true; generation++; continue; }
        report(`fallback failed; resume session ${entry.sessionId} manually`); return code;
      }
      let mismatch = null, next = null;
      await updateRequest(handle, record => {
        if (stopped || !entry.eligible || record?.state !== 'pending' || record.outcome || record.wrapperPid !== process.pid
            || record.generation !== generation || !['max', 'console'].includes(record.to)) return record;
        const age = +now() - Date.parse(record.sentAt);
        if (!Number.isFinite(age) || age < 0 || age > RELAUNCH_WINDOW_MS) return record;
        if (record.sessionId !== entry.sessionId) { mismatch = record.sessionId; return record; }
        next = { ...record, state: 'consumed', consumedAt: now().toISOString(), successorGeneration: generation + 1 };
        return next;
      }, opts);
      if (stopped) return code;
      if (mismatch !== null) { report(`request session ${mismatch} differs from current session ${entry.sessionId}; no relaunch`); return 1; }
      if (!next) return code;
      consumed = next; generation++; relaunch = true; fallback = false;
    }
    return exitStatus(null, stopped);
  } catch (error) {
    report(`overflow stopped for session ${entry?.sessionId ?? 'unknown'}: ${error.message}`);
    return 1;
  } finally {
    if (pollTimer) clear(pollTimer);
    release();
    process.removeListener('SIGINT', ignore); process.removeListener('SIGQUIT', ignore);
    process.removeListener('SIGTERM', onTerm); process.removeListener('SIGHUP', onHup); process.removeListener('exit', release);
  }
}

let entryPath;
try { entryPath = process.argv[1] && fs.realpathSync(process.argv[1]); } catch { /* Missing entry paths do not invoke the wrapper. */ }
if (entryPath === fileURLToPath(import.meta.url)) process.exitCode = await runWrapper();

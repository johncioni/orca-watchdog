#!/usr/bin/env node
// Controlled Claude boundary for wrapper tests. No network or real config access.
import fs from 'node:fs';
import path from 'node:path';
import { parseClaudeArgv } from '../lib/claude-argv.mjs';
import { updateRequest } from '../lib/overflow-state.mjs';

const argv = process.argv.slice(2), env = process.env;
const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME, '.claude');
const pidFile = path.join(configDir, 'sessions', `${process.pid}.json`);
let sessionId = env.FAKE_CLAUDE_SESSION || parseClaudeArgv(argv).sessionId || 'fake-session';
fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
const writeSession = () => fs.writeFileSync(pidFile, JSON.stringify({ sessionId, status: 'idle' }));
writeSession();
if (env.FAKE_CLAUDE_LOG) fs.appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({ argv,
  CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? null, CLAUDE_CODE_TMPDIR: env.CLAUDE_CODE_TMPDIR ?? null,
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL ?? null,
  CLAUDE_OVERFLOW_OWNER: env.CLAUDE_OVERFLOW_OWNER ?? null }) + '\n');
function exit(code = Number(env.FAKE_CLAUDE_EXIT || 0), remove = true) {
  if (remove) fs.rmSync(pidFile, { force: true });
  process.exit(code);
}
async function control(message) {
  if (message.type === 'session') { sessionId = message.sessionId; writeSession(); process.send?.({ type: 'session', sessionId }); }
  if (message.type === 'request') { await updateRequest(env.ORCA_TERMINAL_HANDLE, () => message.record, { home: env.HOME }); process.send?.({ type: 'request' }); }
  if (message.type === 'exit') exit(message.code, message.remove);
}
process.on('SIGTERM', () => exit(143)); process.on('SIGHUP', () => exit(129));
process.on('message', message => { void control(message); });
if (env.FAKE_CLAUDE_CONTROL) fs.watchFile(env.FAKE_CLAUDE_CONTROL, () => {
  try { void control(JSON.parse(fs.readFileSync(env.FAKE_CLAUDE_CONTROL, 'utf8'))); } catch { /* wait for a complete command */ }
});
process.send?.({ type: 'ready', pid: process.pid, sessionId });
if (!process.send && !env.FAKE_CLAUDE_CONTROL) exit();

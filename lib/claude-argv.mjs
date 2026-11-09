import fs from 'node:fs';
import path from 'node:path';

// Claude Code 2.1.319, spike item 11. Unknown options deliberately stay unwrapped.
export const VALUE_OPTIONS = new Set([
  '--add-dir', '--agent', '--agents', '--allowedTools', '--allowed-tools', '--append-system-prompt',
  '--autocompact', '--betas', '--debug-file', '--disallowedTools', '--disallowed-tools', '--effort',
  '--environment', '--fallback-model', '--file', '--input-format', '--json-schema', '--max-budget-usd',
  '--mcp-config', '--model', '-n', '--name', '--output-format', '--permission-mode', '--permission-prompts',
  '--plugin-dir', '--plugin-url', '--remote-control-session-name-prefix', '--session-id', '--setting-sources',
  '--settings', '--system-prompt', '--system-prompt-snapshot', '--tools', '--advisor', '--append-system-prompt-file',
  '--system-prompt-file', '--plugin-dir-no-mcp', '--max-turns', '--thinking-display', '--inherit-permission-mode',
  '--managed-settings', '--prefill', '-m',
]);
export const KNOWN_FLAGS = new Set([
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--strict-mcp-config',
  '--chrome', '--no-chrome', '-c', '--continue', '--fork-session', '-p', '--print', '-h', '--help', '-v', '--version',
  '--verbose', '--include-partial-messages', '--replay-user-messages', '--no-session-persistence',
  '--disable-slash-commands', '--ide', '--init', '--init-only', '--maintenance',
]);
const variadic = new Set(['--add-dir', '--allowedTools', '--allowed-tools', '--betas', '--disallowedTools', '--disallowed-tools', '--file', '--mcp-config', '--tools']);
const optional = new Set(['-r', '--resume', '-d', '--debug', '--cloud', '--from-pr', '--prompt-suggestions', '--remote-control', '--teleport', '-w', '--worktree']);

export function parseClaudeArgv(argv) {
  const result = { keep: [], prompt: null, sessionId: null, selector: 'none', print: false, model: null, parseable: true };
  let selectors = 0;
  function prompt(value) {
    if (result.prompt !== null) result.parseable = false;
    else result.prompt = value;
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { for (const value of argv.slice(i + 1)) prompt(value); break; }
    if (!arg.startsWith('-')) { prompt(arg); continue; }
    const equal = arg.indexOf('='), option = equal < 0 ? arg : arg.slice(0, equal);
    const values = equal < 0 ? [] : [arg.slice(equal + 1)];
    const tokens = [arg];
    if (VALUE_OPTIONS.has(option) || optional.has(option)) {
      if (!values.length && i + 1 < argv.length && !argv[i + 1].startsWith('-')) { values.push(argv[++i]); tokens.push(argv[i]); }
      if (variadic.has(option)) while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) { values.push(argv[++i]); tokens.push(argv[i]); }
      if ((VALUE_OPTIONS.has(option) && !values.length) || values.some(v => v === '')) result.parseable = false;
      if (option === '--session-id' || option === '--resume' || option === '-r') {
        selectors++;
        result.sessionId = values[0] ?? null;
        if (result.selector !== 'unsupported') result.selector = values.length ? (option === '--session-id' ? 'session-id' : 'resume-id') : 'unsupported';
      } else {
        result.keep.push(...tokens);
        if (option === '--model') result.model = values[0] ?? null;
      }
    } else if (KNOWN_FLAGS.has(option) && equal < 0) {
      result.keep.push(arg);
      if (['--continue', '-c', '--fork-session'].includes(option)) result.selector = 'unsupported';
      if (option === '-p' || option === '--print') result.print = true;
      // These commands do not start an interactive conversation.
      if (['-h', '--help', '-v', '--version', '--init-only', '--maintenance', '--no-session-persistence'].includes(option)) result.selector = 'unsupported';
    } else { result.parseable = false; result.keep.push(arg); }
  }
  if (selectors > 1) result.selector = 'unsupported';
  return result;
}
export function resolveModel({ argvModel, env, configDir }) {
  if (typeof argvModel === 'string' && argvModel) return argvModel;
  if (typeof env.ANTHROPIC_MODEL === 'string' && env.ANTHROPIC_MODEL) return env.ANTHROPIC_MODEL;
  try { const model = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')).model; return typeof model === 'string' && model ? model : null; }
  catch { return null; }
}
export function isEligibleModel(model) { return typeof model === 'string' && /opus|sonnet/i.test(model) && !/fable/i.test(model); }

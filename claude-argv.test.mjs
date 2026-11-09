import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeArgv, resolveModel, isEligibleModel } from './lib/claude-argv.mjs';

test('Orca launch preserves plugin, permissions and advisor arguments', () => {
  const keep = ['--plugin-dir', '/plugin path', '--dangerously-skip-permissions', '--advisor', 'claude-fable-5-1'];
  assert.deepEqual(parseClaudeArgv([...keep, 'the prompt']), {
    keep, prompt: 'the prompt', sessionId: null, selector: 'none', print: false, model: null, parseable: true,
  });
});
test('session selectors and equals model values are extracted', () => {
  for (const [flag, selector] of [['--resume', 'resume-id'], ['-r', 'resume-id'], ['--session-id', 'session-id']]) {
    for (const args of [[flag, 'abc'], [`${flag}=abc`]]) {
      const parsed = parseClaudeArgv([...args, '--model=claude-sonnet-5-5', 'hi']);
      assert.equal(parsed.selector, selector);
      assert.equal(parsed.sessionId, 'abc');
      assert.equal(parsed.model, 'claude-sonnet-5-5');
      assert.deepEqual(parsed.keep, ['--model=claude-sonnet-5-5']);
      assert.equal(parsed.prompt, 'hi');
      assert.equal(parsed.parseable, true);
    }
  }
});
test('unsupported selectors, unknown options and print fail closed', () => {
  for (const args of [['--continue'], ['-c'], ['--resume'], ['-r'], ['--fork-session'], ['--resume', 'a', '--session-id', 'b']])
    assert.equal(parseClaudeArgv(args).selector, 'unsupported');
  for (const args of [['--brand-new-flag', 'x', 'hi'], ['--model'], ['one', 'two'], ['--advisor='], ['--print=maybe']])
    assert.equal(parseClaudeArgv(args).parseable, false);
  for (const flag of ['-p', '--print']) assert.equal(parseClaudeArgv([flag]).print, true);
});
test('variadic and optional values are not mistaken for a prompt', () => {
  for (const flag of ['--add-dir', '--allowedTools', '--allowed-tools', '--betas', '--disallowedTools', '--disallowed-tools', '--file', '--mcp-config', '--tools']) {
    const args = [flag, 'a', 'b', '--model', 'sonnet', 'prompt'];
    assert.deepEqual(parseClaudeArgv(args).keep, args.slice(0, -1));
    assert.equal(parseClaudeArgv([flag, 'a', 'not a prompt']).prompt, null);
    assert.equal(parseClaudeArgv([flag]).parseable, false);
  }
  for (const flag of ['-d', '--debug', '--cloud', '--from-pr', '--prompt-suggestions', '--remote-control', '--teleport', '-w', '--worktree']) {
    assert.equal(parseClaudeArgv([flag, 'value']).prompt, null);
    assert.equal(parseClaudeArgv([flag, '--model', 'sonnet', 'prompt']).prompt, 'prompt');
  }
  assert.deepEqual(parseClaudeArgv(['--', '-a prompt']).keep, []);
  assert.equal(parseClaudeArgv(['--', '-a prompt']).prompt, '-a prompt');
});
test('model resolution uses argv then environment then settings and excludes Fable', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'overflow-argv-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
  assert.equal(resolveModel({ argvModel: 'opus', env: { ANTHROPIC_MODEL: 'fable' }, configDir: home }), 'opus');
  assert.equal(resolveModel({ env: { ANTHROPIC_MODEL: 'opus' }, configDir: home }), 'opus');
  assert.equal(resolveModel({ env: {}, configDir: home }), 'sonnet');
  fs.writeFileSync(path.join(home, 'settings.json'), 'invalid');
  assert.equal(resolveModel({ env: {}, configDir: home }), null);
  for (const model of ['opus', 'claude-sonnet-5-5', 'claude-opus-5-5[1m]']) assert.equal(isEligibleModel(model), true);
  for (const model of [null, 'fable', 'opus-fable', 'haiku']) assert.equal(isEligibleModel(model), false);
});

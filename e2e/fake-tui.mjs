#!/usr/bin/env node
// Fake paused agent TUI for E2E testing. Prints a Claude-style limit banner
// (default), the captured Claude session-limit screen (--session-limit), Claude
// API-outage fixtures (--outage*), or Gemini limit banner (--gemini), then
// appends anything it receives on stdin to the given file.
// The structural footer mirrors Claude Code's idle input box.
// Usage: node fake-tui.mjs <received-file> <reset-time | --session-limit | --outage mode | --gemini> [value]
import fs from 'node:fs';

const [outFile, mode, timeText] = process.argv.slice(2);
const outageContinuations = [
  '  a server-side issue, usually temporary — try',
  '  again in a moment. If it persists, check',
  '  https://status.claude.com.',
  '  Please retry after the provider recovers.',
];
const printClaudeFooter = () => {
  console.log('✻ Worked for 1m 42s · done 8:57 PM');
  console.log('─'.repeat(55));
  console.log('❯');
  console.log('─'.repeat(55));
  console.log('  [Fable 5.1 ◔ medium]');
  console.log('  Context █░░░ 24%');
  console.log('  Usage   ███░ 78% (resets in 3h 20m)');
  console.log('  2 CLAUDE.md | 15 hooks');
  console.log('  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← …');
};
const printClaudeOutage = (marker, continuationCount, ansi = false) => {
  const payload = 'API Error: 500 Internal server error. This is';
  console.log(ansi ? `\x1b[36m${marker}\x1b[0m \x1b[31m${payload}\x1b[0m` : `${marker}${payload}`);
  outageContinuations.slice(0, continuationCount).forEach((line) => console.log(line));
  printClaudeFooter();
};

if (mode === '--session-limit') {
  [
    "  ⎿  You've hit your session limit · resets 12:30am (America/New_York)",
    '     /upgrade to increase your usage limit.',
    '✻ Baked for 17m 13s · done 9:54 PM',
    '                                                                                        new task? /clear to save 238.6k tokens',
    '─'.repeat(128),
    '❯',
    '─'.repeat(128),
    '  [Fable 5.1 ◑ high] │ GlamBook git:(docs/plan-2e* [+37 -29]) │ floating-wondering-crescent │ ⏱️   4h 52m │ Cost $59.80',
    '  Context ██░░░░░░░░ 23% │ Usage Weekly ████░░░░░░ 39% (resets in 5d 1h)',
    '  2 CLAUDE.md | 1 MCPs | 15 hooks',
    '  ~2026-09-21-plan-2e-automation-engine.md(+37 -29)',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent',
    '  ⧉  plan-2e-automation-engine',
  ].forEach((line) => console.log(line));
} else if (mode === '--gemini') {
  console.log('─'.repeat(60));
  console.log('Usage limit reached for gemini-2.5-pro.');
  console.log(`Access resets at ${timeText}.`);
  console.log('▄'.repeat(60));
  console.log(' *   Type your message or @path/to/file');
  console.log('▀'.repeat(60));
} else {
  console.log('─'.repeat(60));
  const count = Number.isInteger(Number(timeText)) ? Math.max(0, Math.min(4, Number(timeText))) : 0;
  if (mode === '--outage') {
    printClaudeOutage('', count);
  } else if (mode === '--outage-read') {
    printClaudeOutage('⎿  ', count);
  } else if (mode === '--outage-marker') {
    printClaudeOutage('⏺ ', Number.isInteger(Number(timeText)) ? count : 3);
  } else if (mode === '--outage-ansi') {
    printClaudeOutage('⏺', count, true);
  } else if (mode === '--outage-bad-marker') {
    printClaudeOutage('◆ ', 0);
  } else if (mode === '--outage-retry') {
    console.log('⏺ API Error: 500 Internal server error. This is');
    console.log(outageContinuations[0]);
    console.log('Retrying in 5s… (attempt 2/10)');
    printClaudeFooter();
  } else if (mode === '--outage-stale') {
    console.log('⏺ API Error: 500 Internal server error. This is');
    console.log(outageContinuations[0]);
    console.log('⏺ The request recovered, so I continued working.');
    printClaudeFooter();
  } else if (mode === '--outage-shadow') {
    console.log('⏺ API Error: 500 Internal server error. This is');
    outageContinuations.slice(0, 3).forEach((line) => console.log(line));
    console.log('⎿  Tip: inspect API Error: 500 before retrying.');
    printClaudeFooter();
  } else if (mode === '--outage-prose') {
    console.log('I saw "⏺ API Error: 500 Internal server error. This is" in quoted prose.');
    printClaudeFooter();
  } else if (mode === '--outage-log') {
    console.log('2026-09-21T12:00:00Z ⏺ API Error: 500 Internal server error. This is');
    printClaudeFooter();
  } else {
    console.log(`Claude usage limit reached. Your limit will reset at ${mode}.`);
    console.log('> ');
    console.log('? for shortcuts');
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => fs.appendFileSync(outFile, d));

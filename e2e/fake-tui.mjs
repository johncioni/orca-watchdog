#!/usr/bin/env node
// Fake paused agent TUI for E2E testing. Prints a Claude-style limit banner
// (default), Claude API-outage fixtures (--outage*), or Gemini limit banner
// (--gemini), then appends anything it receives on stdin to the given file.
// The structural footer mirrors Claude Code's idle input box.
// Usage: node fake-tui.mjs <received-file> <reset-time | --outage mode> [value]
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

console.log('─'.repeat(60));
if (mode === '--gemini') {
  console.log('Usage limit reached for gemini-2.5-pro.');
  console.log(`Access resets at ${timeText}.`);
  console.log('▄'.repeat(60));
  console.log(' *   Type your message or @path/to/file');
  console.log('▀'.repeat(60));
} else {
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

#!/usr/bin/env node
// Fake paused agent TUI for E2E testing. Prints a Claude-style limit banner
// (default), API-outage banner (--outage), marked/wrapped API-outage banner
// (--outage-marker), or Gemini limit banner (--gemini),
// then appends anything it receives
// on stdin to the given file. The trailing "? for shortcuts" line mirrors
// Claude Code's chrome and satisfies the watchdog's final-block + prompt guard.
// Usage: node fake-tui.mjs <received-file> <reset-time-text e.g. "9:05am" | --outage | --outage-marker | --gemini <time-text>>
import fs from 'node:fs';

const [outFile, mode, timeText] = process.argv.slice(2);
console.log('─'.repeat(60));
if (mode === '--gemini') {
  console.log('Usage limit reached for gemini-2.5-pro.');
  console.log(`Access resets at ${timeText}.`);
  console.log('▄'.repeat(60));
  console.log(' *   Type your message or @path/to/file');
  console.log('▀'.repeat(60));
} else {
  if (mode === '--outage-marker') {
    console.log('⏺ API Error: 500 Internal server error. This is');
    console.log('  a server-side issue, usually temporary — try');
    console.log('  again in a moment. If it persists, check');
    console.log('  https://status.claude.com.');
    console.log('✻ Worked for 1m 42s · done 8:57 PM');
    console.log('─'.repeat(55));
    console.log('❯');
    console.log('─'.repeat(55));
    console.log('  [Fable 5.1 ◔ medium]');
    console.log('  orca-ops git:(johncioni/ops-8-daily-trend-docs)');
    console.log('  swift-wondering-storm │ ⏱️   23h 3m │ Cost $100.95');
    console.log('  Context █░░░ 24%');
    console.log('  Usage   ███░ 78% (resets in 3h 20m)');
    console.log('  2 CLAUDE.md | 15 hooks');
    console.log('  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← …');
  } else {
    if (mode === '--outage') {
      console.log('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
    } else {
      console.log(`Claude usage limit reached. Your limit will reset at ${mode}.`);
    }
    console.log('> ');
    console.log('? for shortcuts');
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => fs.appendFileSync(outFile, d));

#!/usr/bin/env node
// Fake paused agent TUI for E2E testing. Prints a Claude-style limit banner
// (default), API-outage banner (--outage), or Gemini limit banner (--gemini),
// then appends anything it receives
// on stdin to the given file. The trailing "? for shortcuts" line mirrors
// Claude Code's chrome and satisfies the watchdog's final-block + prompt guard.
// Usage: node fake-tui.mjs <received-file> <reset-time-text e.g. "9:05am" | --outage | --gemini <time-text>>
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
  if (mode === '--outage') {
    console.log('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
  } else {
    console.log(`Claude usage limit reached. Your limit will reset at ${mode}.`);
  }
  console.log('> ');
  console.log('? for shortcuts');
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => fs.appendFileSync(outFile, d));

#!/usr/bin/env node
import { runCli, installStdoutGuard } from '../lib/management.mjs';

// A downstream reader that closes the pipe early (e.g. `orca-watchdog logs | head`)
// makes stdout emit an error while a large write is still draining; treat that as a
// clean stop instead of crashing with a stack trace. It is usually EPIPE, but the
// same "reader is gone" event surfaces as ENOTCONN / ECONNRESET / a stream teardown
// in some races (DOG-43). Any other stdout error is surfaced rather than swallowed.
installStdoutGuard(process.stdout, (code) => process.exit(code));

try {
  process.exitCode = await runCli();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = error.exitCode ?? 1;
}

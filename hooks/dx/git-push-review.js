#!/usr/bin/env node
/**
 * Git Push Review Reminder Hook
 *
 * When Claude is about to run `git push`, prints a reminder to stderr
 * encouraging the developer to review changes before pushing.
 *
 * Hook event: PreToolUse (Bash)
 * Exit code: always 0 (advisory only, never blocks)
 *
 * Example settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [
 *       {
 *         "matcher": "Bash",
 *         "hooks": [
 *           {
 *             "type": "command",
 *             "command": "node /path/to/hooks/dx/git-push-review.js"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * }
 */

'use strict';

const MAX_STDIN = 1024 * 1024;
let raw = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) {
    raw += chunk.substring(0, MAX_STDIN - raw.length);
  }
});

process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const cmd = String(input.tool_input?.command || '');

    if (/\bgit\s+push\b/.test(cmd)) {
      process.stderr.write('[Hook] Review changes before push...\n');
      process.stderr.write('[Hook] Continuing with push (remove this hook to add interactive review)\n');
    }
  } catch {
    // Ignore parse errors — pass through
  }

  process.stdout.write(raw);
});

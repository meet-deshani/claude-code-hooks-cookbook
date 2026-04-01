#!/usr/bin/env node
/**
 * Tmux Reminder Hook
 *
 * When Claude is about to run a long-running command (npm install, docker,
 * pytest, etc.) outside of tmux, prints a reminder to stderr suggesting
 * the user run inside tmux for session persistence.
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
 *             "command": "node /path/to/hooks/dx/tmux-reminder.js"
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

    // Only relevant on Unix-like systems, and only when not already in tmux
    if (
      process.platform !== 'win32' &&
      !process.env.TMUX &&
      /(npm (install|test)|pnpm (install|test)|yarn (install|test)?|bun (install|test)|cargo build|make\b|docker\b|pytest|vitest|playwright)/.test(cmd)
    ) {
      process.stderr.write('[Hook] Consider running in tmux for session persistence\n');
      process.stderr.write('[Hook] tmux new -s dev  |  tmux attach -t dev\n');
    }
  } catch {
    // Ignore parse errors — pass through
  }

  process.stdout.write(raw);
});

#!/usr/bin/env node
/**
 * Build Complete Notification Hook
 *
 * Detects when a build command (npm run build, pnpm build, yarn build) is
 * executed and logs a notification to stderr.
 *
 * Hook event: PostToolUse (Bash)
 * Exit code: always 0
 *
 * Example settings.json:
 * {
 *   "hooks": {
 *     "PostToolUse": [
 *       {
 *         "matcher": "Bash",
 *         "hooks": [
 *           {
 *             "type": "command",
 *             "command": "node /path/to/hooks/automation/build-complete.js"
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

    if (/(npm run build|pnpm build|yarn build|bun run build)/.test(cmd)) {
      const exitCode = input.tool_output?.exit_code ?? input.tool_output?.exitCode;
      const status = exitCode === 0 ? 'succeeded' : exitCode != null ? `failed (exit ${exitCode})` : 'completed';
      process.stderr.write(`[Hook] Build ${status}\n`);
    }
  } catch {
    // Ignore parse errors — pass through
  }

  process.stdout.write(raw);
});

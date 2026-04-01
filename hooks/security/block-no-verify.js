#!/usr/bin/env node
/**
 * Block --no-verify Hook
 *
 * Prevents Claude from skipping git hooks by detecting --no-verify or -n
 * flags on git commit/push commands. This ensures pre-commit hooks
 * (linting, tests, etc.) always run.
 *
 * Hook event: PreToolUse (Bash)
 * Exit codes: 0 = allow, 2 = block
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
 *             "command": "node /path/to/hooks/security/block-no-verify.js"
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

    // Match git commit or git push with --no-verify or shorthand -n
    // The -n flag for git commit means --no-verify
    // For git push, --no-verify skips pre-push hooks
    if (/\bgit\s+(commit|push)\b/.test(cmd)) {
      if (/--no-verify\b/.test(cmd)) {
        process.stderr.write(
          'BLOCKED: --no-verify is not allowed. Git hooks must not be skipped. ' +
          'Fix the underlying issue that the hook is catching instead.\n'
        );
        process.exit(2);
        return;
      }

      // Check for -n flag specifically on git commit (not git push, where -n means dry-run)
      if (/\bgit\s+commit\b/.test(cmd) && /\s-[a-zA-Z]*n/.test(cmd)) {
        // More precise check: -n as a standalone flag or combined with other short flags
        // Avoid false positives from filenames or message text containing -n
        const parts = cmd.split(/\s+/);
        for (const part of parts) {
          // Match short flag groups like -n, -an, -mn, etc. (but not after -m "message")
          if (/^-[a-zA-Z]*n[a-zA-Z]*$/.test(part) && !part.includes('m')) {
            process.stderr.write(
              'BLOCKED: The -n flag (--no-verify) is not allowed on git commit. ' +
              'Git hooks must not be skipped.\n'
            );
            process.exit(2);
            return;
          }
        }
      }
    }
  } catch {
    // Parse error — allow through
  }

  process.stdout.write(raw);
});

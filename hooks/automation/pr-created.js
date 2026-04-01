#!/usr/bin/env node
/**
 * PR Created Notification Hook
 *
 * Detects when `gh pr create` is run and extracts the PR URL from the
 * command output. Prints the PR URL and a review command to stderr.
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
 *             "command": "node /path/to/hooks/automation/pr-created.js"
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

    if (/\bgh\s+pr\s+create\b/.test(cmd)) {
      const out = String(input.tool_output?.output || '');
      const match = out.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
      if (match) {
        const prUrl = match[0];
        const repo = prUrl.replace(/https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/, '$1');
        const prNum = prUrl.replace(/.+\/pull\/(\d+)/, '$1');
        process.stderr.write(`[Hook] PR created: ${prUrl}\n`);
        process.stderr.write(`[Hook] To review: gh pr review ${prNum} --repo ${repo}\n`);
      }
    }
  } catch {
    // Ignore parse errors — pass through
  }

  process.stdout.write(raw);
});

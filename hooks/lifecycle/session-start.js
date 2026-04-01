#!/usr/bin/env node
/**
 * Session Start Hook
 *
 * Runs when a new Claude Code session starts. Loads the most recent session
 * summary from ~/.claude/session-data/ and injects it into Claude's context
 * via stdout, providing cross-session continuity.
 *
 * Hook event: SessionStart
 * Exit code: always 0
 *
 * Example settings.json:
 * {
 *   "hooks": {
 *     "SessionStart": [
 *       {
 *         "matcher": "",
 *         "hooks": [
 *           {
 *             "type": "command",
 *             "command": "node /path/to/hooks/lifecycle/session-start.js"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSION_DIR = path.join(os.homedir(), '.claude', 'session-data');

/**
 * Find session files matching a glob-like pattern, sorted by mtime descending.
 */
function findRecentSessions(dir, maxAgeDays) {
  if (!fs.existsSync(dir)) return [];

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const entries = [];

  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('-session.tmp')) continue;
      const fullPath = path.join(dir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs >= cutoff) {
          entries.push({ path: fullPath, mtime: stat.mtimeMs });
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    return [];
  }

  return entries.sort((a, b) => b.mtime - a.mtime);
}

async function main() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const additionalContextParts = [];

  // Load recent sessions (last 7 days)
  const recentSessions = findRecentSessions(SESSION_DIR, 7);

  if (recentSessions.length > 0) {
    const latest = recentSessions[0];
    process.stderr.write(`[SessionStart] Found ${recentSessions.length} recent session(s)\n`);
    process.stderr.write(`[SessionStart] Latest: ${latest.path}\n`);

    try {
      const content = fs.readFileSync(latest.path, 'utf8');
      if (content && !content.includes('[Session context goes here]')) {
        additionalContextParts.push(`Previous session summary:\n${content}`);
      }
    } catch {
      // Skip unreadable session
    }
  }

  // Output context for Claude
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: additionalContextParts.join('\n\n'),
    },
  });

  process.stdout.write(payload);
}

main().catch(err => {
  process.stderr.write(`[SessionStart] Error: ${err.message}\n`);
  process.exitCode = 0;
});

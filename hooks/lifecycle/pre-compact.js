#!/usr/bin/env node
/**
 * Pre-Compact Hook
 *
 * Runs before Claude compacts (summarizes) its context window. Logs the
 * compaction event to a file and annotates the active session file so you
 * can see when context was compressed during a session.
 *
 * Hook event: PreCompact
 * Exit code: always 0
 *
 * Example settings.json:
 * {
 *   "hooks": {
 *     "PreCompact": [
 *       {
 *         "matcher": "",
 *         "hooks": [
 *           {
 *             "type": "command",
 *             "command": "node /path/to/hooks/lifecycle/pre-compact.js"
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

async function main() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const timestamp = new Date().toISOString();
  const timeStr = new Date().toTimeString().slice(0, 5);

  // Log compaction event
  const compactionLog = path.join(SESSION_DIR, 'compaction-log.txt');
  fs.appendFileSync(compactionLog, `[${timestamp}] Context compaction triggered\n`);

  // If there is an active session file, annotate it
  try {
    const files = fs.readdirSync(SESSION_DIR)
      .filter(f => f.endsWith('-session.tmp'))
      .map(f => ({
        name: f,
        path: path.join(SESSION_DIR, f),
        mtime: fs.statSync(path.join(SESSION_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > 0) {
      fs.appendFileSync(
        files[0].path,
        `\n---\n**[Compaction occurred at ${timeStr}]** - Context was summarized\n`
      );
    }
  } catch {
    // Non-blocking
  }

  process.stderr.write('[PreCompact] State saved before compaction\n');
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[PreCompact] Error: ${err.message}\n`);
  process.exit(0);
});

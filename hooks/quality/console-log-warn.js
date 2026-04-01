#!/usr/bin/env node
/**
 * Console Log Warning Hook
 *
 * Checks git-modified JS/TS files for leftover console.log statements and
 * warns the developer. Does not block — just emits warnings to stderr.
 *
 * Hook event: Stop (runs after each Claude response)
 * Exit code: always 0
 *
 * Exclusions: test files, config files, __tests__, __mocks__, scripts/
 *
 * Example settings.json:
 * {
 *   "hooks": {
 *     "Stop": [
 *       {
 *         "matcher": "",
 *         "hooks": [
 *           {
 *             "type": "command",
 *             "command": "node /path/to/hooks/quality/console-log-warn.js"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * }
 */

'use strict';

const fs = require('fs');
const { execSync } = require('child_process');

const EXCLUDED_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.config\.[jt]s$/,
  /scripts\//,
  /__tests__\//,
  /__mocks__\//,
];

const MAX_STDIN = 1024 * 1024;
let data = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (data.length < MAX_STDIN) {
    data += chunk.substring(0, MAX_STDIN - data.length);
  }
});

process.stdin.on('end', () => {
  try {
    // Check if we are in a git repo
    try {
      execSync('git rev-parse --git-dir', { stdio: 'pipe', encoding: 'utf8' });
    } catch {
      process.stdout.write(data);
      process.exit(0);
      return;
    }

    // Get modified JS/TS files from git
    let files = [];
    try {
      const output = execSync(
        'git diff --name-only --diff-filter=ACMR HEAD 2>/dev/null || git diff --name-only --diff-filter=ACMR',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      files = output
        .split('\n')
        .filter(f => /\.[jt]sx?$/.test(f))
        .filter(f => fs.existsSync(f))
        .filter(f => !EXCLUDED_PATTERNS.some(pattern => pattern.test(f)));
    } catch {
      // No git diff available
    }

    let hasConsole = false;
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        if (content.includes('console.log')) {
          process.stderr.write(`[Hook] WARNING: console.log found in ${file}\n`);
          hasConsole = true;
        }
      } catch {
        // File read error — skip
      }
    }

    if (hasConsole) {
      process.stderr.write('[Hook] Remove console.log statements before committing\n');
    }
  } catch (err) {
    process.stderr.write(`[Hook] console-log-warn error: ${err.message}\n`);
  }

  process.stdout.write(data);
  process.exit(0);
});

#!/usr/bin/env node
/**
 * TypeScript Check After Edit Hook
 *
 * Runs after the Edit tool is used on a .ts/.tsx file. Walks up from the
 * file's directory to find the nearest tsconfig.json, then runs tsc --noEmit
 * and reports only errors related to the edited file.
 *
 * Hook event: PostToolUse (Edit)
 * Exit code: always 0 (warnings only, never blocks)
 *
 * Example settings.json:
 * {
 *   "hooks": {
 *     "PostToolUse": [
 *       {
 *         "matcher": "Edit",
 *         "hooks": [
 *           {
 *             "type": "command",
 *             "command": "node /path/to/hooks/quality/post-edit-typecheck.js"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * }
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
    const input = JSON.parse(data);
    const filePath = input.tool_input?.file_path;

    if (filePath && /\.(ts|tsx)$/.test(filePath)) {
      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) {
        process.stdout.write(data);
        process.exit(0);
        return;
      }

      // Find nearest tsconfig.json by walking up (max 20 levels)
      let dir = path.dirname(resolvedPath);
      const root = path.parse(dir).root;
      let depth = 0;

      while (dir !== root && depth < 20) {
        if (fs.existsSync(path.join(dir, 'tsconfig.json'))) break;
        dir = path.dirname(dir);
        depth++;
      }

      if (fs.existsSync(path.join(dir, 'tsconfig.json'))) {
        try {
          const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
          execFileSync(npxBin, ['tsc', '--noEmit', '--pretty', 'false'], {
            cwd: dir,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30000,
          });
        } catch (err) {
          // tsc exits non-zero when there are errors — filter to edited file
          const output = (err.stdout || '') + (err.stderr || '');
          const relPath = path.relative(dir, resolvedPath);
          const candidates = new Set([filePath, resolvedPath, relPath]);
          const relevantLines = output
            .split('\n')
            .filter(line => {
              for (const candidate of candidates) {
                if (line.includes(candidate)) return true;
              }
              return false;
            })
            .slice(0, 10);

          if (relevantLines.length > 0) {
            process.stderr.write(
              `[Hook] TypeScript errors in ${path.basename(filePath)}:\n`
            );
            for (const line of relevantLines) {
              process.stderr.write(line + '\n');
            }
          }
        }
      }
    }
  } catch {
    // Invalid input — pass through
  }

  process.stdout.write(data);
  process.exit(0);
});

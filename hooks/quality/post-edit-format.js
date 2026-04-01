#!/usr/bin/env node
/**
 * Auto-Format After Edit Hook
 *
 * Runs after the Edit tool is used on a JS/TS file. Auto-detects the project
 * formatter (Biome or Prettier) by walking up from the file to find config
 * files, then formats accordingly.
 *
 * - Biome: runs `check --write` (format + lint in one pass)
 * - Prettier: runs `--write`
 *
 * Prefers local node_modules/.bin binary over npx for speed.
 * Fails silently if no formatter is found or installed.
 *
 * Hook event: PostToolUse (Edit)
 * Exit code: always 0
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
 *             "command": "node /path/to/hooks/quality/post-edit-format.js"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * }
 */

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Shell metacharacters that cmd.exe interprets
const UNSAFE_PATH_CHARS = /[&|<>^%!]/;

const BIOME_CONFIGS = ['biome.json', 'biome.jsonc'];
const PRETTIER_CONFIGS = [
  '.prettierrc', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.json',
  '.prettierrc.yml', '.prettierrc.yaml', 'prettier.config.js',
  'prettier.config.cjs', 'prettier.config.mjs',
];

/**
 * Walk up from startDir to find a directory containing package.json or a
 * formatter config. Returns the project root or startDir as fallback.
 */
function findProjectRoot(startDir) {
  let dir = startDir;
  const root = path.parse(dir).root;
  let depth = 0;

  while (dir !== root && depth < 20) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
    depth++;
  }

  return startDir;
}

/**
 * Detect which formatter is configured in the project root.
 * Returns 'biome', 'prettier', or null.
 */
function detectFormatter(projectRoot) {
  for (const config of BIOME_CONFIGS) {
    if (fs.existsSync(path.join(projectRoot, config))) return 'biome';
  }
  for (const config of PRETTIER_CONFIGS) {
    if (fs.existsSync(path.join(projectRoot, config))) return 'prettier';
  }
  return null;
}

/**
 * Resolve the formatter binary path. Prefers local node_modules/.bin.
 * Returns { bin, prefix } or null if not found.
 */
function resolveFormatterBin(projectRoot, formatter) {
  const binName = formatter === 'biome' ? 'biome' : 'prettier';
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const localBin = path.join(projectRoot, 'node_modules', '.bin', binName + ext);

  if (fs.existsSync(localBin)) {
    return { bin: localBin, prefix: [] };
  }

  // Fall back to npx
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return { bin: npxBin, prefix: [binName] };
}

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

    if (filePath && /\.(ts|tsx|js|jsx)$/.test(filePath)) {
      try {
        const resolvedFilePath = path.resolve(filePath);
        const projectRoot = findProjectRoot(path.dirname(resolvedFilePath));
        const formatter = detectFormatter(projectRoot);
        if (!formatter) {
          process.stdout.write(data);
          process.exit(0);
          return;
        }

        const resolved = resolveFormatterBin(projectRoot, formatter);
        if (!resolved) {
          process.stdout.write(data);
          process.exit(0);
          return;
        }

        const args = formatter === 'biome'
          ? [...resolved.prefix, 'check', '--write', resolvedFilePath]
          : [...resolved.prefix, '--write', resolvedFilePath];

        if (process.platform === 'win32' && resolved.bin.endsWith('.cmd')) {
          if (UNSAFE_PATH_CHARS.test(resolvedFilePath)) {
            throw new Error('File path contains unsafe shell characters');
          }
          spawnSync(resolved.bin, args, {
            cwd: projectRoot,
            shell: true,
            stdio: 'pipe',
            timeout: 15000,
          });
        } else {
          execFileSync(resolved.bin, args, {
            cwd: projectRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 15000,
          });
        }
      } catch {
        // Formatter not installed or failed — non-blocking
      }
    }
  } catch {
    // Invalid input — pass through
  }

  process.stdout.write(data);
  process.exit(0);
});

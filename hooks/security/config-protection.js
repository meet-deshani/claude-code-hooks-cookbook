#!/usr/bin/env node
/**
 * Config Protection Hook
 *
 * Blocks modifications to linter/formatter config files. AI agents frequently
 * modify these to make checks pass instead of fixing the actual code. This
 * hook steers the agent back to fixing the source.
 *
 * Hook event: PreToolUse (Edit, Write)
 * Exit codes: 0 = allow, 2 = block
 *
 * Example settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [
 *       {
 *         "matcher": "Edit|Write",
 *         "hooks": [
 *           {
 *             "type": "command",
 *             "command": "node /path/to/hooks/security/config-protection.js"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * }
 */

'use strict';

const path = require('path');

const MAX_STDIN = 1024 * 1024;

const PROTECTED_FILES = new Set([
  // ESLint (legacy + v9 flat config, JS/TS/MJS/CJS)
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  // Prettier (all config variants including ESM)
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  // Biome
  'biome.json',
  'biome.jsonc',
  // Ruff (Python)
  '.ruff.toml',
  'ruff.toml',
  // Shell / Style / Markdown
  '.shellcheckrc',
  '.stylelintrc',
  '.stylelintrc.json',
  '.stylelintrc.yml',
  '.markdownlint.json',
  '.markdownlint.yaml',
  '.markdownlintrc',
]);

let raw = '';
let truncated = false;

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) {
    const remaining = MAX_STDIN - raw.length;
    raw += chunk.substring(0, remaining);
    if (chunk.length > remaining) truncated = true;
  } else {
    truncated = true;
  }
});

process.stdin.on('end', () => {
  if (truncated) {
    process.stderr.write(
      `BLOCKED: Hook input exceeded ${MAX_STDIN} bytes. ` +
      'Refusing to bypass config-protection on a truncated payload. ' +
      'Retry with a smaller edit or disable the config-protection hook temporarily.\n'
    );
    process.exit(2);
    return;
  }

  let input;
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    // Invalid JSON — allow through
    process.stdout.write(raw);
    process.exit(0);
    return;
  }

  const filePath = input?.tool_input?.file_path || input?.tool_input?.file || '';
  if (!filePath) {
    process.stdout.write(raw);
    process.exit(0);
    return;
  }

  const basename = path.basename(filePath);
  if (PROTECTED_FILES.has(basename)) {
    process.stderr.write(
      `BLOCKED: Modifying ${basename} is not allowed. ` +
      'Fix the source code to satisfy linter/formatter rules instead of ' +
      'weakening the config. If this is a legitimate config change, ' +
      'disable the config-protection hook temporarily.\n'
    );
    process.exit(2);
    return;
  }

  process.stdout.write(raw);
});

#!/usr/bin/env node
/**
 * Quality Gate Hook
 *
 * Runs lightweight quality checks after file edits based on file extension:
 * - JS/TS/JSON/MD: Biome or Prettier (auto-detected from project config)
 * - Go: gofmt
 * - Python: ruff format
 *
 * For JS/TS files with Biome, this hook is intentionally skipped because
 * post-edit-format.js already runs `biome check --write`. This hook still
 * handles .json/.md files for Biome, and all Prettier/Go/Python checks.
 *
 * Hook event: PostToolUse (Edit, Write)
 * Exit code: always 0 (warnings only)
 *
 * Environment variables:
 *   QUALITY_GATE_FIX    - Set to "true" to auto-fix issues (default: check only)
 *   QUALITY_GATE_STRICT - Set to "true" to log warnings on failures
 *
 * Example settings.json:
 * {
 *   "hooks": {
 *     "PostToolUse": [
 *       {
 *         "matcher": "Edit|Write",
 *         "hooks": [
 *           {
 *             "type": "command",
 *             "command": "node /path/to/hooks/quality/quality-gate.js"
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
const { spawnSync } = require('child_process');

// --- Formatter detection (inline, no external deps) ---

const BIOME_CONFIGS = ['biome.json', 'biome.jsonc'];
const PRETTIER_CONFIGS = [
  '.prettierrc', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.json',
  '.prettierrc.yml', '.prettierrc.yaml', 'prettier.config.js',
  'prettier.config.cjs', 'prettier.config.mjs',
];

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

function detectFormatter(projectRoot) {
  for (const c of BIOME_CONFIGS) {
    if (fs.existsSync(path.join(projectRoot, c))) return 'biome';
  }
  for (const c of PRETTIER_CONFIGS) {
    if (fs.existsSync(path.join(projectRoot, c))) return 'prettier';
  }
  return null;
}

function resolveFormatterBin(projectRoot, formatter) {
  const binName = formatter === 'biome' ? 'biome' : 'prettier';
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const localBin = path.join(projectRoot, 'node_modules', '.bin', binName + ext);
  if (fs.existsSync(localBin)) return { bin: localBin, prefix: [] };
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return { bin: npxBin, prefix: [binName] };
}

// --- Core logic ---

function exec(command, args, cwd = process.cwd()) {
  return spawnSync(command, args, {
    cwd, encoding: 'utf8', env: process.env, timeout: 15000,
  });
}

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

function maybeRunQualityGate(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;

  filePath = path.resolve(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const fix = String(process.env.QUALITY_GATE_FIX || '').toLowerCase() === 'true';
  const strict = String(process.env.QUALITY_GATE_STRICT || '').toLowerCase() === 'true';

  if (['.ts', '.tsx', '.js', '.jsx', '.json', '.md'].includes(ext)) {
    const projectRoot = findProjectRoot(path.dirname(filePath));
    const formatter = detectFormatter(projectRoot);

    if (formatter === 'biome') {
      // JS/TS already handled by post-edit-format via `biome check --write`
      if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return;

      const resolved = resolveFormatterBin(projectRoot, 'biome');
      if (!resolved) return;
      const args = [...resolved.prefix, 'check', filePath];
      if (fix) args.push('--write');
      const result = exec(resolved.bin, args, projectRoot);
      if (result.status !== 0 && strict) log(`[QualityGate] Biome check failed for ${filePath}`);
      return;
    }

    if (formatter === 'prettier') {
      const resolved = resolveFormatterBin(projectRoot, 'prettier');
      if (!resolved) return;
      const args = [...resolved.prefix, fix ? '--write' : '--check', filePath];
      const result = exec(resolved.bin, args, projectRoot);
      if (result.status !== 0 && strict) log(`[QualityGate] Prettier check failed for ${filePath}`);
      return;
    }

    return; // No formatter configured
  }

  if (ext === '.go') {
    if (fix) {
      const r = exec('gofmt', ['-w', filePath]);
      if (r.status !== 0 && strict) log(`[QualityGate] gofmt failed for ${filePath}`);
    } else if (strict) {
      const r = exec('gofmt', ['-l', filePath]);
      if (r.status !== 0 || (r.stdout && r.stdout.trim())) {
        log(`[QualityGate] gofmt check failed for ${filePath}`);
      }
    }
    return;
  }

  if (ext === '.py') {
    const args = ['format'];
    if (!fix) args.push('--check');
    args.push(filePath);
    const r = exec('ruff', args);
    if (r.status !== 0 && strict) log(`[QualityGate] Ruff check failed for ${filePath}`);
  }
}

// --- stdin entry point ---

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
    maybeRunQualityGate(String(input.tool_input?.file_path || ''));
  } catch {
    // Ignore parse errors
  }
  process.stdout.write(raw);
});

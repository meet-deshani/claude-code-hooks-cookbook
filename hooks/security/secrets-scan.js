#!/usr/bin/env node
/**
 * Secrets Scan Hook
 *
 * Checks file content being written for common secret patterns (API keys,
 * tokens, passwords, private keys) and blocks the write with exit code 2.
 *
 * Hook event: PreToolUse (Write, Edit)
 * Exit codes: 0 = allow, 2 = block (secret detected)
 *
 * This hook inspects the tool_input content for patterns that commonly
 * indicate hardcoded secrets. It allows references to environment variables
 * (process.env.*, os.environ, etc.) since those are the correct approach.
 *
 * Example settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [
 *       {
 *         "matcher": "Write|Edit",
 *         "hooks": [
 *           {
 *             "type": "command",
 *             "command": "node /path/to/hooks/security/secrets-scan.js"
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

// Files where secrets are expected (env templates, lock files, etc.)
const EXCLUDED_FILES = new Set([
  '.env.example',
  '.env.template',
  '.env.sample',
  '.env.local.example',
]);

// Patterns that indicate a hardcoded secret (not an env var reference)
const SECRET_PATTERNS = [
  {
    name: 'AWS Access Key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: 'AWS Secret Key',
    // 40-char base64 string after common assignment patterns
    pattern: /(?:aws_secret_access_key|AWS_SECRET)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}\b/i,
  },
  {
    name: 'Generic API Key assignment',
    // Matches: api_key = "sk-...", apiKey: "key_...", API_KEY="..."
    // Must be an actual value, not an env var reference
    pattern: /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key)\s*[=:]\s*['"][a-zA-Z0-9_\-./+=]{20,}['"]/i,
  },
  {
    name: 'Private Key Block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: 'GitHub Token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/,
  },
  {
    name: 'Slack Token',
    pattern: /\bxox[bpors]-[A-Za-z0-9\-]{10,}\b/,
  },
  {
    name: 'Generic Password Assignment',
    // Matches: password = "actualpassword", PASSWORD: "secret123"
    // But not: password = process.env.PASSWORD or password = os.environ[...]
    pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"][^'"]{8,}['"]/i,
  },
  {
    name: 'Database Connection String with Password',
    pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^:]+:[^@\s]{8,}@/i,
  },
  {
    name: 'Stripe Key',
    pattern: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}\b/,
  },
  {
    name: 'SendGrid Key',
    pattern: /\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b/,
  },
  {
    name: 'Twilio Auth Token',
    pattern: /\b(?:AC|SK)[a-f0-9]{32}\b/,
  },
];

// Patterns that indicate the value is an env var reference (safe)
const ENV_VAR_PATTERNS = [
  /process\.env\./,
  /os\.environ/,
  /os\.getenv/,
  /\$\{[A-Z_]+\}/,
  /\$[A-Z_]+/,
  /env\(['"][A-Z_]+['"]\)/,
  /getenv\(/,
  /Environment\.GetEnvironmentVariable/,
];

function isEnvVarReference(line) {
  return ENV_VAR_PATTERNS.some(p => p.test(line));
}

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
    const filePath = input.tool_input?.file_path || input.tool_input?.file || '';
    const content = input.tool_input?.content
      || input.tool_input?.new_string
      || input.tool_input?.text
      || '';

    if (!content || !filePath) {
      process.stdout.write(raw);
      process.exit(0);
      return;
    }

    // Skip excluded files
    const basename = path.basename(filePath);
    if (EXCLUDED_FILES.has(basename)) {
      process.stdout.write(raw);
      process.exit(0);
      return;
    }

    // Skip .env files themselves (they are expected to contain secrets)
    if (/^\.env(\..+)?$/.test(basename) && !basename.includes('example') && !basename.includes('template')) {
      process.stdout.write(raw);
      process.exit(0);
      return;
    }

    const findings = [];

    for (const { name, pattern } of SECRET_PATTERNS) {
      if (!pattern.test(content)) continue;

      // Check each matching line — if it is an env var reference, allow it
      const lines = content.split('\n');
      for (const line of lines) {
        if (pattern.test(line) && !isEnvVarReference(line)) {
          findings.push(name);
          break; // One finding per pattern is enough
        }
      }
    }

    if (findings.length > 0) {
      process.stderr.write(
        `BLOCKED: Potential hardcoded secret(s) detected in ${basename}:\n` +
        findings.map(f => `  - ${f}`).join('\n') + '\n\n' +
        'Use environment variables instead of hardcoding secrets.\n' +
        'If this is a false positive, review the content and disable this hook temporarily.\n'
      );
      process.exit(2);
      return;
    }
  } catch {
    // Parse error — allow through
  }

  process.stdout.write(raw);
});

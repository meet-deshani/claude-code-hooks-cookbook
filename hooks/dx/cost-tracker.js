#!/usr/bin/env node
/**
 * Cost Tracker Hook
 *
 * Appends lightweight session usage metrics to ~/.claude/metrics/costs.jsonl
 * after each Claude response. Tracks input/output tokens and estimates USD
 * cost based on the model used.
 *
 * Hook event: Stop
 * Exit code: always 0
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
 *             "command": "node /path/to/hooks/dx/cost-tracker.js"
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

const MAX_STDIN = 1024 * 1024;
let raw = '';

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function estimateCost(model, inputTokens, outputTokens) {
  // Approximate per-1M-token blended rates (conservative defaults)
  const table = {
    'haiku': { in: 0.8, out: 4.0 },
    'sonnet': { in: 3.0, out: 15.0 },
    'opus': { in: 15.0, out: 75.0 },
  };

  const normalized = String(model || '').toLowerCase();
  let rates = table.sonnet; // default
  if (normalized.includes('haiku')) rates = table.haiku;
  if (normalized.includes('opus')) rates = table.opus;

  const cost = (inputTokens / 1_000_000) * rates.in + (outputTokens / 1_000_000) * rates.out;
  return Math.round(cost * 1e6) / 1e6;
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) {
    raw += chunk.substring(0, MAX_STDIN - raw.length);
  }
});

process.stdin.on('end', () => {
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};
    const usage = input.usage || input.token_usage || {};
    const inputTokens = toNumber(usage.input_tokens || usage.prompt_tokens || 0);
    const outputTokens = toNumber(usage.output_tokens || usage.completion_tokens || 0);

    const model = String(input.model || process.env.CLAUDE_MODEL || 'unknown');
    const sessionId = String(process.env.CLAUDE_SESSION_ID || 'default');

    const metricsDir = path.join(os.homedir(), '.claude', 'metrics');
    fs.mkdirSync(metricsDir, { recursive: true });

    const row = {
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: estimateCost(model, inputTokens, outputTokens),
    };

    fs.appendFileSync(
      path.join(metricsDir, 'costs.jsonl'),
      JSON.stringify(row) + '\n'
    );
  } catch {
    // Keep hook non-blocking
  }

  process.stdout.write(raw);
});

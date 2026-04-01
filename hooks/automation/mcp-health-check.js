#!/usr/bin/env node
/**
 * MCP Health Check Hook
 *
 * Probes MCP (Model Context Protocol) server health before tool execution
 * and handles post-failure recovery. Persists health state to a JSON file
 * so status survives context compaction.
 *
 * Features:
 * - Pre-flight health probes for HTTP and stdio MCP servers
 * - Exponential backoff for unhealthy servers
 * - Optional reconnect commands per server
 * - Post-failure detection and auto-recovery
 *
 * Hook events:
 * - PreToolUse: probe server health before MCP tool execution
 * - PostToolUseFailure: mark servers unhealthy, attempt reconnect
 *
 * Exit codes: 0 = allow, 2 = block (server unhealthy)
 *
 * Environment variables:
 *   MCP_HEALTH_STATE_PATH     - Path to health state JSON (default: ~/.claude/mcp-health-cache.json)
 *   MCP_HEALTH_TTL_MS         - How long a healthy check is valid (default: 120000)
 *   MCP_HEALTH_TIMEOUT_MS     - Probe timeout (default: 5000)
 *   MCP_HEALTH_BACKOFF_MS     - Base backoff for unhealthy servers (default: 30000)
 *   MCP_HEALTH_FAIL_OPEN      - Set to "true" to allow calls even when unhealthy
 *   MCP_RECONNECT_COMMAND     - Global reconnect command (use {server} placeholder)
 *   MCP_RECONNECT_<SERVER>    - Per-server reconnect command
 *   MCP_CONFIG_PATH           - Colon-separated list of config file paths
 *   CLAUDE_HOOK_EVENT_NAME    - Set by Claude Code (PreToolUse or PostToolUseFailure)
 *
 * Example settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [
 *       {
 *         "matcher": "mcp__",
 *         "hooks": [
 *           {
 *             "type": "command",
 *             "command": "node /path/to/hooks/automation/mcp-health-check.js"
 *           }
 *         ]
 *       }
 *     ],
 *     "PostToolUseFailure": [
 *       {
 *         "matcher": "mcp__",
 *         "hooks": [
 *           {
 *             "type": "command",
 *             "command": "node /path/to/hooks/automation/mcp-health-check.js"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * }
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const MAX_STDIN = 1024 * 1024;
const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const HEALTHY_HTTP_CODES = new Set([200, 201, 202, 204, 301, 302, 303, 304, 307, 308, 405]);
const RECONNECT_STATUS_CODES = new Set([401, 403, 429, 503]);
const FAILURE_PATTERNS = [
  { code: 401, pattern: /\b401\b|unauthori[sz]ed|auth(?:entication)?\s+(?:failed|expired|invalid)/i },
  { code: 403, pattern: /\b403\b|forbidden|permission denied/i },
  { code: 429, pattern: /\b429\b|rate limit|too many requests/i },
  { code: 503, pattern: /\b503\b|service unavailable|overloaded|temporarily unavailable/i },
  { code: 'transport', pattern: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timed? out|socket hang up|connection (?:failed|lost|reset|closed)/i },
];

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stateFilePath() {
  if (process.env.MCP_HEALTH_STATE_PATH) {
    return path.resolve(process.env.MCP_HEALTH_STATE_PATH);
  }
  return path.join(os.homedir(), '.claude', 'mcp-health-cache.json');
}

function configPaths() {
  if (process.env.MCP_CONFIG_PATH) {
    return process.env.MCP_CONFIG_PATH
      .split(path.delimiter)
      .map(e => e.trim())
      .filter(Boolean)
      .map(e => path.resolve(e));
  }

  return [
    path.join(process.cwd(), '.claude.json'),
    path.join(process.cwd(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadState(filePath) {
  const state = readJsonFile(filePath);
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { version: 1, servers: {} };
  }
  if (!state.servers || typeof state.servers !== 'object') state.servers = {};
  return state;
}

function saveState(filePath, state) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  } catch {
    // Non-blocking
  }
}

function readRawStdin() {
  return new Promise(resolve => {
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
    process.stdin.on('end', () => resolve({ raw, truncated }));
    process.stdin.on('error', () => resolve({ raw, truncated }));
  });
}

function safeParse(raw) {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function extractMcpTarget(input) {
  const toolName = String(input.tool_name || input.name || '');
  const explicitServer = input.server || input.mcp_server
    || input.tool_input?.server || input.tool_input?.mcp_server || null;

  if (explicitServer) {
    return { server: String(explicitServer), tool: toolName };
  }

  if (!toolName.startsWith('mcp__')) return null;

  const segments = toolName.slice(5).split('__');
  if (segments.length < 2 || !segments[0]) return null;

  return { server: segments[0], tool: segments.slice(1).join('__') };
}

function resolveServerConfig(serverName) {
  for (const filePath of configPaths()) {
    const data = readJsonFile(filePath);
    const server = data?.mcpServers?.[serverName] || data?.mcp_servers?.[serverName] || null;
    if (server && typeof server === 'object' && !Array.isArray(server)) {
      return { config: server, source: filePath };
    }
  }
  return null;
}

function markHealthy(state, serverName, now, details = {}) {
  state.servers[serverName] = {
    status: 'healthy',
    checkedAt: now,
    expiresAt: now + envNumber('MCP_HEALTH_TTL_MS', DEFAULT_TTL_MS),
    failureCount: 0,
    lastError: null,
    nextRetryAt: now,
    lastRestoredAt: now,
    ...details,
  };
}

function markUnhealthy(state, serverName, now, failureCode, errorMessage) {
  const previous = state.servers[serverName] || {};
  const failureCount = Number(previous.failureCount || 0) + 1;
  const backoffBase = envNumber('MCP_HEALTH_BACKOFF_MS', DEFAULT_BACKOFF_MS);
  const nextRetryDelay = Math.min(backoffBase * (2 ** Math.max(failureCount - 1, 0)), MAX_BACKOFF_MS);

  state.servers[serverName] = {
    status: 'unhealthy',
    checkedAt: now,
    expiresAt: now,
    failureCount,
    lastError: errorMessage || null,
    lastFailureCode: failureCode || null,
    nextRetryAt: now + nextRetryDelay,
    lastRestoredAt: previous.lastRestoredAt || null,
  };
}

function failureSummary(input) {
  const output = input.tool_output;
  return [
    typeof input.error === 'string' ? input.error : '',
    typeof input.message === 'string' ? input.message : '',
    typeof output === 'string' ? output : '',
    typeof output?.output === 'string' ? output.output : '',
    typeof output?.stderr === 'string' ? output.stderr : '',
  ].filter(Boolean).join('\n');
}

function detectFailureCode(text) {
  for (const entry of FAILURE_PATTERNS) {
    if (entry.pattern.test(String(text || ''))) return entry.code;
  }
  return null;
}

function requestHttp(urlString, headers, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const url = new URL(urlString);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request(url, { method: 'GET', headers }, res => {
      if (settled) return;
      settled = true;
      res.resume();
      resolve({ ok: HEALTHY_HTTP_CODES.has(res.statusCode), statusCode: res.statusCode, reason: `HTTP ${res.statusCode}` });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', error => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, statusCode: null, reason: error.message });
    });
    req.end();
  });
}

function probeCommandServer(serverName, config) {
  return new Promise(resolve => {
    const timeoutMs = envNumber('MCP_HEALTH_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    const mergedEnv = { ...process.env, ...(config.env || {}) };
    let done = false;

    function finish(result) {
      if (done) return;
      done = true;
      resolve(result);
    }

    let child;
    try {
      child = spawn(config.command, Array.isArray(config.args) ? config.args.map(String) : [], {
        env: mergedEnv, cwd: process.cwd(), stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch (error) {
      return finish({ ok: false, statusCode: null, reason: error.message });
    }

    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += String(chunk).slice(0, 4000 - stderr.length); });
    child.on('error', error => finish({ ok: false, statusCode: null, reason: error.message }));
    child.on('exit', (code, signal) => finish({ ok: false, statusCode: code, reason: stderr.trim() || `process exited (${signal || code || 'unknown'})` }));

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 200).unref?.();
      finish({ ok: true, statusCode: null, reason: `${serverName} accepted a new stdio process` });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

async function probeServer(serverName, resolvedConfig) {
  const config = resolvedConfig.config;
  const timeoutMs = envNumber('MCP_HEALTH_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);

  if (config.type === 'http' || config.url) {
    const result = await requestHttp(config.url, config.headers || {}, timeoutMs);
    return { ok: result.ok, failureCode: RECONNECT_STATUS_CODES.has(result.statusCode) ? result.statusCode : null, reason: result.reason };
  }

  if (config.command) {
    const result = await probeCommandServer(serverName, config);
    return { ok: result.ok, failureCode: RECONNECT_STATUS_CODES.has(result.statusCode) ? result.statusCode : null, reason: result.reason };
  }

  return { ok: false, failureCode: null, reason: 'unsupported MCP server config' };
}

function reconnectCommand(serverName) {
  const key = `MCP_RECONNECT_${String(serverName).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const command = process.env[key] || process.env.MCP_RECONNECT_COMMAND || '';
  if (!command.trim()) return null;
  return command.includes('{server}') ? command.replace(/\{server\}/g, serverName) : command;
}

function attemptReconnect(serverName) {
  const command = reconnectCommand(serverName);
  if (!command) return { attempted: false, success: false, reason: 'no reconnect command configured' };

  const result = spawnSync(command, {
    shell: true, env: process.env, cwd: process.cwd(), encoding: 'utf8',
    timeout: envNumber('MCP_RECONNECT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  });

  if (result.error) return { attempted: true, success: false, reason: result.error.message };
  if (result.status !== 0) return { attempted: true, success: false, reason: (result.stderr || `exit ${result.status}`).trim() };
  return { attempted: true, success: true, reason: 'reconnect completed' };
}

function shouldFailOpen() {
  return /^(1|true|yes)$/i.test(String(process.env.MCP_HEALTH_FAIL_OPEN || ''));
}

async function handlePreToolUse(rawInput, input, target, statePathValue, now) {
  const logs = [];
  const state = loadState(statePathValue);
  const previous = state.servers[target.server] || {};

  // Cache hit: still healthy
  if (previous.status === 'healthy' && Number(previous.expiresAt || 0) > now) {
    return { rawInput, exitCode: 0, logs };
  }

  // Still in backoff
  if (previous.status === 'unhealthy' && Number(previous.nextRetryAt || 0) > now) {
    logs.push(`[MCPHealthCheck] ${target.server} is marked unhealthy; skipping ${target.tool || 'tool'}`);
    return { rawInput, exitCode: shouldFailOpen() ? 0 : 2, logs };
  }

  const resolvedConfig = resolveServerConfig(target.server);
  if (!resolvedConfig) {
    return { rawInput, exitCode: 0, logs };
  }

  const probe = await probeServer(target.server, resolvedConfig);
  if (probe.ok) {
    markHealthy(state, target.server, now);
    saveState(statePathValue, state);
    if (previous.status === 'unhealthy') logs.push(`[MCPHealthCheck] ${target.server} connection restored`);
    return { rawInput, exitCode: 0, logs };
  }

  // Try reconnect
  if (probe.failureCode || previous.status === 'unhealthy') {
    const reconnect = attemptReconnect(target.server);
    if (reconnect.success) {
      const reprobe = await probeServer(target.server, resolvedConfig);
      if (reprobe.ok) {
        markHealthy(state, target.server, now);
        saveState(statePathValue, state);
        logs.push(`[MCPHealthCheck] ${target.server} connection restored after reconnect`);
        return { rawInput, exitCode: 0, logs };
      }
    }
  }

  markUnhealthy(state, target.server, now, probe.failureCode, probe.reason);
  saveState(statePathValue, state);
  logs.push(`[MCPHealthCheck] ${target.server} is unavailable (${probe.reason}). Blocking ${target.tool || 'tool'}.`);
  return { rawInput, exitCode: shouldFailOpen() ? 0 : 2, logs };
}

async function handlePostToolUseFailure(rawInput, input, target, statePathValue, now) {
  const logs = [];
  const summary = failureSummary(input);
  const failureCode = detectFailureCode(summary);
  if (!failureCode) return { rawInput, exitCode: 0, logs };

  const state = loadState(statePathValue);
  markUnhealthy(state, target.server, now, failureCode, summary.slice(0, 500));
  saveState(statePathValue, state);

  logs.push(`[MCPHealthCheck] ${target.server} reported ${failureCode}; marking unhealthy`);

  const reconnect = attemptReconnect(target.server);
  if (!reconnect.attempted || !reconnect.success) return { rawInput, exitCode: 0, logs };

  const resolvedConfig = resolveServerConfig(target.server);
  if (!resolvedConfig) return { rawInput, exitCode: 0, logs };

  const reprobe = await probeServer(target.server, resolvedConfig);
  if (reprobe.ok) {
    const refreshed = loadState(statePathValue);
    markHealthy(refreshed, target.server, now);
    saveState(statePathValue, refreshed);
    logs.push(`[MCPHealthCheck] ${target.server} connection restored`);
  }

  return { rawInput, exitCode: 0, logs };
}

async function main() {
  const { raw: rawInput, truncated } = await readRawStdin();
  const input = safeParse(rawInput);
  const target = extractMcpTarget(input);

  if (!target) {
    process.stdout.write(rawInput);
    process.exit(0);
    return;
  }

  if (truncated) {
    process.stderr.write(`[MCPHealthCheck] Input truncated while checking ${target.server}\n`);
    process.stdout.write(rawInput);
    process.exit(shouldFailOpen() ? 0 : 2);
    return;
  }

  const eventName = process.env.CLAUDE_HOOK_EVENT_NAME || 'PreToolUse';
  const now = Date.now();
  const statePathValue = stateFilePath();

  const result = eventName === 'PostToolUseFailure'
    ? await handlePostToolUseFailure(rawInput, input, target, statePathValue, now)
    : await handlePreToolUse(rawInput, input, target, statePathValue, now);

  for (const line of result.logs) process.stderr.write(line + '\n');
  process.stdout.write(result.rawInput);
  process.exit(result.exitCode);
}

main().catch(error => {
  process.stderr.write(`[MCPHealthCheck] Unexpected error: ${error.message}\n`);
  process.exit(0);
});

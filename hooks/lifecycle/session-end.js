#!/usr/bin/env node
/**
 * Session End Hook
 *
 * Runs on Stop events (after each Claude response). Extracts a meaningful
 * summary from the session transcript and persists it to a session file in
 * ~/.claude/session-data/ for cross-session continuity.
 *
 * The session file contains:
 * - Header with date, project, branch, worktree
 * - Tasks extracted from user messages
 * - Files modified and tools used
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
 *             "command": "node /path/to/hooks/lifecycle/session-end.js"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * }
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const SESSION_DIR = path.join(os.homedir(), '.claude', 'session-data');
const SUMMARY_START_MARKER = '<!-- SUMMARY:START -->';
const SUMMARY_END_MARKER = '<!-- SUMMARY:END -->';
const SESSION_SEPARATOR = '\n---\n';

function getDateString() {
  return new Date().toISOString().split('T')[0];
}

function getTimeString() {
  return new Date().toTimeString().slice(0, 5);
}

function getSessionIdShort() {
  const id = process.env.CLAUDE_SESSION_ID || 'default';
  return id.slice(0, 8);
}

function getProjectName() {
  try {
    return path.basename(process.cwd());
  } catch {
    return 'unknown';
  }
}

function runGitCommand(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Extract a meaningful summary from a JSONL transcript file.
 */
function extractSessionSummary(transcriptPath) {
  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.split('\n').filter(Boolean);
  const userMessages = [];
  const toolsUsed = new Set();
  const filesModified = new Set();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Collect user messages
      if (entry.type === 'user' || entry.role === 'user' || entry.message?.role === 'user') {
        const rawContent = entry.message?.content ?? entry.content;
        const text = typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent.map(c => (c && c.text) || '').join(' ')
            : '';
        const cleaned = text.trim();
        if (cleaned) userMessages.push(cleaned.slice(0, 200));
      }

      // Collect tools and files from direct tool_use entries
      if (entry.type === 'tool_use' || entry.tool_name) {
        const toolName = entry.tool_name || entry.name || '';
        if (toolName) toolsUsed.add(toolName);

        const filePath = entry.tool_input?.file_path || entry.input?.file_path || '';
        if (filePath && (toolName === 'Edit' || toolName === 'Write')) {
          filesModified.add(filePath);
        }
      }

      // Extract tools from assistant message content blocks
      if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_use') {
            const toolName = block.name || '';
            if (toolName) toolsUsed.add(toolName);

            const filePath = block.input?.file_path || '';
            if (filePath && (toolName === 'Edit' || toolName === 'Write')) {
              filesModified.add(filePath);
            }
          }
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  if (userMessages.length === 0) return null;

  return {
    userMessages: userMessages.slice(-10),
    toolsUsed: Array.from(toolsUsed).slice(0, 20),
    filesModified: Array.from(filesModified).slice(0, 30),
    totalMessages: userMessages.length,
  };
}

function buildSummarySection(summary) {
  let section = '## Session Summary\n\n';

  section += '### Tasks\n';
  for (const msg of summary.userMessages) {
    section += `- ${msg.replace(/\n/g, ' ').replace(/`/g, '\\`')}\n`;
  }
  section += '\n';

  if (summary.filesModified.length > 0) {
    section += '### Files Modified\n';
    for (const f of summary.filesModified) {
      section += `- ${f}\n`;
    }
    section += '\n';
  }

  if (summary.toolsUsed.length > 0) {
    section += `### Tools Used\n${summary.toolsUsed.join(', ')}\n\n`;
  }

  section += `### Stats\n- Total user messages: ${summary.totalMessages}\n`;
  return section;
}

function buildSummaryBlock(summary) {
  return `${SUMMARY_START_MARKER}\n${buildSummarySection(summary).trim()}\n${SUMMARY_END_MARKER}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Read stdin
const MAX_STDIN = 1024 * 1024;
let stdinData = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (stdinData.length < MAX_STDIN) {
    stdinData += chunk.substring(0, MAX_STDIN - stdinData.length);
  }
});

process.stdin.on('end', () => {
  main().catch(err => {
    process.stderr.write(`[SessionEnd] Error: ${err.message}\n`);
    process.exit(0);
  });
});

async function main() {
  let transcriptPath = null;
  try {
    const input = JSON.parse(stdinData);
    transcriptPath = input.transcript_path;
  } catch {
    transcriptPath = process.env.CLAUDE_TRANSCRIPT_PATH;
  }

  const today = getDateString();
  const shortId = getSessionIdShort();
  const sessionFile = path.join(SESSION_DIR, `${today}-${shortId}-session.tmp`);

  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const currentTime = getTimeString();
  const branch = runGitCommand('git rev-parse --abbrev-ref HEAD');
  const metadata = {
    project: getProjectName(),
    branch,
    worktree: process.cwd(),
  };

  // Try to extract summary from transcript
  let summary = null;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    summary = extractSessionSummary(transcriptPath);
  }

  if (fs.existsSync(sessionFile)) {
    let content = fs.readFileSync(sessionFile, 'utf8');

    // Update the "Last Updated" line
    content = content.replace(
      /\*\*Last Updated:\*\* .+/,
      `**Last Updated:** ${currentTime}`
    );

    // Update summary block if we have new data
    if (summary) {
      const summaryBlock = buildSummaryBlock(summary);
      if (content.includes(SUMMARY_START_MARKER) && content.includes(SUMMARY_END_MARKER)) {
        content = content.replace(
          new RegExp(`${escapeRegExp(SUMMARY_START_MARKER)}[\\s\\S]*?${escapeRegExp(SUMMARY_END_MARKER)}`),
          summaryBlock
        );
      }
    }

    fs.writeFileSync(sessionFile, content);
    process.stderr.write(`[SessionEnd] Updated session file: ${sessionFile}\n`);
  } else {
    // Create new session file
    const header = [
      `# Session: ${today}`,
      `**Date:** ${today}`,
      `**Started:** ${currentTime}`,
      `**Last Updated:** ${currentTime}`,
      `**Project:** ${metadata.project}`,
      `**Branch:** ${metadata.branch}`,
      `**Worktree:** ${metadata.worktree}`,
      '',
    ].join('\n');

    const summarySection = summary
      ? buildSummaryBlock(summary)
      : '## Current State\n\n[Session context goes here]\n\n### Completed\n- [ ]\n\n### In Progress\n- [ ]';

    const template = `${header}${SESSION_SEPARATOR}${summarySection}\n\n### Notes for Next Session\n-\n\n### Context to Load\n\`\`\`\n[relevant files]\n\`\`\`\n`;

    fs.writeFileSync(sessionFile, template);
    process.stderr.write(`[SessionEnd] Created session file: ${sessionFile}\n`);
  }

  process.exit(0);
}

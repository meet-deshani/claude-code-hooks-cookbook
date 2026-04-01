#!/usr/bin/env node
/**
 * Learning Capture Hook
 *
 * Auto-logs session learnings to a daily Markdown file in a configurable
 * memory directory. Can be called with arguments to directly log an entry,
 * or without arguments to prompt the agent to summarize learnings.
 *
 * Usage:
 *   node learning-capture.js --app myapp --category pattern --learning "text"
 *   node learning-capture.js  (no args = outputs prompt for agent)
 *
 * Hook event: Stop (or invoked manually via slash command)
 * Exit code: always 0
 *
 * Environment variables:
 *   LEARNING_MEMORY_DIR - Directory to store learning logs (default: ~/.claude/learnings)
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
 *             "command": "node /path/to/hooks/lifecycle/learning-capture.js"
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

const MEMORY_DIR = process.env.LEARNING_MEMORY_DIR
  || path.join(os.homedir(), '.claude', 'learnings');

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function getTime() {
  return new Date().toTimeString().slice(0, 5);
}

function appendLearning(filePath, appId, category, learning) {
  const today = getToday();
  const time = getTime();

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const header = `# Learnings - ${today}\n\n`;
  const entry = `## ${time} - [${appId}] [${category}]\n\n${learning}\n\n`;

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, header + entry, 'utf-8');
  } else {
    fs.appendFileSync(filePath, entry, 'utf-8');
  }
}

function main() {
  const args = process.argv.slice(2);

  let appId = 'general';
  let category = 'pattern';
  let learning = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--app' && args[i + 1]) {
      appId = args[++i];
    } else if (args[i] === '--category' && args[i + 1]) {
      category = args[++i];
    } else if (args[i] === '--learning' && args[i + 1]) {
      learning = args[++i];
    }
  }

  if (!learning) {
    // No learning provided — output instruction for the agent
    console.log(JSON.stringify({
      action: 'prompt_agent',
      message: 'Session ending. Summarize key learnings (non-obvious insights, not code changes) and call /capture-learning for each.',
    }));
    return;
  }

  const today = getToday();
  const centralFile = path.join(MEMORY_DIR, `${today}.md`);
  appendLearning(centralFile, appId, category, learning);
  console.log(`Logged learning to: ${centralFile}`);
}

main();

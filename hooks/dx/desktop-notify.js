#!/usr/bin/env node
/**
 * Desktop Notification Hook
 *
 * Sends a native desktop notification with a task summary when Claude finishes
 * responding. Supports macOS (osascript), Linux (notify-send), and Windows
 * (PowerShell). Falls back silently on unsupported platforms.
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
 *             "command": "node /path/to/hooks/dx/desktop-notify.js"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * }
 */

'use strict';

const { spawnSync } = require('child_process');

const TITLE = 'Claude Code';
const MAX_BODY_LENGTH = 100;

/**
 * Extract a short summary from the last assistant message.
 */
function extractSummary(message) {
  if (!message || typeof message !== 'string') return 'Done';

  const firstLine = message
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0);

  if (!firstLine) return 'Done';

  return firstLine.length > MAX_BODY_LENGTH
    ? `${firstLine.slice(0, MAX_BODY_LENGTH)}...`
    : firstLine;
}

/**
 * Send a macOS notification via osascript.
 */
function notifyMacOS(title, body) {
  const safeBody = body.replace(/\\/g, '').replace(/"/g, '\u201C');
  const safeTitle = title.replace(/\\/g, '').replace(/"/g, '\u201C');
  const script = `display notification "${safeBody}" with title "${safeTitle}"`;
  spawnSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 5000 });
}

/**
 * Send a Linux notification via notify-send.
 */
function notifyLinux(title, body) {
  spawnSync('notify-send', [title, body], { stdio: 'ignore', timeout: 5000 });
}

/**
 * Send a Windows notification via PowerShell.
 */
function notifyWindows(title, body) {
  const ps = `
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $xml = @"
    <toast><visual><binding template="ToastText02"><text id="1">${title.replace(/"/g, '&quot;')}</text><text id="2">${body.replace(/"/g, '&quot;')}</text></binding></visual></toast>
"@
    $toast = [Windows.UI.Notifications.ToastNotification]::New([Windows.Data.Xml.Dom.XmlDocument]::new())
    $toast.Content.LoadXml($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Claude Code").Show($toast)
  `;
  spawnSync('powershell', ['-Command', ps], { stdio: 'ignore', timeout: 5000 });
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
    const input = data.trim() ? JSON.parse(data) : {};
    const summary = extractSummary(input.last_assistant_message);

    if (process.platform === 'darwin') {
      notifyMacOS(TITLE, summary);
    } else if (process.platform === 'linux') {
      notifyLinux(TITLE, summary);
    } else if (process.platform === 'win32') {
      notifyWindows(TITLE, summary);
    }
  } catch {
    // Non-blocking — ignore errors
  }

  process.stdout.write(data);
});

# Claude Code Hooks Cookbook

> Battle-tested hook patterns for Claude Code — security guardrails, quality gates, automation, and developer experience.

Every hook in this collection is extracted from a production development environment running 20+ hooks daily across 8+ deployed apps.

## Why Hooks?

Claude Code [hooks](https://code.claude.com/docs/en/hooks) let you run custom scripts at key moments in the agent lifecycle — before/after tool use, on session start/end, before compaction, and more. They're the best way to enforce guardrails, automate workflows, and maintain quality without relying on the LLM to "remember" your rules.

## Quick Start

```bash
# Clone the cookbook
git clone https://github.com/meet-deshani/claude-code-hooks-cookbook.git

# Copy hooks you want into your project
cp -r hooks/security/ your-project/.claude/hooks/

# Add to your .claude/settings.json (see examples below)
```

## Hook Categories

### Security Guardrails

| Hook | What It Does | Event |
|------|-------------|-------|
| [block-no-verify](hooks/security/block-no-verify.js) | Prevents `git commit --no-verify` and `git push --no-verify` — stops agents from bypassing pre-commit hooks | PreToolUse (Bash) |
| [config-protection](hooks/security/config-protection.js) | Blocks modifications to linter/formatter configs (`.eslintrc`, `biome.json`, etc.) — steers agent to fix code, not weaken rules | PreToolUse (Write/Edit) |
| [secrets-scan](hooks/security/secrets-scan.js) | Scans file content for API keys, tokens, passwords before write | PreToolUse (Write/Edit) |

### Quality Gates

| Hook | What It Does | Event |
|------|-------------|-------|
| [post-edit-format](hooks/quality/post-edit-format.js) | Auto-formats JS/TS files after edits (auto-detects Biome or Prettier) | PostToolUse (Edit) |
| [post-edit-typecheck](hooks/quality/post-edit-typecheck.js) | Runs TypeScript type-check after editing `.ts`/`.tsx` files | PostToolUse (Edit) |
| [console-log-warn](hooks/quality/console-log-warn.js) | Warns about `console.log` statements in modified files | PostToolUse (Edit) / Stop |
| [quality-gate](hooks/quality/quality-gate.js) | Runs lint + type-check + test on changed files after edits | PostToolUse (Edit/Write) |

### Developer Experience

| Hook | What It Does | Event |
|------|-------------|-------|
| [desktop-notify](hooks/dx/desktop-notify.js) | macOS/Linux desktop notification when Claude finishes a task | Stop |
| [cost-tracker](hooks/dx/cost-tracker.js) | Tracks token usage and estimated cost per session | Stop |
| [tmux-reminder](hooks/dx/tmux-reminder.js) | Suggests tmux for long-running commands | PreToolUse (Bash) |
| [git-push-review](hooks/dx/git-push-review.js) | Reminder to review changes before `git push` | PreToolUse (Bash) |

### Session Lifecycle

| Hook | What It Does | Event |
|------|-------------|-------|
| [session-start](hooks/lifecycle/session-start.js) | Loads previous context and detects package manager | SessionStart |
| [session-end](hooks/lifecycle/session-end.js) | Persists session state for cross-session continuity | Stop |
| [pre-compact](hooks/lifecycle/pre-compact.js) | Saves critical state before context compaction | PreCompact |
| [learning-capture](hooks/lifecycle/learning-capture.js) | Auto-captures session learnings to memory | Stop |

### Automation

| Hook | What It Does | Event |
|------|-------------|-------|
| [pr-created](hooks/automation/pr-created.js) | Logs PR URL and provides review command after PR creation | PostToolUse (Bash) |
| [build-complete](hooks/automation/build-complete.js) | Async build analysis and notification after builds | PostToolUse (Bash) |
| [mcp-health-check](hooks/automation/mcp-health-check.js) | Checks MCP server health before tool calls, blocks unhealthy servers | PreToolUse (*) |

## Configuration

Add hooks to your `.claude/settings.json`:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "node .claude/hooks/security/block-no-verify.js"
        }],
        "description": "Block --no-verify flag on git commands"
      },
      {
        "matcher": "Write|Edit",
        "hooks": [{
          "type": "command",
          "command": "node .claude/hooks/security/config-protection.js"
        }],
        "description": "Protect linter/formatter configs from modification"
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit",
        "hooks": [{
          "type": "command",
          "command": "node .claude/hooks/quality/post-edit-format.js"
        }],
        "description": "Auto-format after edits"
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [{
          "type": "command",
          "command": "node .claude/hooks/dx/desktop-notify.js",
          "async": true,
          "timeout": 10
        }],
        "description": "Desktop notification when Claude responds"
      }
    ]
  }
}
```

## Hook Patterns & Tips

### The `if` Condition (v2.1.88+)

Use `if` for granular filtering beyond `matcher`:

```jsonc
{
  "matcher": "Bash",
  "if": "Bash(git push*)",
  "hooks": [{ "type": "command", "command": "node hooks/pre-push-review.js" }]
}
```

Since v2.1.88, `if` handles compound commands (`ls && git push`) and env-prefixed commands (`FOO=bar git push`).

### Async vs Sync

- **Sync hooks** (default): Block the agent until complete. Use for security guardrails.
- **Async hooks** (`"async": true`): Run in background. Use for notifications, logging, analytics.

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Hook passed — agent continues |
| 2 | Hook blocked — agent sees the rejection reason |
| Other | Hook errored — agent continues (fail-open) |

### Reading Tool Input

Hooks receive JSON on stdin with the tool call details:

```javascript
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const toolName = input.tool_name;
const toolInput = input.tool_input;
// For Bash: toolInput.command
// For Edit: toolInput.file_path, toolInput.old_string, toolInput.new_string
// For Write: toolInput.file_path, toolInput.content
```

## Contributing

PRs welcome! Each hook should:
1. Be a single self-contained file (no external dependencies beyond Node.js built-ins)
2. Read from stdin, write to stdout
3. Use exit code 0 (pass) or 2 (block)
4. Include a comment header explaining what it does

## License

MIT

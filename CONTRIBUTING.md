# Contributing

PRs welcome! Here's how to add a hook.

## Hook Requirements

1. **Single file** — one `.js` file per hook, no external dependencies
2. **Node.js built-ins only** — `fs`, `path`, `child_process`, `os` are fine. No npm packages.
3. **Stdin/stdout contract** — read JSON from stdin, write JSON or plain text to stdout
4. **Exit codes** — `0` = pass, `2` = block, anything else = error (fail-open)
5. **Comment header** — every hook starts with a JSDoc block:
   ```javascript
   /**
    * Hook Name
    *
    * What it does (one line).
    *
    * Hook event: PreToolUse | PostToolUse | Stop | SessionStart | etc.
    * Matcher: Bash | Edit | Write | * | etc.
    * Exit codes: 0 = allow, 2 = block
    *
    * Example settings.json:
    * { ... }
    */
   ```

## Adding a Hook

1. Pick the right category: `security/`, `quality/`, `dx/`, `lifecycle/`, `automation/`
2. Create your `.js` file with the comment header
3. Test it: `echo '{"tool_name":"Bash","tool_input":{"command":"git push"}}' | node hooks/your-hook.js`
4. Add it to the table in `README.md`
5. Open a PR

## Testing

```bash
# Test a security hook blocks bad commands
echo '{"tool_name":"Bash","tool_input":{"command":"git commit --no-verify -m test"}}' | node hooks/security/block-no-verify.js
echo "Exit code: $?"  # Should be 2 (blocked)

# Test it allows good commands
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m test"}}' | node hooks/security/block-no-verify.js
echo "Exit code: $?"  # Should be 0 (allowed)
```

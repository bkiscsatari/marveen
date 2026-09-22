// POSIX single-quote escaping, shared by every launcher that inlines a value
// into a shell command string. Moved out of web/agent-process.ts (Phase 0 of
// the agent-agnostic refactor) so runtime adapters can import it without
// pulling in the whole tmux launcher; agent-process.ts re-exports it under the
// same name, so existing imports keep working.
//
// Wrapping a value in single quotes makes it ONE inert shell word; the only
// character that can break out of that is a single quote itself, which we
// turn into '\'' (close, escaped quote, reopen). This is defence #2 at the
// sink; the model-id allowlist (model-id.ts) is defence #1.
export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

#!/usr/bin/env python3
"""PreToolUse gate on the gmail_draft MCP tool: blocks the 'send' action.

Why this exists (Balint, 2026-09-06): the Gmail MCP server's gmail_draft tool
does double duty -- action=create/list/get/update/delete are safe draft
operations, but action=send actually dispatches the draft as a real email.
CLAUDE.md's standing rule is that the main agent (Icuka) NEVER sends anything
external -- Balint sends everything himself, Icuka only prepares drafts. A
plain permissions.deny on the whole tool would also block draft creation,
which is exactly the capability being granted, so this hook inspects the
action argument instead of blocking the tool wholesale.

gmail_send_email (the other Gmail MCP tool that sends directly, no draft
step) is denied outright via permissions.deny -- it has no legitimate
draft-only use, so no hook is needed for it.

Contract: PreToolUse. Reads the hook payload on stdin, exit 0 with
hookSpecificOutput.permissionDecision "deny" to block, "allow" to explicitly
allow (falls through to normal permission handling otherwise).
"""
import json
import sys


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        # Unreadable payload: fail closed, same posture as the outgoing-copy-gate.
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "gmail-draft-send-gate: could not parse hook input, failing closed.",
            }
        }))
        return 0

    tool_input = payload.get("tool_input") or {}
    action = str(tool_input.get("action", "")).strip().lower()

    if action == "send":
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    "Icuka never sends email. gmail_draft action=send is blocked by "
                    "standing rule (CLAUDE.md): Balint sends everything himself. "
                    "Create/update the draft and let Balint send it from Gmail."
                ),
            }
        }))
        return 0

    # Any other action (create/list/get/update/delete): no opinion, let normal
    # permission handling decide.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

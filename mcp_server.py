#!/usr/bin/env python3
"""Claws MCP Server — expose terminal control as native Claude Code tools.

Register in any project's .claude/settings.json:

    "mcpServers": {
        "claws": {
            "command": "python3",
            "args": ["/path/to/claws/mcp_server.py"],
            "env": {
                "CLAWS_SOCKET": ".claws/claws.sock"
            }
        }
    }

Every Claude Code session with this registered gets these tools:
    claws_list          — list all VS Code terminals
    claws_create        — create a new terminal (optionally wrapped)
    claws_send          — send text into a terminal
    claws_exec          — execute a command with captured output
    claws_read_log      — read a wrapped terminal's pty log
    claws_poll          — stream shell-integration events
    claws_close         — close a terminal
    claws_worker        — spawn a full worker pattern (create + launch + monitor)

Zero external dependencies. Stdlib + the claws client (bundled).
"""
from __future__ import annotations

import json
import os
import socket
import sys
import time
import uuid
from pathlib import Path
from typing import Any

# ─── MCP protocol (stdio, minimal implementation) ───────────────────────────

def read_message() -> dict | None:
    """Read a JSON-RPC message from stdin (Content-Length framing)."""
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        line_str = line.decode("utf-8").strip()
        if not line_str:
            break
        if ":" in line_str:
            key, val = line_str.split(":", 1)
            headers[key.strip().lower()] = val.strip()
    length = int(headers.get("content-length", 0))
    if length == 0:
        return None
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode("utf-8"))


def write_message(msg: dict) -> None:
    """Write a JSON-RPC message to stdout (Content-Length framing)."""
    body = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8"))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def respond(id: Any, result: Any) -> None:
    write_message({"jsonrpc": "2.0", "id": id, "result": result})


def respond_error(id: Any, code: int, message: str) -> None:
    write_message({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})


# ─── Claws socket client (inline, zero deps) ────────────────────────────────

_counter = 0

def claws_rpc(sock_path: str, req: dict, timeout: float = 30.0) -> dict:
    global _counter
    _counter += 1
    req = {"id": _counter, **req}
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(sock_path)
        s.sendall((json.dumps(req) + "\n").encode("utf-8"))
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        line = buf.split(b"\n", 1)[0]
        return json.loads(line.decode("utf-8")) if line else {"ok": False, "error": "empty response"}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        s.close()


def file_exec(sock_path: str, term_id: str, command: str, timeout_s: float = 180.0) -> dict:
    """File-based command execution — works in any terminal type."""
    exec_id = uuid.uuid4().hex[:10]
    base = Path("/tmp/claws-exec")
    base.mkdir(exist_ok=True)
    out_path = base / f"{exec_id}.out"
    done_path = base / f"{exec_id}.done"
    wrapper = f"{{ {command}; }} > {out_path} 2>&1; echo $? > {done_path}"
    claws_rpc(sock_path, {"cmd": "send", "id": term_id, "text": wrapper, "newline": True})
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if done_path.exists():
            break
        time.sleep(0.15)
    else:
        partial = out_path.read_text(errors="replace") if out_path.exists() else ""
        return {"ok": False, "error": f"timeout after {timeout_s}s", "partial": partial}
    exit_raw = done_path.read_text(errors="replace").strip()
    try:
        exit_code = int(exit_raw)
    except ValueError:
        exit_code = None
    output = out_path.read_text(errors="replace") if out_path.exists() else ""
    try:
        out_path.unlink(missing_ok=True)
        done_path.unlink(missing_ok=True)
    except OSError:
        pass
    return {"ok": True, "terminal_id": term_id, "command": command, "output": output, "exit_code": exit_code}


# ─── Tool definitions ───────────────────────────────────────────────────────

TOOLS = [
    {
        "name": "claws_list",
        "description": (
            "List all open VS Code terminals with their ID, name, PID, shell integration status, "
            "active state, and pty log path (null if not wrapped). Use this to discover what's "
            "running before sending commands."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "claws_create",
        "description": (
            "Create a new VS Code terminal. Set wrapped=true to enable full pty logging — "
            "this lets you read everything that happens in the terminal including TUI sessions "
            "(Claude Code, vim, htop, REPLs). The terminal appears visibly in VS Code's panel."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Terminal display name"},
                "cwd": {"type": "string", "description": "Working directory (absolute path)"},
                "wrapped": {"type": "boolean", "description": "Enable script(1) pty logging for full read-back. Always true for worker terminals."},
            },
            "required": ["name"],
        },
    },
    {
        "name": "claws_send",
        "description": (
            "Send text into a terminal. The text arrives at whatever input is active — shell prompt, "
            "TUI input field, REPL prompt. Multi-line text is auto-wrapped in bracketed paste mode. "
            "Set newline=false to send raw keystrokes without Enter (e.g., \\r for CR, \\x03 for Ctrl+C)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Terminal ID from claws_list or claws_create"},
                "text": {"type": "string", "description": "Text to send"},
                "newline": {"type": "boolean", "description": "Append Enter after text (default true)"},
            },
            "required": ["id", "text"],
        },
    },
    {
        "name": "claws_exec",
        "description": (
            "Execute a shell command in a terminal and capture the output (stdout + stderr + exit code). "
            "Uses file-based capture — works in any terminal type without depending on shell integration. "
            "Waits for the command to finish. Use for commands where you need the output back. "
            "For fire-and-forget, use claws_send instead."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Terminal ID"},
                "command": {"type": "string", "description": "Shell command to execute"},
                "timeout_ms": {"type": "integer", "description": "Max wait time in ms (default 180000)"},
            },
            "required": ["id", "command"],
        },
    },
    {
        "name": "claws_read_log",
        "description": (
            "Read a wrapped terminal's pty log with ANSI escapes stripped. Returns clean, readable text "
            "of everything that happened in the terminal — including TUI sessions, build output, "
            "conversation transcripts from AI coding assistants. Only works for terminals created with "
            "wrapped=true. Use this to observe worker progress, read Claude Code responses, or capture "
            "interactive session output."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Terminal ID (must be wrapped)"},
                "lines": {"type": "integer", "description": "Number of lines to return from the tail (default 50)"},
            },
            "required": ["id"],
        },
    },
    {
        "name": "claws_poll",
        "description": (
            "Stream shell-integration command-completion events across all terminals. Each event has: "
            "terminal ID, command line, output, exit code, timestamps. Pass since=cursor to get only "
            "new events. Note: unreliable in wrapped terminals — use claws_read_log instead."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "since": {"type": "integer", "description": "Sequence cursor — return only events after this (default 0)"},
            },
        },
    },
    {
        "name": "claws_close",
        "description": (
            "Close and dispose a terminal. The terminal tab disappears from VS Code. "
            "Always close terminals you created when the work is done — stale terminals "
            "clutter the panel and leak pty log disk space."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Terminal ID to close"},
            },
            "required": ["id"],
        },
    },
    {
        "name": "claws_worker",
        "description": (
            "Spawn a complete VISIBLE worker terminal with full autonomy. Creates a wrapped terminal, "
            "launches interactive Claude Code with --dangerously-skip-permissions (full tool access), "
            "waits for boot, then sends the mission prompt. The worker runs visibly in VS Code's "
            "terminal panel — the user watches everything. NEVER headless. After spawning, use "
            "claws_read_log to monitor progress and claws_close to clean up when done."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Worker name (appears as terminal tab name in VS Code)"},
                "mission": {"type": "string", "description": "Mission prompt to send to Claude Code. Single line. Must include MISSION_COMPLETE marker and constraints."},
                "launch_claude": {"type": "boolean", "description": "Auto-launch 'claude --dangerously-skip-permissions' before sending mission (default true)"},
                "command": {"type": "string", "description": "Alternative: raw shell command instead of Claude mission. Set launch_claude=false when using this."},
            },
            "required": ["name"],
        },
    },
]


# ─── Tool handlers ───────────────────────────────────────────────────────────

def get_socket() -> str:
    return os.environ.get("CLAWS_SOCKET", ".claws/claws.sock")


def handle_tool(name: str, args: dict) -> list[dict]:
    sock = get_socket()

    if name == "claws_list":
        resp = claws_rpc(sock, {"cmd": "list"})
        if not resp.get("ok"):
            return [{"type": "text", "text": f"ERROR: {resp.get('error')}"}]
        terminals = resp.get("terminals", [])
        if not terminals:
            return [{"type": "text", "text": "[no terminals open]"}]
        lines = []
        for t in terminals:
            wrap = "WRAPPED" if t.get("logPath") else "unwrapped"
            marker = "*" if t.get("active") else " "
            lines.append(f"{marker} {t['id']}  {t.get('name',''):<25} pid={t.get('pid')}  [{wrap}]")
        return [{"type": "text", "text": "\n".join(lines)}]

    if name == "claws_create":
        resp = claws_rpc(sock, {
            "cmd": "create",
            "name": args.get("name", "claws"),
            "cwd": args.get("cwd"),
            "wrapped": args.get("wrapped", False),
            "show": True,
        })
        if not resp.get("ok"):
            return [{"type": "text", "text": f"ERROR: {resp.get('error')}"}]
        log_path = resp.get("logPath")
        text = f"created terminal id={resp['id']}"
        if log_path:
            text += f" wrapped logPath={log_path}"
        return [{"type": "text", "text": text}]

    if name == "claws_send":
        resp = claws_rpc(sock, {
            "cmd": "send",
            "id": args["id"],
            "text": args["text"],
            "newline": args.get("newline", True),
        })
        if not resp.get("ok"):
            return [{"type": "text", "text": f"ERROR: {resp.get('error')}"}]
        return [{"type": "text", "text": "sent"}]

    if name == "claws_exec":
        timeout_ms = args.get("timeout_ms", 180000)
        result = file_exec(sock, args["id"], args["command"], timeout_s=timeout_ms / 1000)
        if not result.get("ok"):
            text = f"ERROR: {result.get('error')}"
            if result.get("partial"):
                text += f"\n[partial output]\n{result['partial']}"
            return [{"type": "text", "text": text}]
        return [{"type": "text", "text": f"exit {result['exit_code']}\n{result['output']}"}]

    if name == "claws_read_log":
        resp = claws_rpc(sock, {"cmd": "readLog", "id": args["id"], "strip": True})
        if not resp.get("ok"):
            return [{"type": "text", "text": f"ERROR: {resp.get('error')}"}]
        body = resp.get("bytes", "")
        all_lines = body.splitlines()
        n = args.get("lines", 50)
        tail = all_lines[-n:] if len(all_lines) > n else all_lines
        header = f"[term {args['id']} · {resp.get('totalSize', 0)} bytes · showing last {len(tail)} of {len(all_lines)} lines]"
        return [{"type": "text", "text": header + "\n" + "\n".join(tail)}]

    if name == "claws_poll":
        resp = claws_rpc(sock, {"cmd": "poll", "since": args.get("since", 0)})
        if not resp.get("ok"):
            return [{"type": "text", "text": f"ERROR: {resp.get('error')}"}]
        events = resp.get("events", [])
        if not events:
            return [{"type": "text", "text": f"[no events · cursor {resp.get('cursor', 0)}]"}]
        lines = []
        for e in events:
            lines.append(f"[seq {e.get('seq')} · {e.get('terminalName')} · exit {e.get('exitCode')}] $ {e.get('commandLine', '')}")
            if e.get("output"):
                out = e["output"]
                if len(out) > 500:
                    out = out[:500] + "..."
                lines.append(out)
        return [{"type": "text", "text": "\n".join(lines) + f"\n[cursor {resp.get('cursor')}]"}]

    if name == "claws_close":
        resp = claws_rpc(sock, {"cmd": "close", "id": args["id"]})
        if not resp.get("ok"):
            return [{"type": "text", "text": f"ERROR: {resp.get('error')}"}]
        return [{"type": "text", "text": f"closed terminal {args['id']}"}]

    if name == "claws_worker":
        launch_claude = args.get("launch_claude", True)
        mission = args.get("mission", args.get("command", ""))

        # Step 1: create visible wrapped terminal
        create_resp = claws_rpc(sock, {
            "cmd": "create",
            "name": args["name"],
            "wrapped": True,
            "show": True,
        })
        if not create_resp.get("ok"):
            return [{"type": "text", "text": f"ERROR creating terminal: {create_resp.get('error')}"}]
        term_id = create_resp["id"]
        log_path = create_resp.get("logPath", "")

        # Step 2: wait for shell init
        time.sleep(1.5)

        if launch_claude:
            # Step 3a: launch interactive Claude Code with full permissions
            claws_rpc(sock, {"cmd": "send", "id": term_id, "text": "claude --dangerously-skip-permissions", "newline": True})
            # Wait for Claude to boot (renders welcome banner)
            time.sleep(5)

            if mission:
                # Step 4: send the mission prompt
                claws_rpc(sock, {"cmd": "send", "id": term_id, "text": mission, "newline": True})
                # Submit with raw CR (Claude TUI needs explicit Enter)
                time.sleep(0.3)
                claws_rpc(sock, {"cmd": "send", "id": term_id, "text": "\r", "newline": False})

            return [{"type": "text", "text": (
                f"worker '{args['name']}' spawned with Claude Code (full permissions)\n"
                f"  terminal: {term_id}\n"
                f"  log: {log_path}\n"
                f"  claude: interactive, --dangerously-skip-permissions\n"
                + (f"  mission sent: {mission[:100]}...\n" if mission else "  no mission sent — waiting for prompt\n")
                + f"\nuse claws_read_log id={term_id} to monitor\n"
                f"use claws_send id={term_id} to send follow-up prompts\n"
                f"use claws_close id={term_id} when done"
            )}]
        else:
            # Step 3b: raw shell command (no Claude)
            if mission:
                claws_rpc(sock, {"cmd": "send", "id": term_id, "text": mission, "newline": True})

            return [{"type": "text", "text": (
                f"worker '{args['name']}' spawned (shell mode)\n"
                f"  terminal: {term_id}\n"
                f"  log: {log_path}\n"
                + (f"  command sent: {mission[:100]}\n" if mission else "  idle shell — send commands via claws_send\n")
                + f"\nuse claws_read_log id={term_id} to monitor\n"
                f"use claws_close id={term_id} when done"
            )}]

    return [{"type": "text", "text": f"unknown tool: {name}"}]


# ─── MCP server main loop ───────────────────────────────────────────────────

SERVER_INFO = {
    "name": "claws",
    "version": "0.1.0",
}

CAPABILITIES = {
    "tools": {},
}


def main() -> None:
    while True:
        msg = read_message()
        if msg is None:
            break

        method = msg.get("method", "")
        id_ = msg.get("id")
        params = msg.get("params", {})

        if method == "initialize":
            respond(id_, {
                "protocolVersion": "2024-11-05",
                "serverInfo": SERVER_INFO,
                "capabilities": CAPABILITIES,
            })

        elif method == "notifications/initialized":
            pass  # no response needed

        elif method == "tools/list":
            respond(id_, {"tools": TOOLS})

        elif method == "tools/call":
            tool_name = params.get("name", "")
            tool_args = params.get("arguments", {})
            try:
                content = handle_tool(tool_name, tool_args)
                respond(id_, {"content": content})
            except Exception as e:
                respond(id_, {"content": [{"type": "text", "text": f"ERROR: {type(e).__name__}: {e}"}], "isError": True})

        elif method == "ping":
            respond(id_, {})

        else:
            if id_ is not None:
                respond_error(id_, -32601, f"unknown method: {method}")


if __name__ == "__main__":
    main()

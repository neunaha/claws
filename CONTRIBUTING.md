# Contributing to Claws

Thanks for your interest in contributing to Claws. This guide will get you from zero to your first pull request.

## Quick Start

```bash
# Fork and clone
gh repo fork neunaha/claws --clone
cd claws

# Install the extension locally
ln -s "$(pwd)/extension" ~/.vscode/extensions/neunaha.claws-dev
chmod +x scripts/terminal-wrapper.sh

# Reload VS Code
# Cmd+Shift+P → "Developer: Reload Window"

# Verify it works
echo '{"id":1,"cmd":"list"}' | nc -U .claws/claws.sock
```

## Development Workflow

1. Create a branch: `git checkout -b feat/my-feature`
2. Make your changes
3. Test manually — reload VS Code, verify the socket responds
4. Commit with conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `perf:`
5. Push and open a PR against `main`

## What We're Looking For

### High-Priority Contributions

- **TypeScript rewrite** — `extension/src/extension.js` → proper `.ts` modules with types
- **Extension tests** — `@vscode/test-electron` test suite
- **Windows support** — `ConPTY` alternative to `script(1)` in `terminal-wrapper.sh`
- **Node.js client** — `clients/node/` matching the Python client's API
- **WebSocket transport** — second transport alongside Unix socket for cross-device control

### Always Welcome

- Bug fixes with reproduction steps
- Documentation improvements
- New example scripts in `examples/`
- Additional language clients (Go, Rust, Ruby, Java)
- Performance improvements with benchmarks

### Not Looking For

- Features that add npm dependencies to the extension (must stay zero-dep)
- Changes to the JSON protocol without an RFC discussion first
- AI/ML features inside the extension itself (Claws is a bridge, not an agent)

## Project Structure

```
claws/
├── extension/          # The VS Code extension (published to marketplace)
│   ├── src/            # Extension source code
│   ├── test/           # Extension tests
│   └── package.json    # Extension manifest
├── clients/
│   ├── python/         # Python client library
│   └── node/           # Node.js client library (needs contributor)
├── scripts/            # Shell scripts (terminal wrapper)
├── examples/           # Usage examples
├── docs/               # Documentation
├── .claude/            # Claude Code integration (commands + skills)
└── CLAUDE.md           # AI development instructions
```

## Code Style

**Extension (JavaScript / future TypeScript)**:
- No npm dependencies — stdlib + VS Code API only
- Functions over classes where possible
- Descriptive variable names, no abbreviations
- JSDoc on exported functions

**Python client**:
- Python 3.10+ with `from __future__ import annotations`
- Type hints on all function signatures
- Zero external dependencies (stdlib only)
- `@dataclass(frozen=True)` for data objects
- Black formatting, ruff linting

**Commit messages**:
```
feat: add WebSocket transport alongside Unix socket
fix: handle SIGWINCH in wrapped terminals on Linux
docs: add Go client example
test: add integration tests for readLog command
perf: reduce ANSI regex compilation to once per session
```

## Protocol Changes

The JSON socket protocol is the contract between the extension and all clients. Changes to it affect every client library. If you want to:

- **Add a new command**: open a Discussion first with the proposed schema
- **Add fields to an existing response**: backward-compatible, just PR it
- **Remove or rename fields**: breaking change, needs an RFC Discussion
- **Change behavior of existing commands**: needs an RFC Discussion

## Testing

### Manual Testing (current)

1. Reload VS Code after changes
2. Open the Output panel → "Claws" to see server logs
3. Use `nc -U .claws/claws.sock` or the Python client to send commands
4. Verify responses match the protocol spec

### Automated Testing (planned)

We want `@vscode/test-electron` tests. If you're setting this up:

```bash
cd extension
npm install --save-dev @vscode/test-electron @types/vscode mocha
```

Test structure:
```
extension/test/
├── suite/
│   ├── index.ts         # Test runner
│   ├── server.test.ts   # Socket server tests
│   ├── terminal.test.ts # Terminal management tests
│   └── protocol.test.ts # Protocol compliance tests
└── runTest.ts           # Entry point
```

## Reporting Bugs

Open an issue with:

1. **VS Code version** (`code --version`)
2. **OS** (macOS version or Linux distro)
3. **Steps to reproduce** — exact commands or code
4. **Expected behavior**
5. **Actual behavior**
6. **Claws output log** — Output panel → "Claws"

## Suggesting Features

Open a Discussion (not an issue) with:

1. **Use case** — what you're trying to accomplish
2. **Current workaround** — how you're doing it today (if at all)
3. **Proposed solution** — what you think the API should look like
4. **Alternatives considered**

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

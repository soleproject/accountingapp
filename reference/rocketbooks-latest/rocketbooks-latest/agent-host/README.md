# agent-host (Phase 1)

A local daemon that owns live Claude Code agent sessions and exposes them over a
localhost WebSocket, so the superadmin **Agents** dashboard can spawn, chat with,
and recall agents — independently of any terminal or browser tab.

Built on `@anthropic-ai/claude-agent-sdk`. Each agent is one `query()` session fed
by a pushable stream of user messages, kept alive between turns and across client
disconnects. The registry is persisted to `agent-host/.data/registry.json` and
agents are resumed (via their `sessionId`) when the daemon restarts.

## Run

```bash
npm run agent-host
```

Listens on `ws://127.0.0.1:4500` by default.

## Config (env)

| var | default | meaning |
|---|---|---|
| `AGENT_HOST_HOST` | `127.0.0.1` | bind address (keep local) |
| `AGENT_HOST_PORT` | `4500` | WebSocket port |
| `AGENT_HOST_TOKEN` | `local-dev` | shared token; clients must pass `?token=` |
| `AGENT_HOST_DATA` | `agent-host/.data/registry.json` | registry persistence path |
| `AGENT_HOST_GIT_INTERVAL` | `5000` | ms between git-state polls |
| `AGENT_HOST_OBSERVED_INTERVAL` | `12000` | ms between observed-session scans |
| `AGENT_HOST_OBSERVED_LIMIT` | `30` | max recent terminal sessions surfaced read-only |
| `AGENT_HOST_ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | browser Origins permitted to connect |

The dashboard reads `NEXT_PUBLIC_AGENT_HOST_URL` (default `ws://127.0.0.1:4500`)
and `AGENT_HOST_TOKEN` to connect.

**Security.** The daemon can spawn agents that run tools, so the connection is
guarded two ways: it binds to loopback only, and it **rejects cross-origin browser
connections** — browsers send an `Origin` header on the WS handshake, and only
`AGENT_HOST_ALLOWED_ORIGINS` are accepted (CLI/Node clients send no Origin and are
allowed). This stops any website you visit from driving the daemon. For
defense-in-depth, also set a random `AGENT_HOST_TOKEN` in `.env.local`.

## Protocol (JSON over WS)

Client → server: `list`, `spawn{cwd,model?,title?,firstMessage?}`, `attach{agentId}`,
`input{agentId,text}`, `interrupt{agentId}`, `permission{agentId,requestId,decision}`,
`rename{agentId,title}`, `stop{agentId}`, `restart{agentId}`, `remove{agentId}`.

`attach` to a non-daemon session id returns a read-only backlog parsed from that
session's transcript. Observed (terminal) sessions appear in the roster with
`readonly: true`; the daemon surfaces the most recent `AGENT_HOST_OBSERVED_LIMIT`.

Server → client: `hello`, `agents[]`, `backlog{events[]}`, `event{event}`, `error`.

Permission requests (`canUseTool`) are routed to clients as `permission_request`
events and block until a dashboard `permission` decision arrives.

## Auth

Reuses the machine's existing Claude Code login — no `ANTHROPIC_API_KEY` plumbing
needed. Agents spawn `claude` subprocesses in their configured `cwd`.

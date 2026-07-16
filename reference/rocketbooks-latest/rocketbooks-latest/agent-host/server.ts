import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { AgentManager } from './manager';
import type { ClientMessage, ServerMessage } from './types';

export interface ServerOptions {
  manager: AgentManager;
  host: string;
  port: number;
  token: string;
  /** Allowed browser Origins. Non-browser clients (no Origin header) are always allowed. */
  allowedOrigins: ReadonlySet<string>;
}

export function startServer(opts: ServerOptions): WebSocketServer {
  const { manager, host, port, token, allowedOrigins } = opts;
  const wss = new WebSocketServer({ host, port });
  const clients = new Set<WebSocket>();

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage) => {
    const raw = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(raw);
  };

  manager.onEvent((agentId, event) => broadcast({ type: 'event', agentId, event }));
  manager.onChange(() => broadcast({ type: 'agents', agents: manager.list() }));

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Reject cross-origin browser connections. Browsers send an Origin header on
    // the WS handshake; CLI/Node clients (and the SDK) do not. This stops any
    // website you visit from connecting to the loopback daemon and driving agents.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      ws.close(4403, 'forbidden origin');
      return;
    }
    if (token && url.searchParams.get('token') !== token) {
      ws.close(4001, 'unauthorized');
      return;
    }
    clients.add(ws);
    manager.clientConnected();
    send(ws, { type: 'hello', ok: true, pid: process.pid });
    send(ws, { type: 'agents', agents: manager.list() });

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      void handle(ws, msg).catch((err) =>
        send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
    });
    const drop = () => {
      if (clients.delete(ws)) manager.clientDisconnected();
    };
    ws.on('close', drop);
    ws.on('error', drop);
  });

  async function handle(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'list':
        send(ws, { type: 'agents', agents: manager.list() });
        break;
      case 'spawn': {
        try {
          const agent = manager.spawn(msg);
          send(ws, { type: 'backlog', agentId: agent.id, summary: agent.summary(), events: agent.getBacklog() });
        } catch (err) {
          send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      case 'attach': {
        const agent = manager.get(msg.agentId);
        if (agent) {
          send(ws, { type: 'backlog', agentId: agent.id, summary: agent.summary(), events: agent.getBacklog() });
          break;
        }
        // Not a live agent — try a read-only observed session.
        const observed = await manager.getObservedTranscript(msg.agentId);
        if (observed) send(ws, { type: 'backlog', agentId: msg.agentId, summary: observed.summary, events: observed.events });
        else send(ws, { type: 'error', message: `Unknown agent ${msg.agentId}` });
        break;
      }
      case 'input':
        manager.get(msg.agentId)?.send(msg.text);
        break;
      case 'interrupt':
        void manager.get(msg.agentId)?.interrupt();
        break;
      case 'permission':
        manager.get(msg.agentId)?.resolvePermission(msg.requestId, msg.decision, msg.message);
        break;
      case 'rename':
        manager.rename(msg.agentId, msg.title);
        break;
      case 'stop':
        await manager.stop(msg.agentId);
        break;
      case 'restart':
        await manager.restart(msg.agentId);
        break;
      case 'remove':
        await manager.remove(msg.agentId);
        break;
    }
  }

  return wss;
}

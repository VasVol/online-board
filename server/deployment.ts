import { createServer } from 'node:http';
import { chmod, rm } from 'node:fs/promises';

// Reachable only through a mode-0600 Unix socket, never through Caddy/public HTTP.
// A short lease closes the race between observing an empty board and restarting.
export class DeploymentGate {
  private changedAt = Date.now();
  private leasedUntil = 0;
  clients = 0;
  constructor(
    private idleMs = 60_000,
    private leaseMs = 120_000,
  ) {}
  get paused() {
    return Date.now() < this.leasedUntil;
  }
  connected() {
    this.clients++;
    this.changedAt = Date.now();
  }
  disconnected() {
    this.clients--;
    this.changedAt = Date.now();
  }
  status() {
    return { clients: this.clients, idleMs: Date.now() - this.changedAt, paused: this.paused };
  }
  acquire(allowActiveClients = false) {
    if (!allowActiveClients && (this.clients || Date.now() - this.changedAt < this.idleMs))
      return false;
    this.leasedUntil = Date.now() + this.leaseMs;
    return true;
  }
  release() {
    this.leasedUntil = 0;
  }
}

export async function listenDeploymentControl(path: string, gate: DeploymentGate) {
  await rm(path, { force: true });
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && ['/acquire', '/acquire-now'].includes(req.url || '')) {
      // Explicitly enabled by the owner during development; still Unix-socket-only.
      if (!gate.acquire(req.url === '/acquire-now')) res.statusCode = 409;
    } else if (req.method === 'POST' && req.url === '/release') gate.release();
    else if (req.method !== 'GET' || req.url !== '/status') res.statusCode = 404;
    res.end(JSON.stringify(gate.status()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  await chmod(path, 0o600);
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(path, { force: true });
  };
}

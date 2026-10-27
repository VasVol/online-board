import type { Express, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './database.js';
import type { SyncServer } from './sync.js';

const gridSchema = z.object({ enabled: z.boolean() });
const gatherSchema = z.object({
  pageId: z.string().regex(/^[\w-]{1,64}$/),
  source: z.string().uuid(),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().min(0.1).max(30),
  }),
});
export function installBoardControls(
  app: Express,
  store: Store,
  sync: SyncServer,
  ownerOnly: RequestHandler,
  rateLimit: RequestHandler,
) {
  app.patch('/api/boards/:boardId/grid', rateLimit, (req, res) => {
    const id = String(req.params.boardId);
    const state = store.setGrid(id, gridSchema.parse(req.body).enabled);
    sync.broadcastBoardEvent(id, { type: 'grid', ...state });
    res.json(state);
  });
  app.post('/api/boards/:boardId/gather', ownerOnly, rateLimit, (req, res) => {
    const id = String(req.params.boardId);
    const command = gatherSchema.parse(req.body);
    if (store.page(command.pageId)?.boardId !== id) {
      res.status(404).json({ error: 'Страница недоступна' });
      return;
    }
    const event = { type: 'gather' as const, id: randomUUID(), ...command };
    sync.broadcastBoardEvent(id, event);
    res.json({ ok: true });
  });
}

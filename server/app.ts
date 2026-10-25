import express from 'express';
import compression from 'compression';
import { createServer, type IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { Store, secret, hash, equal, type StoredBoard } from './database.js';
import { SyncServer } from './sync.js';

const nameSchema = z.object({ name: z.string().trim().min(1).max(120) });
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
function cookie(req: IncomingMessage) {
  return (
    req.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('pole_owner='))
      ?.slice(11) || ''
  );
}
function publicBoard(board: StoredBoard) {
  const { owner: _, shareKey: __, ...rest } = board;
  return rest;
}
export function createApp(options: {
  dbPath: string;
  publicOrigin?: string;
  staticDir?: string;
  trustLocalProxy?: boolean;
}) {
  const store = new Store(options.dbPath);
  const app = express();
  const server = createServer(app);
  app.disable('x-powered-by');
  // A local HTTPS tunnel terminates TLS before forwarding HTTP to this process.
  // Opt in explicitly; never trust forwarding headers from arbitrary LAN clients.
  if (options.trustLocalProxy) app.set('trust proxy', 'loopback');
  function originAllowed(req: IncomingMessage) {
    const origin = req.headers.origin;
    return (
      !origin ||
      origin === options.publicOrigin ||
      origin === `http://${req.headers.host}` ||
      origin === `https://${req.headers.host}`
    );
  }
  function authorized(req: IncomingMessage, id: string, key?: string) {
    const board = store.board(id);
    return !!board && (board.owner === hash(cookie(req)) || (!!key && equal(board.shareKey, key)));
  }
  const sync = new SyncServer(server, store, authorized, originAllowed);
  app.use((req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !originAllowed(req)) {
      res.status(403).json({ error: 'Недопустимый источник запроса' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '3mb' }));
  const setCookie = (req: express.Request, res: express.Response, key: string) =>
    res.cookie('pole_owner', key, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure || (options.publicOrigin?.startsWith('https://') ?? false),
      maxAge: 365 * 24 * 60 * 60 * 1000,
      path: '/',
    });
  app.get('/api/health', (_req, res) => res.json({ ok: true, schema: 1 }));
  app.post('/api/session', (req, res) => {
    if (!tokenSchema.safeParse(cookie(req)).success) setCookie(req, res, secret());
    res.json({ ok: true });
  });
  app.get('/api/session/export', (req, res) => {
    if (!tokenSchema.safeParse(cookie(req)).success) {
      res.status(401).json({ error: 'Сначала откройте каталог' });
      return;
    }
    res.json({ type: 'pole-owner-key', version: 1, key: cookie(req) });
  });
  app.post('/api/session/restore', (req, res) => {
    setCookie(req, res, tokenSchema.parse(req.body.key));
    res.json({ ok: true });
  });
  app.use('/api/boards', (req, res, next) => {
    if (!tokenSchema.safeParse(cookie(req)).success) {
      res.status(401).json({ error: 'Откройте каталог и попробуйте ещё раз' });
      return;
    }
    next();
  });
  const limits = new Map<string, { count: number; reset: number }>();
  const rateLimit: express.RequestHandler = (req, res, next) => {
    const id = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    if (limits.size > 1000)
      for (const [key, value] of limits) if (value.reset < now) limits.delete(key);
    const counter = limits.get(id);
    if (!counter || counter.reset < now) limits.set(id, { count: 1, reset: now + 60000 });
    else if (++counter.count > 120) {
      res.status(429).json({ error: 'Слишком много запросов. Попробуйте через минуту.' });
      return;
    }
    next();
  };
  function pagination(req: express.Request) {
    return {
      q: z
        .string()
        .max(120)
        .parse(req.query.q ?? ''),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(req.query.limit ?? 24),
      offset: z.coerce
        .number()
        .int()
        .min(0)
        .max(1000000)
        .parse(req.query.offset ?? 0),
    };
  }
  app.get('/api/boards', (req, res) => {
    const { q, limit, offset } = pagination(req);
    res.json(store.listBoards(hash(cookie(req)), q, limit, offset));
  });
  app.post('/api/boards', rateLimit, (req, res) => {
    res
      .status(201)
      .json(publicBoard(store.createBoard(hash(cookie(req)), nameSchema.parse(req.body).name)));
  });
  app.use('/api/boards/:boardId', (req, res, next) => {
    const key = req.headers.authorization?.replace(/^Bearer /, '');
    if (!authorized(req, String(req.params.boardId), key)) {
      res.status(404).json({ error: 'Доска недоступна. Проверьте ссылку доступа.' });
      return;
    }
    res.locals.board = store.board(String(req.params.boardId))!;
    res.locals.isOwner = res.locals.board.owner === hash(cookie(req));
    next();
  });
  const ownerOnly: express.RequestHandler = (_req, res, next) => {
    if (!res.locals.isOwner) {
      res.status(403).json({ error: 'Это действие доступно владельцу' });
      return;
    }
    next();
  };
  app.get('/api/boards/:boardId', (_req, res) =>
    res.json({ board: publicBoard(res.locals.board), isOwner: res.locals.isOwner }),
  );
  app.patch('/api/boards/:boardId', (req, res) => {
    store.renameBoard(String(req.params.boardId), nameSchema.parse(req.body).name);
    res.json({ ok: true });
  });
  app.delete('/api/boards/:boardId', ownerOnly, (req, res) => {
    store.deleteBoard(String(req.params.boardId));
    sync.revoke(String(req.params.boardId));
    res.json({ ok: true });
  });
  app.get('/api/boards/:boardId/share', ownerOnly, (_req, res) =>
    res.json({ key: res.locals.board.shareKey }),
  );
  app.post('/api/boards/:boardId/share', ownerOnly, (req, res) => {
    const key = store.rotateKey(String(req.params.boardId));
    sync.revoke(String(req.params.boardId));
    res.json({ key });
  });
  app.get('/api/boards/:boardId/pages', (req, res) => {
    const { q, limit, offset } = pagination(req);
    res.json(store.listPages(String(req.params.boardId), q, limit, offset));
  });
  app.post('/api/boards/:boardId/pages', rateLimit, (req, res) =>
    res
      .status(201)
      .json(store.createPage(String(req.params.boardId), nameSchema.parse(req.body).name)),
  );
  const pageCheck: express.RequestHandler = (req, res, next) => {
    const page = store.page(String(req.params.pageId));
    if (!page || page.boardId !== String(req.params.boardId)) {
      res.status(404).json({ error: 'Страница недоступна' });
      return;
    }
    res.locals.page = page;
    next();
  };
  app.get('/api/boards/:boardId/pages/:pageId', pageCheck, (_req, res) =>
    res.json(res.locals.page),
  );
  app.patch('/api/boards/:boardId/pages/:pageId', pageCheck, (req, res) => {
    store.renamePage(String(req.params.pageId), nameSchema.parse(req.body).name);
    res.json({ ok: true });
  });
  app.delete('/api/boards/:boardId/pages/:pageId', pageCheck, ownerOnly, (req, res) => {
    if (!store.deletePage(String(req.params.pageId))) {
      res.status(409).json({ error: 'Нельзя удалить последнюю страницу' });
      return;
    }
    sync.revoke(String(req.params.boardId), String(req.params.pageId));
    res.json({ ok: true });
  });
  const fileSchema = z.object({
    id: z.string().regex(/^[\w-]{1,100}$/),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    dataURL: z.string().max(2800000),
    created: z.number(),
    lastRetrieved: z.number().optional(),
  });
  app.put('/api/boards/:boardId/files/:fileId', rateLimit, (req, res) => {
    const file = fileSchema.parse(req.body);
    if (
      file.id !== String(req.params.fileId) ||
      !file.dataURL.startsWith(`data:${file.mimeType};base64,`) ||
      !/^[A-Za-z0-9+/=\r\n]+$/.test(file.dataURL.split(',')[1])
    ) {
      res.status(400).json({ error: 'Некорректное изображение' });
      return;
    }
    store.putFile(String(req.params.boardId), file.id, file);
    res.json({ ok: true });
  });
  app.get('/api/boards/:boardId/files/:fileId', (req, res) => {
    const file = store.getFile(String(req.params.boardId), String(req.params.fileId));
    if (!file) {
      res.status(404).json({ error: 'Изображение ещё не загружено' });
      return;
    }
    res.json(file);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Маршрут не найден' }));
  const staticDir = options.staticDir || resolve('dist');
  if (existsSync(staticDir)) {
    // Compress only public static files, after all private API routes.
    app.use(compression());
    app.use(
      '/assets',
      express.static(resolve(staticDir, 'assets'), { maxAge: '1y', immutable: true }),
      (_req, res) => {
        res.status(404).end();
      },
    );
    app.use(express.static(staticDir, { maxAge: 0 }));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(staticDir, 'index.html')));
  }
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Проверьте введённые данные (название: 1–120 символов).' });
        return;
      }
      const status = (err as { status?: number }).status;
      if (status === 413 || status === 400) {
        res.status(status).json({
          error: status === 413 ? 'Файл слишком большой (максимум 2 МБ).' : 'Некорректный запрос',
        });
        return;
      }
      console.error('Request failed:', err instanceof Error ? err.message : 'unknown');
      res
        .status(500)
        .json({ error: 'Ошибка сервера. Данные в браузере сохранены; проверьте сервер.' });
    },
  );
  return {
    app,
    server,
    store,
    sync,
    close: async () => {
      await sync.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

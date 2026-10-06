import type { Express, ErrorRequestHandler, RequestHandler } from 'express';
import { isAppError, toHttpErrorResponse } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function installTransportMiddleware(app: Express): void {
  app.use(cors());
  app.use(securityHeaders());
}

export function installErrorHandler(app: Express): void {
  const handler: ErrorRequestHandler = (error, _req, res, _next) => {
    logger.error('HTTP error:', error);
    const candidate = error as { status?: number; statusCode?: number };
    const status = isAppError(error) ? error.statusCode : candidate.status ?? candidate.statusCode ?? 500;
    res.status(status).json(toHttpErrorResponse(error));
  };
  app.use(handler);
}

function cors(): RequestHandler {
  return (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  };
}

function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    res.header('X-DNS-Prefetch-Control', 'off');
    next();
  };
}

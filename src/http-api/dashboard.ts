import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import express from 'express';
import type { Application } from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = join(__dirname, '../../dashboard');

export function mountDashboard(app: Application): void {
  if (!existsSync(DASHBOARD_DIR)) return;

  app.use('/dashboard', express.static(DASHBOARD_DIR));
  app.get('/dashboard', (_req, res) => {
    res.sendFile(join(DASHBOARD_DIR, 'index.html'));
  });
}

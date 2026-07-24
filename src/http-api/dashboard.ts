import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import express from 'express';
import type { Application } from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(__dirname, '../../../dashboard'),
  join(__dirname, '../../dashboard'),
  join(process.cwd(), 'dashboard'),
];
const DASHBOARD_DIR = candidates.find((p) => existsSync(p)) ?? candidates[0];

export function mountDashboard(app: Application): void {
  if (!existsSync(DASHBOARD_DIR)) return;

  app.use('/dashboard', express.static(DASHBOARD_DIR));
  app.get('/dashboard', (_req, res) => {
    res.sendFile(join(DASHBOARD_DIR, 'index.html'));
  });
}

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import type { Application } from 'express';

const DASHBOARD_DIR = join(process.cwd(), 'dashboard');

export function mountDashboard(app: Application): void {
  if (!existsSync(DASHBOARD_DIR)) return;

  app.use('/dashboard', express.static(DASHBOARD_DIR));
  app.get('/dashboard', (_req, res) => {
    res.sendFile(join(DASHBOARD_DIR, 'index.html'));
  });
}

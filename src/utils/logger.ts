export const logger = {
  info: (msg: string, meta?: unknown) => {
    const ts = new Date().toISOString();
    if (meta !== undefined) {
      console.log(`[${ts}] INFO: ${msg}`, typeof meta === 'object' ? JSON.stringify(meta) : meta);
    } else {
      console.log(`[${ts}] INFO: ${msg}`);
    }
  },

  warn: (msg: string, meta?: unknown) => {
    const ts = new Date().toISOString();
    if (meta !== undefined) {
      console.warn(`[${ts}] WARN: ${msg}`, typeof meta === 'object' ? JSON.stringify(meta) : meta);
    } else {
      console.warn(`[${ts}] WARN: ${msg}`);
    }
  },

  error: (msg: string, meta?: unknown) => {
    const ts = new Date().toISOString();
    if (meta instanceof Error) {
      console.error(`[${ts}] ERROR: ${msg}`, meta.message, meta.stack);
    } else if (meta !== undefined) {
      console.error(`[${ts}] ERROR: ${msg}`, typeof meta === 'object' ? JSON.stringify(meta) : meta);
    } else {
      console.error(`[${ts}] ERROR: ${msg}`);
    }
  },
};

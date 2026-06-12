import { readAgentConfig } from './helpers.js';
import type { OpencodeConfig } from '../opencode-http/types.js';
import { validateOpencodeConfig } from '../opencode-http/types.js';

export const OPENCODE_CONFIG = readAgentConfig<OpencodeConfig>(
  'opencode',
  validateOpencodeConfig,
);

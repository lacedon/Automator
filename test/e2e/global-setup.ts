import fs from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../../src/core/index';
import { seed, writeSeedConfig } from '../helpers/seed';

export const e2eRoot = path.resolve('test-results', 'e2e');

// Recreates the e2e data dir and config, then seeds it. Returns the config path for AUTOMATOR_CONFIG.
export default function globalSetup(): string {
  fs.rmSync(e2eRoot, { recursive: true, force: true });
  const configPath = writeSeedConfig(e2eRoot);
  const core = bootstrap({ configPath });
  try {
    seed(core);
  } finally {
    core.close();
  }
  return configPath;
}

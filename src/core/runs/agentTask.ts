import fs from 'node:fs';
import path from 'node:path';
import type { Secrets } from '../config/load';
import type { Config } from '../config/schema';
import { providerOptions } from '../config/providers';
import type { ProviderLauncher } from './providerLauncher';

export const AGENT_TASK_TIMEOUT_MS = 10 * 60_000;

// Asks the agent for one task in a fresh folder and returns the content of the file it was told to write, or null.
export type AgentTask = (prompt: string, file: string) => Promise<string | null>;

export interface AgentTaskDeps {
  tmpRoot: string;
  launcherFor(config: Config): ProviderLauncher;
  scope(): { config: Config; secrets: Secrets };
  timeoutMs?: number;
}

export function createAgentTask(deps: AgentTaskDeps): AgentTask {
  const { tmpRoot, timeoutMs = AGENT_TASK_TIMEOUT_MS } = deps;
  return async (prompt, file) => {
    const scope = deps.scope();
    const dir = path.join(tmpRoot, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const proc = deps.launcherFor(scope.config).start({
        cwd: dir,
        prompt,
        model: providerOptions(scope.config, scope.config.provider).defaultModel,
        transcriptPath: path.join(dir, 'transcript.md'),
        logPath: path.join(dir, 'cli.log'),
        env: process.env,
        scope,
      });
      const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
      try {
        await proc.exited;
      } finally {
        clearTimeout(timer);
      }
      const target = path.join(dir, file);
      return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

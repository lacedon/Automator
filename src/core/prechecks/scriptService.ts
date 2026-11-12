import fs from 'node:fs';
import path from 'node:path';
import type { Secrets } from '../config/load';
import type { Config } from '../config/schema';
import { providerOptions } from '../config/providers';
import type { Result } from '../domain/result';
import type { DataDir } from '../files/dataDir';
import type { ProviderLauncher } from '../runs/providerLauncher';
import { generatePrecheckScript, type AgentTask } from './scriptGenerator';

const AGENT_TIMEOUT_MS = 10 * 60_000;

export interface PrecheckScriptServiceDeps {
  dataDir: DataDir;
  launcherFor(config: Config): ProviderLauncher;
  scopeFor(repository: string): { config: Config; secrets: Secrets };
  timeoutMs?: number;
}

export class PrecheckScriptService {
  constructor(private readonly deps: PrecheckScriptServiceDeps) {}

  generate(instructions: string, repository: string): Promise<Result<string>> {
    return generatePrecheckScript(instructions, this.task(repository));
  }

  private task(repository: string): AgentTask {
    const { dataDir, timeoutMs = AGENT_TIMEOUT_MS } = this.deps;
    return async (prompt, file) => {
      const scope = this.deps.scopeFor(repository);
      const dir = path.join(dataDir.precheckTmpRoot(), `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(dir, { recursive: true });
      try {
        const proc = this.deps.launcherFor(scope.config).start({
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
}

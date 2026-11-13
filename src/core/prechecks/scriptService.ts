import type { Secrets } from '../config/load';
import type { Config } from '../config/schema';
import type { Result } from '../domain/result';
import type { DataDir } from '../files/dataDir';
import { createAgentTask } from '../runs/agentTask';
import type { ProviderLauncher } from '../runs/providerLauncher';
import { generatePrecheckScript } from './scriptGenerator';

export interface PrecheckScriptServiceDeps {
  dataDir: DataDir;
  launcherFor(config: Config): ProviderLauncher;
  scopeFor(repository: string): { config: Config; secrets: Secrets };
  timeoutMs?: number;
}

export class PrecheckScriptService {
  constructor(private readonly deps: PrecheckScriptServiceDeps) {}

  generate(instructions: string, repository: string): Promise<Result<string>> {
    const { dataDir, launcherFor, scopeFor, timeoutMs } = this.deps;
    const task = createAgentTask({
      tmpRoot: dataDir.precheckTmpRoot(),
      launcherFor,
      scope: () => scopeFor(repository),
      timeoutMs,
    });
    return generatePrecheckScript(instructions, task);
  }
}

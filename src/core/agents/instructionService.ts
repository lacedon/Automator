import type { Secrets } from '../config/load';
import type { Config } from '../config/schema';
import type { Result } from '../domain/result';
import type { DataDir } from '../files/dataDir';
import { createAgentTask } from '../runs/agentTask';
import type { ProviderLauncher } from '../runs/providerLauncher';
import { generateAgentInstructions } from './instructionGenerator';

export interface AgentInstructionServiceDeps {
  dataDir: DataDir;
  launcherFor(config: Config): ProviderLauncher;
  // The application-default configuration: Agents are not tied to a Repository.
  scope(): { config: Config; secrets: Secrets };
  timeoutMs?: number;
}

export class AgentInstructionService {
  constructor(private readonly deps: AgentInstructionServiceDeps) {}

  generate(instructions: string, additional: string): Promise<Result<string>> {
    const { dataDir, launcherFor, scope, timeoutMs } = this.deps;
    return generateAgentInstructions(
      instructions,
      additional,
      createAgentTask({ tmpRoot: dataDir.agentInstructionTmpRoot(), launcherFor, scope, timeoutMs }),
    );
  }
}

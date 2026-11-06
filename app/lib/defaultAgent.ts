import type { AgentAssignment, WorkflowType } from '@core/index';

// The Agent a Repository and Workflow type resolve to without an override; null when none is assigned.
export function defaultAgentId(
  assignments: AgentAssignment[],
  repository: string,
  workflowType: WorkflowType,
): number | null {
  const match = (repo: string | null) =>
    assignments.find((a) => a.repository === repo && a.workflowType === workflowType);
  return (match(repository) ?? match(null))?.agentId ?? null;
}

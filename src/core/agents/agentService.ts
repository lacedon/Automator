import type { Database } from '../db/open';
import type { Agent, AgentAssignment, OperationTemplate, WorkflowType } from '../domain/types';

type Row = Record<string, unknown>;

function toAgent(row: unknown): Agent {
  const r = row as Row;
  return {
    id: r.id as number,
    name: r.name as string,
    instructions: r.instructions as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function toAssignment(row: unknown): AgentAssignment {
  const r = row as Row;
  return {
    repository: r.repository as string | null,
    workflowType: r.workflow_type as WorkflowType,
    agentId: r.agent_id as number | null,
  };
}

function toTemplate(row: unknown): OperationTemplate {
  const r = row as Row;
  return { workflowType: r.workflow_type as WorkflowType, instructions: r.instructions as string };
}

const legacyNames: Record<'mr-watch' | 'jira-watch' | 'ticket-adhoc', string> = {
  'mr-watch': 'MR Watch',
  'jira-watch': 'Jira Watch',
  'ticket-adhoc': 'Ticket Ad-hoc',
};

export class AgentService {
  constructor(private readonly db: Database) {}

  listAgents(): Agent[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY id').all() as Row[]).map(toAgent);
  }

  listAssignments(): AgentAssignment[] {
    return (this.db.prepare('SELECT * FROM agent_assignments ORDER BY rowid').all() as Row[]).map(toAssignment);
  }

  getAgent(id: number): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    return row === undefined ? null : toAgent(row);
  }

  createAgent(input: { name: string; instructions: string }): Agent {
    const now = Date.now();
    return toAgent(
      this.db
        .prepare('INSERT INTO agents (name, instructions, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING *')
        .get(input.name, input.instructions, now, now),
    );
  }

  updateAgent(id: number, input: { name: string; instructions: string }): Agent | null {
    const row = this.db
      .prepare('UPDATE agents SET name = ?, instructions = ?, updated_at = ? WHERE id = ? RETURNING *')
      .get(input.name, input.instructions, Date.now(), id);
    return row === undefined ? null : toAgent(row);
  }

  assignmentReferences(id: number): AgentAssignment[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM agent_assignments WHERE agent_id = ? ORDER BY repository IS NOT NULL, repository, workflow_type',
        )
        .all(id) as Row[]
    ).map(toAssignment);
  }

  deleteAgent(id: number): AgentAssignment[] | null {
    return this.db
      .transaction(() => {
        const references = this.assignmentReferences(id);
        if (this.getAgent(id) === null) return null;
        this.db.prepare('UPDATE agent_assignments SET agent_id = NULL WHERE agent_id = ?').run(id);
        this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
        return references;
      })
      .immediate();
  }

  assign(repository: string | null, workflowType: WorkflowType, agentId: number): void {
    this.db
      .transaction(() => {
        if (repository === null) {
          this.db
            .prepare(
              `INSERT INTO agent_assignments (repository, workflow_type, agent_id) VALUES (NULL, ?, ?)
               ON CONFLICT (workflow_type) WHERE repository IS NULL DO UPDATE SET agent_id = excluded.agent_id`,
            )
            .run(workflowType, agentId);
        } else {
          this.db
            .prepare(
              `INSERT INTO agent_assignments (repository, workflow_type, agent_id) VALUES (?, ?, ?)
               ON CONFLICT (repository, workflow_type) WHERE repository IS NOT NULL DO UPDATE SET agent_id = excluded.agent_id`,
            )
            .run(repository, workflowType, agentId);
        }
      })
      .immediate();
  }

  clearRepositoryOverride(repository: string, workflowType: WorkflowType): void {
    this.db
      .transaction(() => {
        this.db
          .prepare('DELETE FROM agent_assignments WHERE repository = ? AND workflow_type = ?')
          .run(repository, workflowType);
      })
      .immediate();
  }

  getTemplate(workflowType: WorkflowType): OperationTemplate | null {
    const row = this.db.prepare('SELECT * FROM operation_templates WHERE workflow_type = ?').get(workflowType);
    return row === undefined ? null : toTemplate(row);
  }

  setTemplate(workflowType: WorkflowType, instructions: string | null): void {
    if (instructions === null) {
      this.db.prepare('DELETE FROM operation_templates WHERE workflow_type = ?').run(workflowType);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO operation_templates (workflow_type, instructions) VALUES (?, ?)
         ON CONFLICT (workflow_type) DO UPDATE SET instructions = excluded.instructions`,
      )
      .run(workflowType, instructions);
  }

  resolve(
    repository: string,
    workflowType: WorkflowType,
    agentId: number | null = null,
  ): {
    agent: Agent | null;
    template: OperationTemplate | null;
    assignmentScope: 'override' | 'repository' | 'default' | 'blocked';
  } {
    const repositoryAssignment = this.db
      .prepare('SELECT agent_id FROM agent_assignments WHERE repository = ? AND workflow_type = ?')
      .get(repository, workflowType) as { agent_id: number | null } | undefined;
    const template = this.getTemplate(workflowType);
    const chosen = agentId === null ? null : this.getAgent(agentId);
    if (chosen !== null) return { agent: chosen, template, assignmentScope: 'override' };
    if (repositoryAssignment !== undefined) {
      return {
        agent: repositoryAssignment.agent_id === null ? null : this.getAgent(repositoryAssignment.agent_id),
        template,
        assignmentScope: repositoryAssignment.agent_id === null ? 'blocked' : 'repository',
      };
    }

    const defaultAssignment = this.db
      .prepare('SELECT agent_id FROM agent_assignments WHERE repository IS NULL AND workflow_type = ?')
      .get(workflowType) as { agent_id: number | null } | undefined;
    return {
      agent:
        defaultAssignment === undefined || defaultAssignment.agent_id === null
          ? null
          : this.getAgent(defaultAssignment.agent_id),
      template,
      assignmentScope: defaultAssignment === undefined || defaultAssignment.agent_id !== null ? 'default' : 'blocked',
    };
  }

  importLegacyPrompts(
    repository: string,
    prompts: Pick<Record<WorkflowType, string>, 'mr-watch' | 'jira-watch' | 'ticket-adhoc'>,
  ): 'imported' | 'already-imported' {
    return this.db
      .transaction(() => {
        const marker = `legacy_agent_prompts_imported:${repository}`;
        if (this.db.prepare('SELECT 1 FROM meta WHERE key = ?').get(marker)) return 'already-imported';

        const workflows = Object.keys(legacyNames) as (keyof typeof legacyNames)[];
        const conflicts = workflows.filter((workflow) =>
          this.db
            .prepare('SELECT 1 FROM agent_assignments WHERE repository = ? AND workflow_type = ?')
            .get(repository, workflow),
        );
        if (conflicts.length > 0) {
          throw new Error(
            `Cannot import legacy prompts for Repository "${repository}": existing assignments for ${conflicts.join(', ')}`,
          );
        }

        const now = Date.now();
        for (const workflowType of workflows) {
          const agent = this.db
            .prepare('INSERT INTO agents (name, instructions, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id')
            .get(`${repository} / ${legacyNames[workflowType]}`, prompts[workflowType], now, now) as { id: number };
          this.db
            .prepare('INSERT INTO agent_assignments (repository, workflow_type, agent_id) VALUES (?, ?, ?)')
            .run(repository, workflowType, agent.id);
        }
        this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(marker, 'imported');
        return 'imported';
      })
      .immediate();
  }
}

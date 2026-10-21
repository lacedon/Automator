import type { AppError } from '@core/index';

function describe(error: AppError): string {
  switch (error.code) {
    case 'UNKNOWN_REPOSITORY':
      return `Repository "${error.name}" isn't in the config.`;
    case 'DUPLICATE_WATCH':
      return `A Watch for this target already exists (#${error.existing.id}).`;
    case 'INVALID_TARGET':
      return error.message;
    case 'MISSING_INSTRUCTIONS':
      return 'Instructions are required.';
    case 'INVALID_INPUT':
      return `${error.field}: ${error.message}`;
    case 'INVALID_STATE':
      return `Can't ${error.action} while ${error.state.replace('_', ' ')}.`;
    case 'RUN_IN_PROGRESS':
      return `Run #${error.runId} is in progress.`;
    case 'JIRA_DISABLED':
      return 'Jira is disabled in the config.';
    case 'NOT_FOUND':
      return 'It no longer exists.';
  }
}

export function InlineError({ error }: { error: AppError }) {
  return (
    <div className="error-box" role="alert">
      <code>{error.code}</code> {describe(error)}
    </div>
  );
}

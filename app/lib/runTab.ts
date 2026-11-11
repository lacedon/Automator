export type RunTab = 'transcript' | 'result' | 'prompt' | 'chat';

// `?tab=chat` opens the Chat tab, but only for Runs that belong to a Chat thread.
export function initialRunTab(requested: string | string[] | undefined, hasThread: boolean): RunTab {
  return requested === 'chat' && hasThread ? 'chat' : 'transcript';
}

export function chatHref(runId: number): string {
  return `/runs/${runId}?tab=chat`;
}

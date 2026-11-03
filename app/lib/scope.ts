import { cookies } from 'next/headers';
import type { Project, ProjectScope } from '@core/index';
import { getCore } from './core';

export const SCOPE_COOKIE = 'automator-project';

// The cookie holds 'none' or a Project id; anything that no longer matches a Project falls back to all work.
export function parseScope(value: string | undefined, projects: Project[]): ProjectScope {
  if (value === 'none') return 'none';
  const id = Number(value);
  return projects.some((p) => p.id === id) ? id : null;
}

export async function currentScope(): Promise<ProjectScope> {
  const jar = await cookies();
  return parseScope(jar.get(SCOPE_COOKIE)?.value, getCore().projects.list());
}

export function projectHue(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

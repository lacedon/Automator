import { cookies } from 'next/headers';
import type { Project, ProjectScope } from '@core/index';
import { getCore } from './core';
import { currentUser } from './session';

export const SCOPE_COOKIE = 'automator-project';

// The cookie holds 'none' or a Project id; anything that no longer matches a Project falls back to all work.
export function parseScope(value: string | undefined, projects: Project[]): number | 'none' | null {
  if (value === 'none') return 'none';
  const id = Number(value);
  return projects.some((p) => p.id === id) ? id : null;
}

// Projects the signed-in user can read; everything else is invisible to them.
export async function readableProjects(): Promise<Project[]> {
  const user = await currentUser();
  const { access, projects } = getCore();
  const all = projects.list();
  if (user === null) return [];
  const readable = new Set(
    access.readableProjectIds(
      user.id,
      all.map((p) => p.id),
    ),
  );
  return all.filter((p) => readable.has(p.id));
}

// The Project the user picked in the switcher, if they can still read it.
export async function currentSelection(): Promise<number | 'none' | null> {
  const jar = await cookies();
  return parseScope(jar.get(SCOPE_COOKIE)?.value, await readableProjects());
}

// What lists may show: the selection, narrowed to what the user may read.
export async function currentScope(): Promise<ProjectScope> {
  const user = await currentUser();
  if (user === null) return { projects: [], unassigned: false };
  const { access, projects } = getCore();
  return access.readScope(
    user.id,
    await currentSelection(),
    projects.list().map((p) => p.id),
  );
}

export function projectHue(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

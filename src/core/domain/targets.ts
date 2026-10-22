import type { Config } from '../config/schema';
import { err, ok, type Result } from './result';
import type { WatchKind } from './types';

export type ParsedTarget = {
  kind: WatchKind;
  normalizedTarget: string;
  displayUrl: string;
  gitlab?: { conn: string; host: string; projectPath: string; iid: number; apiProjectId: string };
  jira?: { conn: string; host: string; key: string };
};

const MR_PATH = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:\/.*)?$/;
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;
const JIRA_BROWSE_PATH = /\/browse\/([^/]+)\/?$/;

function invalid(message: string): Result<ParsedTarget> {
  return err({ code: 'INVALID_TARGET', message });
}

// Config hosts may be given as full URLs or bare host names.
function hostOf(value: string): string {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return value.replace(/\/+$/, '').toLowerCase();
  }
}

function jiraTarget(conn: string, baseUrl: string, key: string): ParsedTarget {
  const upper = key.toUpperCase();
  const host = hostOf(baseUrl);
  return {
    kind: 'jira',
    normalizedTarget: `jira:${host}/${upper}`,
    displayUrl: `${baseUrl.replace(/\/+$/, '')}/browse/${upper}`,
    jira: { conn, host, key: upper },
  };
}

export function parseTarget(input: string, config: Config, repository?: string): Result<ParsedTarget> {
  const trimmed = input.trim();

  if (JIRA_KEY.test(trimmed)) {
    const conn = repository === undefined ? undefined : config.repositories[repository]?.jira;
    const connection = conn === undefined ? undefined : config.jira.connections[conn];
    if (conn === undefined || connection === undefined)
      return invalid('Jira key needs a Repository with a Jira connection');
    return ok(jiraTarget(conn, connection.baseUrl, trimmed));
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return invalid(`Not a URL or Jira key: ${trimmed}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return invalid(`Only http(s) URLs are supported: ${trimmed}`);

  const host = url.host.toLowerCase();

  const mr = MR_PATH.exec(url.pathname);
  const gitlabConn = Object.entries(config.gitlab).find(([, c]) => hostOf(c.host) === host)?.[0];
  if (mr && gitlabConn !== undefined) {
    const projectPath = mr[1]!;
    const iid = Number(mr[2]);
    return ok({
      kind: 'mr',
      normalizedTarget: `gitlab:${host}/${projectPath}!${iid}`,
      displayUrl: `${url.protocol}//${host}/${projectPath}/-/merge_requests/${iid}`,
      gitlab: { conn: gitlabConn, host, projectPath, iid, apiProjectId: encodeURIComponent(projectPath) },
    });
  }

  const browse = JIRA_BROWSE_PATH.exec(url.pathname);
  const jiraConn = Object.entries(config.jira.connections).find(([, c]) => hostOf(c.baseUrl) === host);
  if (browse && JIRA_KEY.test(browse[1]!) && jiraConn) {
    return ok(jiraTarget(jiraConn[0], jiraConn[1].baseUrl, browse[1]!));
  }

  url.hash = '';
  if (url.search === '') url.search = ''; // drops a bare "?"
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  // URL always serializes an empty path as "/"; drop it only when nothing follows.
  const normalized = url.pathname === '/' && url.search === '' ? url.href.slice(0, -1) : url.href;
  return ok({ kind: 'free', normalizedTarget: normalized, displayUrl: normalized });
}

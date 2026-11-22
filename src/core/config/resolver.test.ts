import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { testConfig } from '../../../test/helpers/config';
import { tempDb } from '../../../test/helpers/db';
import { testRepositories } from '../../../test/helpers/repositories';
import { ProjectService } from '../projects/projectService';
import { configReloader, loadConfig } from './load';
import { ConfigResolver } from './resolver';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const config = testConfig();
  const { db, cleanup } = tempDb();
  cleanups.push(() => {
    cleanup();
    fs.rmSync(config.configDir, { recursive: true, force: true });
  });
  const projects = new ProjectService(db, testRepositories(db, config));
  const web = projects.create('Web');
  const apps = projects.create('Apps');
  if (!web.ok || !apps.ok) throw new Error('create failed');
  projects.setRepositories(web.value.id, ['pages']);
  const configs = new ConfigResolver(db, config, { GITLAB_TOKEN: 'global', OTHER_TOKEN: 'other' });
  return { config, projects, configs, web: web.value.id, apps: apps.value.id };
}

describe('ConfigResolver', () => {
  test('a Project can override the interface language and rejects unknown ones', () => {
    const { configs, web, apps } = setup();
    expect(configs.forProject(web).locale).toBe('en');
    expect(configs.setValues(web, { locale: 'ru' }).ok).toBe(true);
    expect(configs.forProject(web).locale).toBe('ru');
    expect(configs.forProject(apps).locale).toBe('en');
    expect(configs.setValues(web, { locale: 'fr' }).ok).toBe(false);
  });

  test('interactive settings are Project-overridable and validated', () => {
    const { config, configs, web, apps } = setup();
    expect(
      configs.setValues(web, {
        'runs/maxInteractiveSessions': '5',
        'runs/interactiveIdleMinutes': '10',
        'providers/claude-code/acpBin': '/opt/claude-agent-acp',
        'providers/codex/acpBin': '/opt/codex-acp',
      }),
    ).toMatchObject({ ok: true });
    const effective = configs.forProject(web);
    expect(effective.runs.maxInteractiveSessions).toBe(5);
    expect(effective.runs.interactiveIdleMinutes).toBe(10);
    expect(effective.providers['claude-code'].acpBin).toBe('/opt/claude-agent-acp');
    expect(effective.providers.codex.acpBin).toBe('/opt/codex-acp');
    expect(configs.forProject(apps).runs.maxInteractiveSessions).toBe(config.runs.maxInteractiveSessions);
    for (const [field, value] of [
      ['runs/maxInteractiveSessions', '0'],
      ['runs/maxInteractiveSessions', 'many'],
      ['runs/interactiveIdleMinutes', '-3'],
    ] as const) {
      expect(configs.setValues(web, { [field]: value })).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT', field },
      });
    }
  });

  test('questionWaitMs is Project-overridable as a duration and validated', () => {
    const { config, configs, web, apps } = setup();
    expect(configs.setValues(web, { 'runs/questionWaitMs': '2m' })).toMatchObject({ ok: true });
    expect(configs.forProject(web).runs.questionWaitMs).toBe(120_000);
    expect(configs.forProject(apps).runs.questionWaitMs).toBe(config.runs.questionWaitMs);
    for (const value of ['soon', '0s']) {
      expect(configs.setValues(web, { 'runs/questionWaitMs': value })).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT', field: 'runs/questionWaitMs' },
      });
    }
  });

  test('without overrides the effective config equals the global one', () => {
    const { config, configs } = setup();
    expect(configs.forRepository('pages')).toEqual(config);
    expect(configs.forRepository('api')).toBe(config);
  });

  test('overrides only the given fields and only for that Project', () => {
    const { config, configs, web } = setup();
    expect(configs.setValues(web, { 'runs/timeoutMinutes': '5' })).toMatchObject({ ok: true });
    expect(configs.forRepository('pages').runs.timeoutMs).toBe(5 * 60_000);
    expect(configs.forRepository('pages').schedule).toEqual(config.schedule);
    expect(configs.forRepository('api')).toBe(config);
  });

  test('a Project can override the Copilot bin, default model and models', () => {
    const { configs, web } = setup();
    expect(
      configs.setValues(web, {
        'providers/copilot/bin': '/opt/project-copilot',
        'providers/copilot/defaultModel': 'project-model',
        'providers/copilot/models': 'project-model, other',
      }),
    ).toMatchObject({ ok: true });
    expect(configs.forRepository('pages').providers.copilot).toEqual({
      bin: '/opt/project-copilot',
      defaultModel: 'project-model',
      models: ['project-model', 'other'],
    });
  });

  test('blank values reset to the global setting', () => {
    const { config, configs, web } = setup();
    configs.setValues(web, { 'runs/timeoutMinutes': '5' });
    configs.setValues(web, { 'runs/timeoutMinutes': '' });
    expect(configs.forRepository('pages').runs.timeoutMs).toBe(config.runs.timeoutMs);
    expect(configs.valuesOf(web)).toEqual({});
  });

  test('rejects invalid values and unknown settings without storing them', () => {
    const { configs, web } = setup();
    expect(configs.setValues(web, { 'runs/timeoutMinutes': 'soon' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', field: 'runs/timeoutMinutes' },
    });
    expect(configs.setValues(web, { 'gitlab/corp/tokenEnv': 'not a name!' })).toMatchObject({ ok: false });
    expect(configs.setValues(web, { 'nope/x': '1' })).toMatchObject({ ok: false });
    expect(configs.valuesOf(web)).toEqual({});
  });

  test('a Repository reverts to global when it leaves the Project', () => {
    const { config, configs, projects, web } = setup();
    configs.setValues(web, { 'runs/timeoutMinutes': '5' });
    projects.setRepositories(web, []);
    expect(configs.forRepository('pages')).toBe(config);
  });

  test('credential env names are per Project and every name is withheld from child processes', () => {
    const { config, configs, web } = setup();
    configs.setValues(web, { 'gitlab/corp/tokenEnv': 'OTHER_TOKEN' });
    const effective = configs.forRepository('pages');
    expect(configs.secretsFor(effective).gitlab.corp).toBe('other');
    expect(configs.secretsFor(config).gitlab.corp).toBe('global');
    expect(configs.secretsFor(config).envNames).toEqual(expect.arrayContaining(['GITLAB_TOKEN', 'OTHER_TOKEN']));
  });

  test('a running resolver follows saved schedule changes and keeps the last valid config on a bad edit', () => {
    const { config } = setup();
    const file = path.join(config.configDir, 'automator.config.json');
    const write = (schedule: unknown) =>
      fs.writeFileSync(
        file,
        JSON.stringify({
          dataDir: config.dataDir,
          gitlab: { corp: { host: 'https://gitlab.example.com', tokenEnv: 'GITLAB_TOKEN' } },
          schedule,
        }),
      );
    write({ intervals: { mr: '15m', default: '2h' } });
    const { db, cleanup } = tempDb();
    cleanups.push(cleanup);
    const configs = new ConfigResolver(db, loadConfig({ path: file }), {}, configReloader(file));
    expect(configs.forRepository(null).schedule.intervals.mr).toBe(15 * 60_000);

    write({ intervals: { mr: '5m', default: '2h' }, workingHours: { days: [1], start: '09:00', end: '10:00' } });
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(configs.forRepository(null).schedule.intervals.mr).toBe(5 * 60_000);
    expect(configs.forRepository(null).schedule.workingHours.days).toEqual([1]);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    write({ intervals: { mr: 'soon' } });
    fs.utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    expect(configs.forRepository(null).schedule.intervals.mr).toBe(5 * 60_000);
  });
});

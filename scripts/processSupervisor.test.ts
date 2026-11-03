import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { createProcessSupervisor } from './processSupervisor.mjs';

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true);
  send = vi.fn((message: { type: string; requestId: string }) => {
    this.messages.push(message);
  });
  messages: { type: string; requestId: string }[] = [];

  constructor(readonly name: string) {
    super();
  }

  close(code: number | null = 0, signal: string | null = null): void {
    this.emit('close', code, signal);
  }
}

function setup() {
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const name = ['web', 'worker'][children.length % 2];
    const child = new FakeChild(name);
    children.push(child);
    return child;
  });
  const exit = vi.fn();
  const log = vi.fn();
  const supervisor = createProcessSupervisor({
    spawn,
    commands: { web: ['next', 'start'], worker: ['node', 'worker'] },
    env: { PATH: '/test' },
    exit,
    log,
  });

  return { children, exit, log, spawn, supervisor };
}

describe('createProcessSupervisor', () => {
  test('restarts both processes only after the worker and web child close in order', () => {
    const s = setup();
    s.supervisor.start();
    const [web, worker] = s.children;

    expect(s.spawn).toHaveBeenNthCalledWith(1, 'next', ['start'], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { PATH: '/test' },
    });
    expect(s.spawn).toHaveBeenNthCalledWith(2, 'node', ['worker'], {
      stdio: 'inherit',
      env: { PATH: '/test' },
    });

    web.emit('message', { type: 'restart', requestId: 'restart-1' });

    expect(web.messages).toEqual([{ type: 'restart-accepted', requestId: 'restart-1' }]);
    expect(worker.kill).toHaveBeenCalledWith('SIGTERM');
    expect(web.kill).not.toHaveBeenCalled();

    worker.close();

    expect(web.kill).toHaveBeenCalledWith('SIGTERM');
    expect(s.spawn).toHaveBeenCalledTimes(2);

    web.close();

    expect(s.spawn).toHaveBeenCalledTimes(4);
    expect(s.children.slice(2).map((child) => child.name)).toEqual(['web', 'worker']);
    expect(s.exit).not.toHaveBeenCalled();
  });

  test('rejects duplicate restart requests while a restart is in progress', () => {
    const s = setup();
    s.supervisor.start();
    const [web, worker] = s.children;

    web.emit('message', { type: 'restart', requestId: 'restart-1' });
    web.emit('message', { type: 'restart', requestId: 'restart-2' });

    expect(web.messages).toEqual([
      { type: 'restart-accepted', requestId: 'restart-1' },
      { type: 'restart-rejected', requestId: 'restart-2' },
    ]);
    expect(worker.kill).toHaveBeenCalledTimes(1);
  });

  test('does not restart when the web child exits before the worker drain finishes', () => {
    const s = setup();
    s.supervisor.start();
    const [web, worker] = s.children;

    web.emit('message', { type: 'restart', requestId: 'restart-1' });
    web.close(7);
    worker.close();

    expect(s.spawn).toHaveBeenCalledTimes(2);
    expect(s.exit).toHaveBeenCalledWith(7);
  });

  test('does not restart when the worker fails to close cleanly during restart', () => {
    const s = setup();
    s.supervisor.start();
    const [web, worker] = s.children;

    web.emit('message', { type: 'restart', requestId: 'restart-1' });
    worker.close(9);
    web.close();

    expect(s.spawn).toHaveBeenCalledTimes(2);
    expect(s.exit).toHaveBeenCalledWith(9);
  });

  test('does not restart after a child error during restart', () => {
    const s = setup();
    s.supervisor.start();
    const [web, worker] = s.children;

    web.emit('message', { type: 'restart', requestId: 'restart-1' });
    web.emit('error', new Error('web process failed'));
    web.close(1);
    worker.close();

    expect(s.spawn).toHaveBeenCalledTimes(2);
    expect(s.exit).toHaveBeenCalledWith(1);
    expect(s.log).toHaveBeenCalledWith('[start] web: web process failed');
  });

  test('stops the other process and exits when either child exits unexpectedly', () => {
    const s = setup();
    s.supervisor.start();
    const [web, worker] = s.children;

    web.close(7);

    expect(worker.kill).toHaveBeenCalledWith('SIGTERM');
    expect(s.exit).not.toHaveBeenCalled();

    worker.close();

    expect(s.exit).toHaveBeenCalledWith(7);
    expect(s.log).toHaveBeenCalledWith('[start] web exited (7); stopping the rest');
  });

  test('stops both processes on external shutdown and preserves worker exit status', () => {
    const s = setup();
    s.supervisor.start();
    const [web, worker] = s.children;

    s.supervisor.stop('SIGINT');

    expect(web.kill).toHaveBeenCalledWith('SIGINT');
    expect(worker.kill).toHaveBeenCalledWith('SIGINT');
    expect(s.exit).not.toHaveBeenCalled();

    worker.close(3);
    web.close();

    expect(s.exit).toHaveBeenCalledWith(3);
  });

  test('does not restart when external shutdown arrives during a restart', () => {
    const s = setup();
    s.supervisor.start();
    const [web, worker] = s.children;

    web.emit('message', { type: 'restart', requestId: 'restart-1' });
    s.supervisor.stop('SIGINT');
    worker.close();
    web.close();

    expect(s.spawn).toHaveBeenCalledTimes(2);
    expect(s.exit).toHaveBeenCalledWith(0);
  });
});

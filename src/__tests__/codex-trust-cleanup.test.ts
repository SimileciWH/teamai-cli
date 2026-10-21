import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { describe, expect, it, vi } from 'vitest';
import { readCodexHookTrust } from '../codex-trust.js';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

describe('Codex app-server pipe cleanup', () => {
  it.each([false, true])('releases inherited pipes after a completed or rejected request (reject=%s)', async (reject) => {
    const stdout = new PassThrough();
    const stdin = new Writable({
      write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.toString());
        if (request.id !== undefined) {
          const response = reject
            ? { id: request.id, error: { message: 'fixture rejected initialization' } }
            : { id: request.id, result: request.method === 'hooks/list' ? { data: [{ hooks: [] }] } : {} };
          queueMicrotask(() => stdout.write(`${JSON.stringify(response)}\n`));
        }
        done();
      },
    });
    // The shim exits without closing the stdout inherited by its descendant.
    const child = Object.assign(new EventEmitter(), {
      stdin, stdout, kill: vi.fn(() => true), unref: vi.fn(),
    });
    vi.mocked(crossSpawn).mockReturnValue(child as unknown as ChildProcess);

    const result = await readCodexHookTrust({ codexHome: '/fixture/codex', cwd: '/fixture', hooks: [] });

    expect(result.kind).toBe(reject ? 'failed' : 'listed');
    expect(stdin.destroyed).toBe(true);
    expect(stdout.destroyed).toBe(true);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });
});

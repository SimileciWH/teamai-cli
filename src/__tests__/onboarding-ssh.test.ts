import { describe, expect, it, vi, beforeEach } from 'vitest';
const run = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFileSync: run,
}));
import os from 'node:os';
import { resolveOnboardingSshRemote, sshSearchDirectories, formatOnboardingRemote } from '../onboarding-ssh.js';

describe('onboarding SSH config fallback', () => {
  beforeEach(() => { run.mockReset(); });
  it('redacts all URL userinfo and query secrets from diagnostics', () => {
    for (const remote of ['https://user:p@ss@host/repo.git?token=secret#secret', 'ssh://user:p%40ss@host/repo.git']) {
      expect(formatOnboardingRemote(remote)).toMatch(/^(https|ssh):\/\/host\/repo.git$/);
    }
    expect(formatOnboardingRemote('https://user:secret@[invalid/repo')).toBe('(unparseable remote)');
    expect(formatOnboardingRemote('git@host:repo')).toBe('host:repo');
    for (const helper of ['hg', 'ext']) {
      expect(formatOnboardingRemote(`${helper}::https://user:secret@host/repo`)).toBe('(remote helper address)');
    }
  });
  it('excludes Windows cwd, descendants, empty and relative PATH entries', () => {
    expect(sshSearchDirectories('C:\\repo', ';.;bin;C:\\repo;C:\\repo\\tools;C:\\Windows\\System32\\OpenSSH;D:\\tools', 'win32'))
      .toEqual(['C:\\Windows\\System32\\OpenSSH', 'D:\\tools']);
  });
  it('excludes POSIX cwd and descendants without excluding sibling paths', () => {
    expect(sshSearchDirectories('/repo', ':.:tools:/repo:/repo/bin:/repo-other:/usr/bin', 'linux'))
      .toEqual(['/repo-other', '/usr/bin']);
  });
  it('resolves a local alias without making a network connection', () => {
    run.mockReturnValue('hostname code.example\nport 29418\nuser developer\n');
    expect(resolveOnboardingSshRemote('ssh://alias/repo/fw.git', os.tmpdir()).remote)
      .toBe('ssh://code.example:29418/repo/fw.git');
    expect(run).toHaveBeenCalledWith(expect.stringMatching(/^\//), ['-G', '--', 'alias'], expect.objectContaining({ cwd: os.tmpdir(), timeout: 3000, shell: false }));
  });
  it('supports Git SSH scheme aliases', () => {
    run.mockReturnValue('hostname code.example\nport 29418\n');
    for (const scheme of ['git+ssh', 'ssh+git']) {
      expect(resolveOnboardingSshRemote(`${scheme}://alias/repo/fw`, os.tmpdir()).remote)
        .toBe('ssh://code.example:29418/repo/fw');
    }
  });
  it('passes explicit user and port to SSH and preserves the repository path', () => {
    run.mockReturnValue('hostname code.example\nport 29419\n');
    expect(resolveOnboardingSshRemote('ssh://rd@alias:29419/repo/Fw', os.tmpdir()).remote)
      .toBe('ssh://code.example:29419/repo/Fw');
    expect(run.mock.calls[0][1]).toEqual(['-G', '-p', '29419', '-l', 'rd', '--', 'alias']);
  });
  it('supports SCP syntax, including relative repository paths', () => {
    run.mockReturnValue('hostname code.example\nport 29418\n');
    expect(resolveOnboardingSshRemote('rd@alias:repo/fw', os.tmpdir()).remote).toBe('ssh://code.example:29418/repo/fw');
  });
  it('supports IPv6 hostnames', () => {
    run.mockReturnValue('hostname 2001:db8::1\nport 22\n');
    expect(resolveOnboardingSshRemote('ssh://[2001:db8::1]/repo/fw', os.tmpdir()).remote).toBe('ssh://[2001:db8::1]:22/repo/fw');
  });
  it('does not invoke SSH for other transports or unsafe destinations', () => {
    for (const input of ['SSH://alias/fw', 'https://code.example/fw', '/tmp/fw', 'ssh://-option/fw', 'ssh://rd%3Btouch@alias/fw', 'ssh://rd:secret@alias/fw']) {
      expect(resolveOnboardingSshRemote(input, os.tmpdir()).remote).toBeUndefined();
    }
    expect(run).not.toHaveBeenCalled();
  });
  it('reports failures without leaking subprocess stderr', () => {
    run.mockImplementation(() => { throw new Error('secret stderr'); });
    const result = resolveOnboardingSshRemote('ssh://alias/fw', os.tmpdir());
    expect(result.remote).toBeUndefined();
    expect(result.diagnostic).toContain('ssh -G');
    expect(result.diagnostic).not.toContain('secret');
  });
  it('rejects invalid or incomplete SSH output', () => {
    for (const output of ['hostname code.example\n', 'hostname code.example\nport 0\n', 'hostname code.example\nport 65536\n', 'hostname bad;host\nport 22\n']) {
      run.mockReturnValue(output);
      expect(resolveOnboardingSshRemote('ssh://alias/fw', os.tmpdir()).remote).toBeUndefined();
    }
  });
});

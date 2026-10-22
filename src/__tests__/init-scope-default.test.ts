import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInheritUserScope, resolveInitScope, resolveInitRepo } from '../init.js';

describe('resolveInitScope', () => {
  const cwd = '/tmp/my-project';
  const home = '/home/alice';

  it('defaults to project with projectRoot = cwd when scope is omitted', () => {
    const result = resolveInitScope(undefined, cwd, home);
    expect(result).toEqual({
      scope: 'project',
      projectRoot: cwd,
      explicit: false,
    });
  });

  it('uses user scope when --scope user is explicit', () => {
    const result = resolveInitScope('user', cwd, home);
    expect(result).toEqual({
      scope: 'user',
      projectRoot: undefined,
      explicit: true,
    });
  });

  it('uses project scope when --scope project is explicit', () => {
    const result = resolveInitScope('project', cwd, home);
    expect(result).toEqual({
      scope: 'project',
      projectRoot: cwd,
      explicit: true,
    });
  });

  it('uses the workspace scope when --scope workspace is explicit', () => {
    const result = resolveInitScope('workspace', cwd, home);
    expect(result).toEqual({
      scope: 'project',
      projectRoot: cwd,
      explicit: true,
    });
  });

  it('throws on invalid scope values', () => {
    expect(() => resolveInitScope('global', cwd, home)).toThrow('Invalid scope "global". Use "workspace" or "user".');
  });

  it('refuses the implicit default in the home directory instead of installing for the user account', () => {
    expect(() => resolveInitScope(undefined, home, home)).toThrow(
      'Refusing to install in your home directory without --scope',
    );
  });

  it('names both ways out when refusing at home: a source checkout, or --scope user', () => {
    let message = '';
    try {
      resolveInitScope(undefined, home, home);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/source checkout/);
    expect(message).toMatch(/--scope user/);
  });

  it('treats symlink-equivalent cwd/home as the same path (macOS /var vs /private/var)', () => {
    // /tmp may realpath to /private/tmp on macOS — both args go through realpath
    expect(() => resolveInitScope(undefined, '/tmp', '/tmp')).toThrow(
      'Refusing to install in your home directory without --scope',
    );
  });

  it('refuses the implicit default through a symlink that points at home', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-scope-home-'));
    try {
      const realHome = path.join(root, 'home');
      const linkedHome = path.join(root, 'linked-home');
      fs.mkdirSync(realHome, { recursive: true });
      fs.symlinkSync(realHome, linkedHome, process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => resolveInitScope(undefined, linkedHome, realHome)).toThrow(
        'Refusing to install in your home directory without --scope',
      );
      expect(() => resolveInitScope(undefined, realHome, linkedHome)).toThrow(
        'Refusing to install in your home directory without --scope',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['workspace', 'project'])('throws when --scope %s is explicit and cwd === home (E1)', (scope) => {
    expect(() => resolveInitScope(scope, home, home)).toThrow(
      'Cannot use the workspace scope in your home directory',
    );
  });

  it('allows explicit --scope user when cwd === home', () => {
    const result = resolveInitScope('user', home, home);
    expect(result).toEqual({
      scope: 'user',
      projectRoot: undefined,
      explicit: true,
    });
  });
});

describe('resolveInheritUserScope', () => {
  it('enables inheritance only for workspace scope', () => {
    expect(resolveInheritUserScope('project', true, undefined)).toBe(true);
    expect(() => resolveInheritUserScope('user', true, undefined)).toThrow(
      /only be used with workspace scope/,
    );
  });

  it('preserves an existing project setting when the flag is omitted', () => {
    expect(resolveInheritUserScope('project', undefined, true)).toBe(true);
    expect(resolveInheritUserScope('project', undefined, false)).toBe(false);
  });

  it('allows an explicit disable and ignores the setting for user scope', () => {
    expect(resolveInheritUserScope('project', false, true)).toBe(false);
    expect(resolveInheritUserScope('user', false, true)).toBeUndefined();
  });
});

describe('resolveInitRepo', () => {
  it('uses positional when only positional is set', () => {
    expect(resolveInitRepo('owner/repo', undefined)).toBe('owner/repo');
  });

  it('uses --repo when only --repo is set (no deprecation)', () => {
    expect(resolveInitRepo(undefined, 'owner/repo')).toBe('owner/repo');
  });

  it('accepts identical positional and --repo', () => {
    expect(resolveInitRepo('owner/repo', 'owner/repo')).toBe('owner/repo');
  });

  it('throws when positional and --repo conflict', () => {
    expect(() => resolveInitRepo('a/b', 'c/d')).toThrow(/Conflicting repo values/);
  });

  it('returns undefined when neither is set', () => {
    expect(resolveInitRepo(undefined, undefined)).toBeUndefined();
    expect(resolveInitRepo('', '  ')).toBeUndefined();
  });

  it('trims whitespace', () => {
    expect(resolveInitRepo('  owner/repo  ', undefined)).toBe('owner/repo');
    expect(resolveInitRepo(undefined, '  owner/repo  ')).toBe('owner/repo');
  });
});

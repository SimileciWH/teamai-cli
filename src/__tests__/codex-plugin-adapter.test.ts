import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexPluginAdapter } from '../pkg/adapters/codex-plugin.js';
import { PackageLockSchema, PackageManifestSchema } from '../pkg/types.js';
import { hasPackageDeclarations, sharedPackageDeclarationHash } from '../pkg/manifest.js';
import type { CommandExecutor } from '../utils/exec.js';

const declaration = {
  marketplaces: [{ name: 'team', repo: '.' }],
  plugins: [{ name: 'thinking@team', version: '1.0.0' }],
};
const context = { cwd: '/firmware', declarationRoot: '/docs', scope: 'user' as const };

function executor(version = '1.0.0', enabled = true, source = '/docs') {
  return vi.fn<CommandExecutor>().mockImplementation(async (_command, args) => {
    let value: unknown;
    if (args.includes('--help')) return { code: 0, stdout: 'add --json', stderr: '' };
    if (args[1] === 'marketplace' && args[2] === 'add') {
      value = { marketplaceName: 'team', installedRoot: '/docs' };
    } else if (args[1] === 'marketplace') {
      value = { marketplaces: [{ name: 'team', root: '/docs', marketplaceSource: { sourceType: 'local', source } }] };
    } else if (args[1] === 'add') {
      value = { pluginId: 'thinking@team', version };
    } else {
      value = { installed: [{ pluginId: 'thinking@team', version, enabled, installed: true }] };
    }
    return { code: 0, stdout: JSON.stringify(value), stderr: '' };
  });
}

describe('Codex native package adapter', () => {
  it('loads declarations, includes Codex in acknowledgement hashes and preserves its lock', () => {
    const first = PackageManifestSchema.parse({ packages: { codex: declaration } });
    const next = PackageManifestSchema.parse({ packages: { codex: { ...declaration, plugins: [{ name: 'thinking@team', version: '2.0.0' }] } } });
    expect(hasPackageDeclarations(first)).toBe(true);
    expect(sharedPackageDeclarationHash(first)).not.toBe(sharedPackageDeclarationHash(next));
    expect(PackageLockSchema.parse({ packages: { codex: { marketplaces: [], plugins: [] } } }).packages.codex).toBeDefined();
    expect(() => PackageManifestSchema.parse({ packages: { codex: { marketplaces: [], plugins: declaration.plugins } } })).toThrow();
  });

  it('resolves local sources against the team clone and verifies the native installed state', async () => {
    const execute = executor();
    const adapter = new CodexPluginAdapter(execute);
    const lock = await adapter.install(declaration, context);
    expect(execute).toHaveBeenCalledWith('codex', ['plugin', 'marketplace', 'add', '/docs', '--json'], expect.any(Object));
    expect(lock.plugins).toEqual([{ id: 'thinking@team', version: '1.0.0', scope: 'user', enabled: true }]);
    expect((await adapter.marketplaceStatus(declaration, context))[0].installed).toBe(true);
  });

  it.each(['..', '~/team-market'])('expands the local source %s before native registration and repeated comparisons', async (repo) => {
    const root = repo === '..' ? path.resolve('/docs', '..') : path.join(os.homedir(), 'team-market');
    const execute = executor('1.0.0', true, root);
    const adapter = new CodexPluginAdapter(execute);
    const local = { ...declaration, marketplaces: [{ name: 'team', repo }] };
    await adapter.install(local, context);
    await adapter.install(local, context);
    expect(execute).toHaveBeenCalledWith('codex', ['plugin', 'marketplace', 'add', root, '--json'], expect.any(Object));
    expect(execute.mock.calls.some(call => call[1].includes('upgrade'))).toBe(false);
  });

  it('uses the recorded Codex home even when the invoking shell has a different one', async () => {
    const execute = executor();
    await new CodexPluginAdapter(execute, '/member/.codex-work').install(declaration, context);
    for (const call of execute.mock.calls) expect(call[2]?.env?.CODEX_HOME).toBe('/member/.codex-work');
  });

  it('refuses to replace another teams marketplace with the same name', async () => {
    const execute = executor();
    const foreign = { ...declaration, marketplaces: [{ name: 'team', repo: '/another-team' }] };
    await expect(new CodexPluginAdapter(execute).install(foreign, context)).rejects.toThrow('different source');
    expect(execute.mock.calls.some(call => call[1].includes('add') && !call[1].includes('--help'))).toBe(false);
  });

  it('refreshes an existing Git marketplace before reinstalling the declared plugin', async () => {
    const execute = executor();
    const base = execute.getMockImplementation()!;
    execute.mockImplementation(async (command, args, opts) => args[1] === 'marketplace' && args[2] === 'list'
      ? { code: 0, stdout: JSON.stringify({ marketplaces: [] }), stderr: '' }
      : base(command, args, opts));
    await new CodexPluginAdapter(execute).install({ ...declaration, marketplaces: [{ name: 'team', repo: 'https://example.test/team.git', ref: 'release' }] }, context);
    const args = execute.mock.calls.map(call => call[1]);
    expect(args.findIndex(call => call.includes('upgrade'))).toBeLessThan(args.findIndex(call => call[1] === 'add' && !call.includes('--help')));
  });

  it.each(['acme/team', 'https://github.com/acme/team', 'https://github.com/acme/team/'])('accepts the native canonical source for %s on repeat install', async (repo) => {
    const execute = executor('1.0.0', true, 'https://github.com/acme/team.git');
    await new CodexPluginAdapter(execute).install({ ...declaration, marketplaces: [{ name: 'team', repo }] }, context);
    expect(execute.mock.calls.some(call => call[1].includes('remove'))).toBe(false);
  });

  it('checks native configured refs and changes a pin only when the previous receipt still owns it', async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-refs-'));
    const repo = 'https://github.com/acme/team.git';
    fs.writeFileSync(path.join(codexHome, 'config.toml'), `[marketplaces.team]\nsource_type = "git"\nsource = "${repo}"\nref = "old-pin"\n`);
    try {
      const execute = executor('1.0.0', true, repo);
      const adapter = new CodexPluginAdapter(execute, codexHome);
      const pinned = { ...declaration, marketplaces: [{ name: 'team', repo, ref: 'old-pin' }] };
      expect((await adapter.marketplaceStatus(pinned, context))[0].installed).toBe(true);
      const updated = { ...declaration, marketplaces: [{ name: 'team', repo, ref: 'new-pin' }] };
      await expect(adapter.install(updated, context)).rejects.toThrow('not owned');
      expect(execute.mock.calls.some(call => call[1].includes('remove'))).toBe(false);
      await adapter.install(updated, { ...context, previousPackages: { codex: {
        marketplaces: [{ name: 'team', repo, ref: 'old-pin' }], plugins: [],
      } } });
      expect(execute.mock.calls.some(call => call[1][2] === 'remove')).toBe(true);
    } finally { fs.rmSync(codexHome, { recursive: true, force: true }); }
  });

  it('does not write a successful result for a version mismatch or disabled native plugin', async () => {
    await expect(new CodexPluginAdapter(executor('0.9.0')).install(declaration, context)).rejects.toThrow('version mismatch');
    await expect(new CodexPluginAdapter(executor('1.0.0', false)).install(declaration, context)).rejects.toThrow('did not become active');
  });

  it('keeps native failures visible instead of treating them as an empty inventory', async () => {
    const execute = executor();
    execute.mockImplementation(async (_command, args) => args.includes('--help')
      ? { code: 0, stdout: '--json', stderr: '' }
      : { code: 1, stdout: '', stderr: 'permission denied' });
    await expect(new CodexPluginAdapter(execute).install(declaration, context)).rejects.toThrow('permission denied');
  });

  it('makes dry runs inert and refuses unsupported project scope before mutation', async () => {
    const execute = executor();
    const adapter = new CodexPluginAdapter(execute);
    await adapter.install(declaration, { ...context, dryRun: true });
    expect(execute).not.toHaveBeenCalled();
    await expect(adapter.install(declaration, { ...context, scope: 'project' })).rejects.toThrow('user scope');
    expect(execute).not.toHaveBeenCalled();
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { getUserHome } from '../../utils/home.js';
import { formatCommand, type CommandExecutor } from '../../utils/exec.js';
import { log } from '../../utils/logger.js';
import type { CodexEcosystem, PackageLock, PackageStatus } from '../types.js';
import { PackageAdapter, type PackageInstallContext } from './base.js';

type CodexLock = NonNullable<PackageLock['packages']['codex']>;
interface InstalledPlugin {
  pluginId: string;
  version?: string;
  enabled?: boolean;
  installed?: boolean;
}
interface Marketplace {
  name: string;
  root: string;
  marketplaceSource?: { sourceType: string; source: string; ref?: string };
}

function sourcePath(repo: string, context: PackageInstallContext): string {
  if (/^~[\\/]/.test(repo)) return path.resolve(getUserHome(), repo.slice(2));
  return repo === '.' || repo === '..' || /^\.{1,2}[\\/]/.test(repo)
    ? path.resolve(context.declarationRoot ?? context.cwd, repo) : repo;
}

function comparableSource(source: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) source = `https://github.com/${source.replace(/\.git$/, '')}.git`;
  const github = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/?$/.exec(source);
  if (github) source = `https://github.com/${github[1].replace(/\.git$/, '')}.git`;
  if (!path.isAbsolute(source)) return source.replace(/\/$/, '');
  try { return fs.realpathSync(source); } catch { return path.resolve(source); }
}

/** Use the native CLI as the owner of Codex plugin config and cache. */
export class CodexPluginAdapter extends PackageAdapter<CodexEcosystem, CodexLock> {
  readonly ecosystem = 'codex' as const;

  constructor(executor?: CommandExecutor, private readonly codexHome?: string) { super(executor); }

  private environment(): NodeJS.ProcessEnv {
    return { ...process.env, ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}) };
  }

  private configuredRefs(): Record<string, { source?: string; ref?: string }> {
    const configPath = path.join(this.codexHome ?? process.env.CODEX_HOME ?? path.join(getUserHome(), '.codex'), 'config.toml');
    if (!fs.existsSync(configPath)) return {};
    // The list command omits refs. Read native config for verification; never rewrite it ourselves.
    const config = parse(fs.readFileSync(configPath, 'utf8'));
    return (config.marketplaces ?? {}) as Record<string, { source?: string; ref?: string }>;
  }

  async detect(_cwd: string): Promise<boolean> {
    try {
      const result = await this.execute('codex', ['plugin', 'add', '--help'], { timeoutMs: 5_000, env: this.environment() });
      return result.code === 0 && /--json/.test(result.stdout);
    } catch { return false; }
  }

  private async native<T>(args: string[], cwd?: string): Promise<T> {
    const result = await this.execute('codex', ['plugin', ...args, '--json'], {
      cwd, timeoutMs: 120_000, env: this.environment(),
    });
    if (result.code !== 0) throw new Error(
      `Codex plugin command failed (${args.join(' ')}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
    return JSON.parse(result.stdout) as T;
  }

  private async plugins(declaration: CodexEcosystem): Promise<InstalledPlugin[]> {
    const rows: InstalledPlugin[] = [];
    for (const marketplace of declaration.marketplaces) {
      const result = await this.native<{ installed: InstalledPlugin[] }>(['list', '--marketplace', marketplace.name]);
      if (!Array.isArray(result.installed)) throw new Error('Unsupported Codex plugin list JSON');
      rows.push(...result.installed);
    }
    return rows;
  }

  async install(declaration: CodexEcosystem, context: PackageInstallContext): Promise<CodexLock> {
    if (context.scope !== 'user') throw new Error('Codex native plugins require TeamAI user scope.');
    if (!context.dryRun && !await this.detect(context.cwd)) {
      throw new Error('Codex native plugin CLI is unavailable. Install or upgrade Codex, then retry.');
    }
    const marketplaces: CodexLock['marketplaces'] = [];
    const configured = context.dryRun ? [] : (await this.native<{ marketplaces: Marketplace[] }>(['marketplace', 'list'])).marketplaces;
    if (!Array.isArray(configured)) throw new Error('Unsupported Codex marketplace list JSON');
    const refs = context.dryRun ? {} : this.configuredRefs();
    for (const marketplace of declaration.marketplaces) {
      const repo = sourcePath(marketplace.repo, context);
      const existing = configured.find(item => item.name === marketplace.name);
      if (existing && comparableSource(existing.marketplaceSource?.source ?? '') !== comparableSource(repo)) {
        throw new Error(`Codex marketplace ${marketplace.name} already belongs to a different source. Use a distinct marketplace name or CODEX_HOME.`);
      }
      const args = ['marketplace', 'add', repo, ...(marketplace.ref ? ['--ref', marketplace.ref] : [])];
      if (context.dryRun) {
        log.info(`[dry-run] Would run: ${formatCommand('codex', ['plugin', ...args, '--json'])}`);
        continue;
      }
      const previous = context.previousPackages?.codex?.marketplaces.find(item => item.name === marketplace.name);
      const nativeConfig = refs[marketplace.name];
      const refChanged = existing && nativeConfig && nativeConfig.ref !== marketplace.ref;
      if (refChanged) {
        if (!previous?.repo || comparableSource(previous.repo) !== comparableSource(repo) || previous.ref !== nativeConfig.ref) {
          throw new Error(`Codex marketplace ${marketplace.name} has a different ref not owned by this TeamAI lock. Use a separate CODEX_HOME or reconcile it explicitly.`);
        }
        await this.native(['marketplace', 'remove', marketplace.name], context.cwd);
      }
      let receipt: { marketplaceName: string; installedRoot: string };
      try {
        receipt = await this.native(args, context.cwd);
      } catch (error) {
        if (refChanged && previous?.repo) {
          try {
            await this.native(['marketplace', 'add', previous.repo, ...(previous.ref ? ['--ref', previous.ref] : [])], context.cwd);
          } catch (restoreError) {
            throw new Error(`${(error as Error).message}; restoring previous marketplace also failed: ${(restoreError as Error).message}`);
          }
        }
        throw error;
      }
      if (receipt.marketplaceName !== marketplace.name) {
        throw new Error(`Codex marketplace name mismatch: expected ${marketplace.name}, got ${receipt.marketplaceName}`);
      }
      // Native add registers a Git source but does not refresh an existing snapshot.
      if (!path.isAbsolute(repo)) await this.native(['marketplace', 'upgrade', marketplace.name], context.cwd);
      marketplaces.push({ name: marketplace.name, repo, ref: marketplace.ref, installLocation: receipt.installedRoot });
    }
    for (const plugin of declaration.plugins) {
      if (context.dryRun) {
        log.info(`[dry-run] Would run: ${formatCommand('codex', ['plugin', 'add', plugin.name, '--json'])}`);
        continue;
      }
      // Re-adding refreshes the native cache after a pinned marketplace changes.
      const receipt = await this.native<{ pluginId: string; version: string }>(['add', plugin.name], context.cwd);
      if (receipt.pluginId !== plugin.name || (plugin.version && receipt.version !== plugin.version)) {
        throw new Error(`Codex plugin identity/version mismatch for ${plugin.name}: installed ${receipt.version}`);
      }
    }
    if (context.dryRun) return { marketplaces: [], plugins: [] };
    const installed = new Map((await this.plugins(declaration)).map(item => [item.pluginId, item]));
    const plugins = declaration.plugins.map(plugin => {
      const actual = installed.get(plugin.name);
      if (!actual || actual.installed !== true || actual.enabled !== true ||
          (plugin.version && actual.version !== plugin.version)) {
        throw new Error(`Codex plugin did not become active at the declared version: ${plugin.name}`);
      }
      return { id: plugin.name, version: actual.version ?? 'unknown', scope: 'user', enabled: true };
    });
    return { marketplaces, plugins };
  }

  async status(declaration: CodexEcosystem, context: PackageInstallContext): Promise<PackageStatus[]> {
    if (!await this.detect(context.cwd)) return declaration.plugins.map(p => ({
      name: p.name, installed: false, detail: 'Codex native plugin CLI unavailable',
    }));
    const installed = new Map((await this.plugins(declaration)).map(item => [item.pluginId, item]));
    return declaration.plugins.map(plugin => {
      const actual = installed.get(plugin.name);
      const matches = !!actual && actual.installed === true && (!plugin.version || actual.version === plugin.version);
      return { name: plugin.name, installed: matches, version: actual?.version, enabled: actual?.enabled,
        ...(!matches ? { detail: `expected ${plugin.version ?? 'installed'}, found ${actual?.version ?? 'missing'}` } : {}) };
    });
  }

  async marketplaceStatus(declaration: CodexEcosystem, context: PackageInstallContext): Promise<PackageStatus[]> {
    const result = await this.native<{ marketplaces: Marketplace[] }>(['marketplace', 'list']);
    if (!Array.isArray(result.marketplaces)) throw new Error('Unsupported Codex marketplace list JSON');
    const refs = this.configuredRefs();
    return declaration.marketplaces.map(item => {
      const actual = result.marketplaces.find(row => row.name === item.name);
      const source = actual?.marketplaceSource?.source;
      const same = !!source && comparableSource(source) === comparableSource(sourcePath(item.repo, context));
      const refMatches = refs[item.name]?.ref === item.ref;
      return { name: item.name, installed: same && refMatches,
        detail: same && refMatches ? source : 'marketplace source or ref does not match declaration' };
    });
  }
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const CLI = path.resolve('dist/cli.js');
const TEAM = 'ssh://teamai-fixture.invalid:29418/team/ai-docs';
const SOURCE = 'ssh://source-fixture.invalid:29418/firmware/a';
let root: string;

function fixture(name: string, agents: string[], failingPostPull = false) {
  const base = path.join(root, name);
  const home = path.join(base, 'home');
  const project = path.join(base, 'arbitrary-checkout-name');
  const repo = path.join(base, 'team');
  const bin = path.join(base, 'bin');
  for (const dir of [home, project, repo, bin]) fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const agent of agents) {
    fs.writeFileSync(path.join(bin, agent), '#!/bin/sh\nprintf "fixture-cli\\n"\n', { mode: 0o755 });
  }
  const ssh = path.join(bin, 'fixture-ssh');
  fs.writeFileSync(ssh, '#!/bin/sh\ncase "$*" in\n  *git-upload-pack*) exec git-upload-pack "$TEAMAI_TEST_REPO" ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
  const gitconfig = path.join(base, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n name = Fixture\n email = fixture@example.invalid\n');
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: home, USERPROFILE: home,
    GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSH_COMMAND: ssh, GIT_SSH_VARIANT: 'ssh', TEAMAI_TEST_REPO: repo,
    TEAMAI_NONINTERACTIVE: '1', CI: '1', NO_COLOR: '1',
  };
  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 15_000 });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }
  const write = (file: string, content: string) => {
    const target = path.join(repo, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write('teamai.yaml', YAML.stringify({
    team: 'Fixture', repo: TEAM, provider: 'git', gerrit: { targetBranch: 'main', wip: true },
    onboarding: { defaultRole: 'rd' }, autoUpdate: false, usageReport: false,
    sharing: { recall: { enabled: false }, webhooks: { enabled: false }, env: { injectShellProfile: false }, gitExclude: { enabled: true } },
    scripts: { postPull: { path: 'ready.mjs' } },
  }));
  write('manifest/roles.yaml', YAML.stringify({ version: 1, roles: [
    { id: 'rd', resources: { knowledge: [], skills: ['common'] } },
    { id: 'maintainer', resources: { knowledge: [], skills: ['common', 'maintenance'] } },
  ] }));
  write('manifest/projects.yaml', YAML.stringify({ version: 1, projects: [
    { id: 'fw-a', repositories: [SOURCE], resources: { skills: ['fw-a'] } },
    { id: 'fw-b', repositories: ['ssh://source-fixture.invalid:29418/firmware/b'], resources: { skills: ['fw-b'] } },
  ] }));
  for (const [ns, skill] of [['common', 'common-probe'], ['fw-a', 'project-a-probe'], ['fw-b', 'project-b-probe']]) {
    write(`skills/${ns}/${skill}/SKILL.md`, `---\nname: ${skill}\ndescription: Fixture resource selection.\n---\n${skill}\n`);
  }
  write('ready.mjs', failingPostPull ? 'process.exit(3);\n'
    : "import fs from 'node:fs'; fs.writeFileSync(process.env.TEAMAI_REPO + '/.git/ready-marker', 'ready');\n");
  git(repo, 'init', '-b', 'main'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Fixture resources');
  git(project, 'init', '-b', 'main'); git(project, 'remote', 'add', 'origin', SOURCE);
  fs.writeFileSync(path.join(project, 'README.md'), 'Firmware fixture\n');
  git(project, 'add', '.'); git(project, 'commit', '-m', 'Fixture source');
  const head = git(project, 'rev-parse', 'HEAD');

  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: 'utf8', timeout: 60_000 });
    return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, error: result.error };
  };
  /** Run from another directory, for the $HOME scope refusal. */
  const runIn = (cwd: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
    return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, error: result.error };
  };
  const configFile = () => {
    const partitions = path.join(home, '.teamai/projects');
    if (!fs.existsSync(partitions)) return undefined;
    return fs.readdirSync(partitions).map(dir => path.join(partitions, dir, 'config.yaml')).find(file => fs.existsSync(file));
  };
  return { project, home, repo, git, head, run, runIn, configFile };
}

describe.skipIf(process.platform === 'win32')('short workspace init with the built CLI', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error('Build the CLI first');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-short-init-'));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('refuses the implicit default in HOME before authenticating, cloning or writing config', () => {
    const f = fixture('implicit-at-home', ['codex']);
    const result = f.runIn(f.home, 'init', TEAM);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Refusing to install in your home directory without --scope');
    expect(result.output).toMatch(/source checkout/);
    expect(result.output).toMatch(/--scope user/);
    // Nothing was bound: no auth, no clone, no config, no deliveries.
    expect(result.output).not.toContain('Checking Git identity');
    expect(result.output).not.toContain('Checking authentication');
    expect(result.output).not.toContain('Team repo cloned');
    expect(fs.existsSync(path.join(f.home, '.teamai/config.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(f.home, '.teamai/team-repo'))).toBe(false);
    expect(fs.existsSync(path.join(f.home, '.codex/skills'))).toBe(false);
    expect(f.configFile()).toBeUndefined();
  }, 90_000);

  it('refuses the implicit default when the working directory is a symlink to HOME', () => {
    const f = fixture('symlink-at-home', ['codex']);
    const linkedHome = path.join(path.dirname(f.home), 'linked-home');
    fs.symlinkSync(f.home, linkedHome);
    const result = f.runIn(linkedHome, 'init', TEAM);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Refusing to install in your home directory without --scope');
    expect(result.output).not.toContain('Team repo cloned');
    expect(fs.existsSync(path.join(f.home, '.teamai/team-repo'))).toBe(false);
    expect(f.configFile()).toBeUndefined();
  }, 90_000);

  it('still installs user scope in HOME when --scope user is explicit', () => {
    const f = fixture('explicit-user-at-home', ['codex']);
    const result = f.runIn(f.home, 'init', TEAM, '--scope', 'user', '--role', 'rd', '--agent', 'codex');
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Scope: user');
    expect(result.output).not.toContain('Refusing to install in your home directory');
    expect(fs.existsSync(path.join(f.home, '.teamai/config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(f.home, '.teamai/team-repo'))).toBe(true);
    const config = YAML.parse(fs.readFileSync(path.join(f.home, '.teamai/config.yaml'), 'utf8'));
    expect(config.scope).toBe('user');
    expect(config.enabledAgents).toEqual(['codex']);
    // User scope keeps its own home layout instead of a workspace partition.
    expect(fs.existsSync(path.join(f.home, '.teamai/projects'))).toBe(false);
  }, 120_000);

  it('keeps both workspace aliases working in an ordinary directory', () => {
    for (const alias of ['workspace', 'project']) {
      const f = fixture(`alias-${alias}`, ['codex']);
      const result = f.run('init', TEAM, '--scope', alias);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('Scope: workspace');
      const config = YAML.parse(fs.readFileSync(f.configFile()!, 'utf8'));
      expect(config.scope).toBe('workspace');
    }
  }, 120_000);

  it('rejects a plain directory before cloning or writing any configuration', () => {
    const f = fixture('plain-directory', ['codex']);
    fs.rmSync(path.join(f.project, '.git'), { recursive: true });
    const result = f.run('init', TEAM);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Run this command from your cloned source repository');
    expect(result.output).not.toContain('Team repo cloned');
    expect(result.output).not.toContain('at projectForOnboarding');
    expect(fs.readdirSync(f.project)).toEqual(['README.md']);
    expect(f.configFile()).toBeUndefined();
    expect(fs.existsSync(path.join(f.home, '.teamai/config.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(f.home, '.teamai/team-repo'))).toBe(false);
  }, 90_000);

  it('binds, selects and delivers to all five tools with only the URL, then safely repeats', () => {
    const f = fixture('all', ['opencode', 'pi', 'codex', 'kimi', 'claude']);
    const result = f.run('init', TEAM);
    expect(result.error, result.output).toBeUndefined();
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Resource sync: complete');
    expect(result.output).not.toMatch(/Primary role \(|Select \[/);
    const config = YAML.parse(fs.readFileSync(f.configFile()!, 'utf8'));
    expect(config.primaryRole).toBe('rd');
    expect(config.projects).toEqual(['fw-a']);
    expect(config.enabledAgents).toEqual(['opencode', 'pi', 'codex', 'kimi', 'claude']);
    for (const dir of ['.opencode', '.pi', '.codex', '.kimi-code', '.claude']) {
      expect(fs.existsSync(path.join(f.project, dir, 'skills/project-a-probe/SKILL.md')), dir).toBe(true);
      expect(fs.existsSync(path.join(f.project, dir, 'skills/project-b-probe/SKILL.md')), dir).toBe(false);
    }
    expect(fs.existsSync(path.join(config.repo.localPath, '.git/ready-marker'))).toBe(true);
    const repeated = f.run('init', TEAM);
    expect(repeated.code, repeated.output).toBe(0);
    expect(repeated.output).toContain('Reusing this workspace binding');
    expect(f.git(f.project, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(f.git(f.project, 'diff', '--name-only', 'HEAD')).toBe('');
  }, 120_000);

  it('skips absent clients and preserves a previously disabled tool and role', () => {
    const f = fixture('subset', ['codex', 'kimi']);
    const first = f.run('init', TEAM);
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain('Skipped (not found on PATH): opencode, pi, claude');
    expect(fs.existsSync(path.join(f.project, '.claude'))).toBe(false);
    const file = f.configFile()!;
    const config = YAML.parse(fs.readFileSync(file, 'utf8'));
    config.primaryRole = 'maintainer'; config.disabledAgents = ['codex'];
    fs.writeFileSync(file, YAML.stringify(config));
    const again = f.run('init', TEAM);
    expect(again.code, again.output).toBe(0);
    expect(again.output).toContain('Skipped (previously disabled): codex');
    const updated = YAML.parse(fs.readFileSync(file, 'utf8'));
    expect(updated.primaryRole).toBe('maintainer');
    expect(updated.enabledAgents).toEqual(['kimi']);
  }, 120_000);

  it('saves an empty tool allowlist when no supported client is installed', () => {
    const f = fixture('none', []);
    const result = f.run('init', TEAM);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Resource sync: skipped');
    expect(result.output).not.toContain('Setup complete.');
    const config = YAML.parse(fs.readFileSync(f.configFile()!, 'utf8'));
    expect(config.enabledAgents).toEqual([]);
    for (const dir of ['.opencode', '.pi', '.codex', '.kimi-code', '.claude']) {
      expect(fs.existsSync(path.join(f.project, dir))).toBe(false);
    }
  }, 90_000);

  it('preserves the version pin and personal opt-outs on repeated short init', () => {
    const f = fixture('pinned', ['codex']);
    const first = f.run('init', TEAM);
    expect(first.code, first.output).toBe(0);
    const file = f.configFile()!;
    const config = YAML.parse(fs.readFileSync(file, 'utf8'));
    const pin = f.git(f.repo, 'rev-parse', 'HEAD');
    config.repo.ref = pin;
    Object.assign(config, {
      excludedSkills: ['common-probe'], subscribedTags: [], updatePolicy: 'skip',
      usageReportEnabled: false, codexTrustEnabled: false, recallEnabled: false,
    });
    fs.writeFileSync(file, YAML.stringify(config));
    f.git(config.repo.localPath, 'checkout', '--detach', pin);
    fs.writeFileSync(path.join(f.repo, 'new-version.txt'), 'New remote revision\n');
    f.git(f.repo, 'add', 'new-version.txt'); f.git(f.repo, 'commit', '-m', 'Advance fixture');
    const repeated = f.run('init', TEAM);
    expect(repeated.code, repeated.output).toBe(0);
    const updated = YAML.parse(fs.readFileSync(file, 'utf8'));
    for (const key of ['excludedSkills', 'subscribedTags', 'updatePolicy', 'usageReportEnabled', 'codexTrustEnabled', 'recallEnabled']) {
      expect(updated[key], key).toEqual(config[key]);
    }
    expect(updated.repo.ref).toBe(pin);
    expect(f.git(config.repo.localPath, 'rev-parse', 'HEAD')).toBe(pin);
  }, 120_000);

  it('rejects a missing roles manifest before saving an onboarding binding', () => {
    const f = fixture('missing-role', ['codex']);
    f.git(f.repo, 'rm', 'manifest/roles.yaml');
    f.git(f.repo, 'commit', '-m', 'Remove fixture role declaration');
    const result = f.run('init', TEAM);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Roles manifest not found');
    expect(f.configFile()).toBeUndefined();
    expect(result.output).not.toContain('Setup complete.');
  }, 90_000);

  it('reuses a saved Git-only provider override without asking for it again', () => {
    const f = fixture('provider-override', ['codex']);
    const alias = 'git@github.com:fixture-team/ai-docs.git';
    const first = f.run('init', alias, '--provider', 'git');
    expect(first.code, first.output).toBe(0);
    const repeated = f.run('init', alias);
    expect(repeated.code, repeated.output).toBe(0);
    expect(repeated.output).toContain('Reusing this workspace binding');
    expect(repeated.output).toContain('Resource sync: complete');
    expect(repeated.output).not.toContain('Checking authentication');
    const config = YAML.parse(fs.readFileSync(f.configFile()!, 'utf8'));
    expect(config.provider).toBe('git');
  }, 120_000);

  it('does not bind an unrelated source repository', () => {
    const f = fixture('wrong-source', ['codex']);
    f.git(f.project, 'remote', 'set-url', 'origin', 'ssh://source-fixture.invalid:29418/unrelated');
    const result = f.run('init', TEAM);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('does not match a registered source repository');
    expect(result.output).not.toContain('at projectForOnboarding');
    expect(f.configFile()).toBeUndefined();
  }, 90_000);

  it('reports a failed team registration script as incomplete, never ready', () => {
    const f = fixture('failed-script', ['codex'], true);
    const result = f.run('init', TEAM);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('postPull failed');
    expect(result.output).not.toContain('Setup complete.');
  }, 90_000);
});

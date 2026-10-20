import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const REPO_URL = 'https://gerrit.example.test/team/resources.git';
let sandbox: string;
let remote: string;
let project: string;
let env: NodeJS.ProcessEnv;

function git(args: string[], cwd = sandbox): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function cli(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out:\n${output}`)); }, 40_000);
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => { clearTimeout(timeout); resolve({ code, output }); });
  });
}

function state(): { pendingPushes: Array<{ branch: string; gerrit: { accepted: boolean; changeId: string; commit: string } }> } {
  return JSON.parse(fs.readFileSync(path.join(project, '.teamai/state.json'), 'utf8'));
}

describe.skipIf(process.platform === 'win32')('Gerrit real CLI workflow', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error('Run npm run build before this test.');
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gerrit-cli-')));
    project = path.join(sandbox, 'workspace');
    remote = path.join(sandbox, 'origin.git');
    const seed = path.join(sandbox, 'seed');
    for (const dir of [project, seed]) fs.mkdirSync(dir, { recursive: true });
    env = {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', FORCE_COLOR: '0',
      GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Fixture',
      GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'fixture@example.test',
      GIT_CONFIG_KEY_2: `url.${remote}.insteadOf`, GIT_CONFIG_VALUE_2: REPO_URL,
    };
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: fixture', `repo: ${REPO_URL}`, 'provider: git', 'autoUpdate: false', 'usageReport: false',
      'gerrit:', '  targetBranch: main', '  wip: true', '',
    ].join('\n'));
    fs.mkdirSync(path.join(seed, 'rules'));
    fs.writeFileSync(path.join(seed, 'rules', 'existing.md'), '# Existing team rule\n');
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '.'], seed);
    git(['commit', '-q', '-m', 'Seed team resources'], seed);
    git(['clone', '-q', '--bare', seed, remote]);
    fs.writeFileSync(path.join(remote, 'hooks/pre-receive'), [
      '#!/bin/sh',
      'while read old new ref; do',
      '  case "$ref" in refs/for/main%wip) ;; *) echo "ordinary branches forbidden" >&2; exit 1 ;; esac',
      'done', '',
    ].join('\n'), { mode: 0o755 });
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('initializes and pulls without reports, then rejects/retries/updates one Gerrit review', async () => {
    const initial = git(['rev-parse', 'main'], remote);
    const initialized = await cli(['init', REPO_URL, '--provider', 'git', '--scope', 'workspace', '--no-inherit-user-scope', '--agent', 'claude', '--force']);
    expect(initialized.code, initialized.output).toBe(0);
    expect(initialized.output).toContain('member registration and automatic reports publication are disabled');
    expect(initialized.output).not.toContain('Member registered');
    expect(git(['for-each-ref', '--format=%(refname)'], remote)).toBe('refs/heads/main');

    const pulled = await cli(['pull']);
    expect(pulled.code, pulled.output).toBe(0);
    expect(fs.existsSync(path.join(project, '.claude/rules/existing.md'))).toBe(true);
    expect(git(['for-each-ref', '--format=%(refname)'], remote)).toBe('refs/heads/main');

    const localRule = path.join(project, '.claude/rules/contribution.md');
    fs.writeFileSync(localRule, '# Contribution\nInspect the input boundary.\n');
    const noMessage = await cli(['push', '--all']);
    expect(noMessage.code, noMessage.output).toBe(1);
    expect(noMessage.output).toContain('--message');
    const hook = path.join(remote, 'hooks/pre-receive');
    const accept = fs.readFileSync(hook, 'utf8');
    fs.writeFileSync(hook, '#!/bin/sh\necho "test rejection" >&2\nexit 1\n', { mode: 0o755 });
    const rejected = await cli(['push', '--all', '--message', 'Add review guidance']);
    expect(rejected.code, rejected.output).toBe(1);
    expect(fs.readFileSync(localRule, 'utf8')).toContain('Inspect the input boundary');
    const first = state().pendingPushes[0].gerrit;
    expect(first.accepted).toBe(false);
    expect(git(['for-each-ref', '--format=%(refname)'], remote)).toBe('refs/heads/main');

    fs.writeFileSync(hook, accept, { mode: 0o755 });
    const retried = await cli(['push', '--all', '--message', 'Add review guidance']);
    expect(retried.code, retried.output).toBe(0);
    expect(retried.output).toContain('Uploaded Gerrit review');
    const accepted = state().pendingPushes[0].gerrit;
    expect(accepted.accepted).toBe(true);
    expect(accepted.changeId).toBe(first.changeId);
    expect(accepted.commit).toBe(first.commit);
    expect(git(['rev-parse', 'refs/for/main%wip'], remote)).toBe(first.commit);
    expect(git(['rev-parse', 'main'], remote)).toBe(initial);
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/heads'], remote)).toBe('refs/heads/main');

    const unchanged = await cli(['push', '--all', '--message', 'Add review guidance']);
    expect(unchanged.code, unchanged.output).toBe(0);
    expect(state().pendingPushes[0].gerrit.commit).toBe(first.commit);

    // Bare Git stores the magic ref; Gerrit consumes it. Remove only that test
    // ref before the next upload to model Gerrit's virtual-ref lifecycle.
    git(['update-ref', '-d', 'refs/for/main%wip'], remote);
    fs.writeFileSync(localRule, '# Contribution\nInspect input and error boundaries.\n');
    const updated = await cli(['push', '--all', '--message', 'Add review guidance']);
    expect(updated.code, updated.output).toBe(0);
    expect(state().pendingPushes).toHaveLength(1);
    expect(state().pendingPushes[0].gerrit.changeId).toBe(first.changeId);
    expect(state().pendingPushes[0].gerrit.commit).not.toBe(first.commit);
  });
});

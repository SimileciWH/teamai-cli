import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { GerritConfigSchema, TeamaiConfigSchema, type LocalConfig, type PendingPush } from '../types.js';
import { assertGerritPendingDestination, assertGerritPush, gerritPushDestination, pushGerritReview, readEffectiveGerritConfig } from '../utils/gerrit.js';
import { dropClosedPendingPushes, prunePendingPushes } from '../utils/pending-push.js';
import { commitAndPushReports, ensureReportsWorktree, readableReportsWorktree, updateReports } from '../utils/reports-branch.js';
import { createBranchWorktree } from '../utils/branch-worktree.js';

let tmp: string;
let repo: string;
let origin: string;
let local: LocalConfig;
let pending: PendingPush | undefined;
const subject = 'Improve review instructions';

async function prepare() {
  repo = path.join(tmp, 'repo');
  origin = path.join(tmp, 'origin.git');
  fs.mkdirSync(repo);
  const git = simpleGit(repo);
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.test');
  fs.writeFileSync(path.join(repo, 'teamai.yaml'),
    'team: fixture\nrepo: https://example.test/team.git\nprovider: git\ngerrit:\n  targetBranch: main\n');
  await git.add('.');
  await git.commit('Seed');
  await simpleGit().clone(repo, origin, ['--bare']);
  await git.addRemote('origin', origin);
  await git.fetch('origin');
  await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  local = { repo: { localPath: repo, remote: origin, kind: 'git' }, username: 'test', scope: 'user', additionalRoles: [] };
}

function resource(content = '# Review\nReview the source.\n') {
  fs.mkdirSync(path.join(repo, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'rules', 'review.md'), content);
}

async function upload(reuse = pending, message = subject, wip = true) {
  return pushGerritReview({
    repoPath: repo, config: { targetBranch: 'main', wip }, message,
    branch: 'teamai/push/test/review', files: ['rules/review.md'], reuse,
    includesTeamConfig: false,
    items: async () => [{ type: 'rules', name: 'review', relativePath: 'rules/review.md' }],
    persist: async (entry) => {
      pending = structuredClone(entry);
      fs.writeFileSync(path.join(tmp, 'pending.json'), JSON.stringify(pending));
    },
  });
}

async function returnToMain() {
  await simpleGit(repo).checkout('main');
  resource();
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gerrit-'));
  pending = undefined;
  await prepare();
});

afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('Gerrit opt-in validation', () => {
  it.each(['main%submit', 'main,wip', 'refs/heads/main', '-main', 'main..x', 'x@{y', 'x.lock', 'x//y', 'x y', 'x\\y'])(
    'rejects unsafe or full ref %s', (targetBranch) => {
      expect(GerritConfigSchema.safeParse({ targetBranch }).success).toBe(false);
    },
  );

  it('defaults to WIP and requires explicit message, git mode, and the default branch', async () => {
    expect(GerritConfigSchema.parse({ targetBranch: 'release/main' }).wip).toBe(true);
    const config = TeamaiConfigSchema.parse({
      team: 'fixture', repo: origin, provider: 'git', gerrit: { targetBranch: 'main' },
    });
    await expect(assertGerritPush(local, config, {})).rejects.toThrow('--message');
    await expect(assertGerritPush(local, config, { message: 'subject\nbody' })).rejects.toThrow('single-line');
    await expect(assertGerritPush(local, config, { message: subject, branch: 'other' })).rejects.toThrow('--branch');
    await expect(assertGerritPush({ ...local, repo: { ...local.repo, kind: 'self' } }, config, { message: subject }))
      .rejects.toThrow('separate Git');
    await expect(assertGerritPush(local, { ...config, gerrit: { targetBranch: 'other', wip: true } }, { message: subject }))
      .rejects.toThrow('default branch');
    await expect(assertGerritPush(local, config, { message: subject })).resolves.toBeUndefined();
  });
});

describe('Gerrit uploads with real Git transport', () => {
  it('omits only the WIP push option when wip is false', async () => {
    resource();
    await upload(undefined, subject, false);
    expect((await simpleGit(origin).raw(['for-each-ref', '--format=%(refname)', 'refs/for'])).trim()).toBe('refs/for/main');
  });

  it('pushes only refs/for, with one Change-Id and durable state before acceptance', async () => {
    resource();
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, `#!/bin/sh\ntest -f '${path.join(tmp, 'pending.json')}' || exit 1\n`);
    fs.chmodSync(hook, 0o755);
    const base = (await simpleGit(repo).revparse(['HEAD'])).trim();
    const result = await upload();
    expect(result.uploaded).toBe(true);
    expect(pending?.gerrit?.accepted).toBe(true);
    const remote = simpleGit(origin);
    expect((await remote.raw(['for-each-ref', '--format=%(refname)', 'refs/heads'])).trim()).toBe('refs/heads/main');
    expect((await remote.revparse(['refs/heads/main'])).trim()).toBe(base);
    expect((await remote.revparse(['refs/for/main%wip'])).trim()).toBe(pending?.gerrit?.commit);
    const message = await remote.raw(['show', '-s', '--format=%B', 'refs/for/main%wip']);
    expect(message).toBe(`${subject}\n\nChange-Id: ${pending?.gerrit?.changeId}\n\n`);
    expect(message.match(/^Change-Id: I[0-9a-f]{40}$/gm)).toHaveLength(1);
  });

  it('keeps rejected state and retries the exact commit, then skips an accepted unchanged upload', async () => {
    resource();
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho rejected >&2\nexit 1\n', { mode: 0o755 });
    await expect(upload()).rejects.toThrow('rejected');
    const rejected = structuredClone(pending!);
    expect(rejected.gerrit?.accepted).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'rules/review.md'), 'utf8')).toContain('Review the source');
    await returnToMain();
    fs.unlinkSync(hook);
    expect((await upload()).uploaded).toBe(true);
    expect(pending?.gerrit?.commit).toBe(rejected.gerrit?.commit);
    expect(pending?.gerrit?.changeId).toBe(rejected.gerrit?.changeId);
    await returnToMain();
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect((await upload()).uploaded).toBe(false);
  });

  it('updates content with the same Change-Id, without a duplicate ordinary branch', async () => {
    resource();
    await upload();
    const first = structuredClone(pending!);
    await simpleGit(origin).raw(['update-ref', '-d', 'refs/for/main%wip']);
    await returnToMain();
    resource('# Review\nAlso inspect error paths.\n');
    await upload();
    expect(pending?.gerrit?.commit).not.toBe(first.gerrit?.commit);
    expect(pending?.gerrit?.changeId).toBe(first.gerrit?.changeId);
    expect((await simpleGit(origin).raw(['for-each-ref', '--format=%(refname)', 'refs/heads'])).trim()).toBe('refs/heads/main');
  });

  it('does not interpret no new changes as acceptance', async () => {
    resource();
    fs.writeFileSync(path.join(origin, 'hooks', 'pre-receive'),
      '#!/bin/sh\necho "no new changes" >&2\nexit 1\n', { mode: 0o755 });
    await expect(upload()).rejects.toThrow('no new changes');
    expect(pending?.gerrit?.accepted).toBe(false);
  });

  it('retains Gerrit records without a remote branch or local scan, and drops only after landing', async () => {
    resource();
    await upload();
    const entry = pending!;
    expect(await dropClosedPendingPushes(repo, [entry])).toEqual([entry]);
    expect((await prunePendingPushes(repo, [entry], [])).pending).toEqual([entry]);
    await simpleGit(repo).raw(['update-ref', 'refs/remotes/origin/main', entry.gerrit!.commit]);
    expect(await dropClosedPendingPushes(repo, [entry])).toEqual([]);
  });

  it.each([true, false])('refuses a different push destination with accepted=%s', async (accepted) => {
    resource();
    if (!accepted) {
      fs.writeFileSync(path.join(origin, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      await expect(upload()).rejects.toThrow();
    } else {
      await upload();
    }
    const original = structuredClone(pending!);
    const other = path.join(tmp, 'other.git');
    await simpleGit().clone(origin, other, ['--bare']);
    await returnToMain();
    await simpleGit(repo).remote(['set-url', '--push', 'origin', other]);
    await expect(assertGerritPendingDestination(repo, [original])).rejects.toThrow('push destination');
    await expect(upload()).rejects.toThrow('push destination');
    expect(pending).toEqual(original);
    expect((await simpleGit(other).raw(['for-each-ref', '--format=%(refname)', 'refs/heads'])).trim()).toBe('refs/heads/main');
  });

  it('binds the actual push URL when it differs from the fetch URL and refuses multiple targets', async () => {
    const original = await gerritPushDestination(repo);
    await simpleGit(repo).remote(['set-url', '--push', 'origin', origin]);
    await simpleGit(repo).remote(['set-url', 'origin', path.join(tmp, 'fetch-only.git')]);
    expect(await gerritPushDestination(repo)).toBe(original);
    resource();
    expect((await upload()).uploaded).toBe(true);
    await simpleGit(repo).addConfig('remote.origin.pushurl', path.join(tmp, 'another.git'), true);
    await expect(gerritPushDestination(repo)).rejects.toThrow('exactly one');
  });
});

describe('Gerrit orphan publication guard', () => {
  it('keeps the committed guard when the working block or whole config is deleted', async () => {
    const yamlPath = path.join(repo, 'teamai.yaml');
    const write = vi.fn();
    fs.writeFileSync(yamlPath, 'team: fixture\nrepo: https://example.test/team.git\nprovider: git\n');
    expect(await readEffectiveGerritConfig(repo)).toEqual({ targetBranch: 'main', wip: true });
    expect(await updateReports(local, write)).toMatchObject({ status: 'failed', refused: true });
    fs.unlinkSync(yamlPath);
    expect(await readEffectiveGerritConfig(repo)).toEqual({ targetBranch: 'main', wip: true });
    expect(await updateReports(local, write)).toMatchObject({ status: 'failed', refused: true });
    expect(write).not.toHaveBeenCalled();
  });

  it('leaves Gerrit mode once its removal is committed and present on the default branch', async () => {
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: fixture\nrepo: https://example.test/team.git\nprovider: git\n');
    const git = simpleGit(repo);
    await git.add('teamai.yaml');
    await git.commit('Remove Gerrit mode');
    await git.raw(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    expect(await readEffectiveGerritConfig(repo)).toBeUndefined();
  });

  it('does not run report or learning writes and retains a caller pending copy', async () => {
    const pendingFile = path.join(tmp, 'pending-votes.json');
    fs.writeFileSync(pendingFile, '{"delta":1}');
    const write = vi.fn(async (_wt, ctx) => {
      ctx.onDelivered(async () => { fs.unlinkSync(pendingFile); });
      return { files: ['votes/test.json'], message: 'Report' };
    });
    expect(await updateReports(local, write)).toMatchObject({ status: 'failed', refused: true });
    expect(write).not.toHaveBeenCalled();
    expect(fs.existsSync(pendingFile)).toBe(true);
    expect(await commitAndPushReports(local, 'Report', ['votes/test.json'])).toBe(false);
    const learnings = createBranchWorktree({
      branch: 'teamai-learnings', worktreeDirname: 'learnings-wt',
      lockFilename: '.learnings-lock', logTag: 'learnings', initCommitMessage: 'Init learnings',
    });
    expect(await learnings.update(local, write)).toMatchObject({ status: 'failed', refused: true });
    expect(write).not.toHaveBeenCalled();
  });

  it('allows a read-only reports view without publishing a cold-start branch', async () => {
    const wt = await ensureReportsWorktree(local);
    expect(fs.existsSync(path.join(wt, '.git'))).toBe(true);
    expect(await readableReportsWorktree(local)).toBe(wt);
    expect((await simpleGit(origin).raw(['for-each-ref', '--format=%(refname)'])).trim()).toBe('refs/heads/main');
  });
});

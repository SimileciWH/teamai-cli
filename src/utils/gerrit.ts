import { createHash, randomBytes } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { GerritConfigSchema, type LocalConfig, type PendingPush, type TeamaiConfig } from '../types.js';
import { commitSkippingHooks, createGit, getDefaultBranch } from './git.js';

export const GERRIT_REPORTS_DISABLED = 'Gerrit mode disables automatic reports and learnings branch publication; local pending data is retained.';

function parseGerritConfig(content: string): TeamaiConfig['gerrit'] {
  const raw = YAML.parse(content);
  if (!raw || !Object.prototype.hasOwnProperty.call(raw, 'gerrit')) return undefined;
  return GerritConfigSchema.parse(raw.gerrit);
}

/**
 * Read only the opt-in block. Writers must not interpret an invalid block as
 * permission to publish a normal branch. Missing configs preserve legacy use.
 */
export async function readGerritConfig(repoPath: string): Promise<TeamaiConfig['gerrit']> {
  let content: string;
  try {
    content = await readFile(path.join(repoPath, 'teamai.yaml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return parseGerritConfig(content);
}

/**
 * An uncommitted deletion cannot turn review-only publishing into a direct
 * push. A local opt-in wins; otherwise the fetched default branch and HEAD
 * keep the mode enabled until its removal is committed and pulled.
 */
export async function readEffectiveGerritConfig(repoPath: string): Promise<TeamaiConfig['gerrit']> {
  const working = await readGerritConfig(repoPath);
  if (working) return working;
  try {
    await access(path.join(repoPath, '.git'));
  } catch {
    return undefined;
  }
  const git = createGit(repoPath);
  const defaultBranch = await getDefaultBranch(repoPath);
  for (const ref of [`refs/remotes/origin/${defaultBranch}`, 'HEAD']) {
    let content: string;
    try {
      content = await git.raw(['show', `${ref}:teamai.yaml`]);
    } catch {
      continue;
    }
    const baseline = parseGerritConfig(content);
    if (baseline) return baseline;
  }
  return undefined;
}

/** Bind retries to the actual push URL, not origin's possibly different fetch URL. */
export async function gerritPushDestination(repoPath: string): Promise<string> {
  const urls = (await createGit(repoPath).raw(['remote', 'get-url', '--push', '--all', 'origin']))
    .trim().split('\n').filter(Boolean);
  if (urls.length !== 1) throw new Error('Gerrit push requires exactly one origin push URL.');
  let normalized = urls[0];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    const url = new URL(normalized);
    if (url.protocol === 'file:') {
      normalized = await realpath(fileURLToPath(url));
    } else {
      url.hostname = url.hostname.toLowerCase();
      url.password = '';
      normalized = url.href;
    }
  } else if (!/^(?:[^/@:]+@)?[^/:]+:/.test(normalized)) {
    normalized = await realpath(path.resolve(repoPath, normalized));
  }
  // No URL or credentials are persisted in pending state.
  return createHash('sha256').update(normalized).digest('hex');
}

/** A reused scope may now point at another team; its old records cannot route new resources. */
export async function assertGerritPendingDestination(repoPath: string, pending: PendingPush[]): Promise<void> {
  const reviews = pending.filter((entry) => entry.gerrit);
  if (reviews.length === 0) return;
  const destination = await gerritPushDestination(repoPath);
  if (reviews.some((entry) => entry.gerrit!.destination !== destination)) {
    throw new Error('Pending Gerrit reviews belong to a different or unrecorded push destination. Restore the original destination or reconcile the pending reviews before pushing from this scope.');
  }
}

/** Check the bounded adapter before push resets or writes any checkout. */
export async function assertGerritPush(
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig,
  options: { message?: string; branch?: string },
): Promise<void> {
  if (!teamConfig.gerrit) return;
  if ((localConfig.repo.kind && localConfig.repo.kind !== 'git')
    || (localConfig.provider ?? teamConfig.provider) !== 'git') {
    throw new Error('Gerrit push requires provider: git and a separate Git team repo (self and HTTP modes are unsupported).');
  }
  if (options.branch) throw new Error('Gerrit push does not support --branch; configure gerrit.targetBranch in teamai.yaml.');
  // oxlint-disable-next-line no-control-regex
  if (!options.message?.trim() || /[\r\n\x00-\x1f\x7f]/.test(options.message)) {
    throw new Error('Gerrit push requires --message with a non-empty, single-line commit subject.');
  }
  const target = GerritConfigSchema.parse(teamConfig.gerrit).targetBranch;
  await createGit(localConfig.repo.localPath).raw(['check-ref-format', '--branch', target]);
  const defaultBranch = await getDefaultBranch(localConfig.repo.localPath);
  if (target !== defaultBranch) {
    throw new Error(`Gerrit targetBranch must match the remote default branch (${defaultBranch}); other target branches are unsupported.`);
  }
}

/** A Gerrit review has no ordinary remote branch to probe or prune. */
export async function gerritReviewMerged(repoPath: string, entry: PendingPush): Promise<boolean> {
  if (!entry.gerrit) return false;
  try {
    if (entry.gerrit.destination !== await gerritPushDestination(repoPath)) return false;
    const messages = await createGit(repoPath).raw([
      'log', `refs/remotes/origin/${entry.gerrit.targetBranch}`, '--format=%B',
      '--fixed-strings', '--grep', `Change-Id: ${entry.gerrit.changeId}`,
    ]);
    return messages.split('\n').some((line) => line === `Change-Id: ${entry.gerrit!.changeId}`);
  } catch {
    return false;
  }
}

export type GerritUploadResult = { uploaded: boolean; entry?: PendingPush };

/**
 * Stage one review, save its commit and Change-Id, then upload directly for
 * review. No remote heads, provider PR API, force push or Submit are involved.
 * The caller supplies only owned files and restores its source copies on failure.
 */
export async function pushGerritReview(args: {
  repoPath: string;
  config: NonNullable<TeamaiConfig['gerrit']>;
  message: string;
  files: string[];
  branch: string;
  reuse?: PendingPush;
  items: () => Promise<PendingPush['items']>;
  includesTeamConfig: boolean;
  persist: (entry: PendingPush) => Promise<void>;
}): Promise<GerritUploadResult> {
  const { repoPath, message, files, branch, reuse, persist } = args;
  const config = GerritConfigSchema.parse(args.config);
  if (reuse && (!reuse.gerrit || reuse.gerrit.targetBranch !== config.targetBranch)) {
    throw new Error('The pending contribution belongs to another review mode or target branch. Resolve it before pushing.');
  }
  const git = createGit(repoPath);
  const destination = await gerritPushDestination(repoPath);
  if (reuse?.gerrit && reuse.gerrit.destination !== destination) {
    throw new Error('The pending Gerrit review belongs to a different or unrecorded push destination. Restore that destination or reconcile the pending review before retrying.');
  }
  const base = (await git.revparse(['HEAD'])).trim();
  const remoteBase = (await git.revparse([`refs/remotes/origin/${config.targetBranch}`])).trim();
  if (base !== remoteBase) throw new Error('Gerrit push requires the clean remote default-branch base. Run teamai pull and retry.');
  const changeId = reuse?.gerrit?.changeId ?? `I${randomBytes(20).toString('hex')}`;
  const commitMessage = `${message.trim()}\n\nChange-Id: ${changeId}`;

  await git.checkout(['-B', branch]);
  await git.raw(['--literal-pathspecs', 'add', '--', ...files]);
  if (!(await git.diff(['--cached', '--name-only'])).trim()) return { uploaded: false };
  const tree = (await git.raw(['write-tree'])).trim();
  const previous = reuse?.gerrit;
  let sameCommit = false;
  if (previous) {
    try {
      const previousTree = (await git.revparse([`${previous.commit}^{tree}`])).trim();
      const previousBase = (await git.revparse([`${previous.commit}^`])).trim();
      const previousMessage = (await git.raw(['show', '-s', '--format=%B', previous.commit])).trim();
      sameCommit = tree === previousTree && base === previousBase && previousMessage === commitMessage;
    } catch {
      throw new Error(`Pending Gerrit commit ${previous.commit} is unavailable. Restore that local commit before retrying; its Change-Id is ${changeId}.`);
    }
  }
  if (sameCommit) {
    // The index tree was compared above; this restores exactly the staged bytes.
    await git.reset(['--hard', previous!.commit]);
  } else {
    await commitSkippingHooks(git, commitMessage);
  }
  const entry: PendingPush = {
    branch,
    prUrl: reuse?.prUrl ?? null,
    createdAt: reuse?.createdAt ?? new Date().toISOString(),
    base,
    items: await args.items(),
    gerrit: {
      changeId, targetBranch: config.targetBranch,
      destination,
      commit: (await git.revparse(['HEAD'])).trim(),
      accepted: sameCommit && previous!.accepted,
      includesTeamConfig: args.includesTeamConfig,
    },
  };
  // An atomic state write must finish before the remote can accept anything.
  await persist(entry);
  if (entry.gerrit!.accepted) return { uploaded: false, entry };

  let remoteOutput = '';
  git.outputHandler((_command, stdout, stderr) => {
    stdout.once('end', () => stdout.emit('data', Buffer.alloc(0)));
    stderr.on('data', (chunk: Buffer) => { remoteOutput += chunk.toString(); });
  });
  const ref = `refs/for/${config.targetBranch}${config.wip ? '%wip' : ''}`;
  // Rejection, interruption, and "no new changes" all stay failures. They never
  // prove acceptance; the saved commit is available for an exact retry.
  await git.raw(['push', '--porcelain', 'origin', `HEAD:${ref}`]);
  entry.gerrit!.accepted = true;
  const url = remoteOutput.match(/https?:\/\/[^\s<>]+\/\+\/\d+\b/)?.[0];
  if (url) entry.prUrl = url;
  await persist(entry);
  return { uploaded: true, entry };
}

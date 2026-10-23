import simpleGit from 'simple-git';
import { loadProjectsManifest, type ProjectsManifest } from './projects.js';
import { repoIdentity } from './utils/git.js';
import { resolveOnboardingSshRemote, formatOnboardingRemote } from './onboarding-ssh.js';
import { isOnPath } from './utils/lookpath.js';
import { detectProvider, getProvider } from './providers/index.js';

/** Compare the same canonical URL the selected provider saves during init. */
export function matchesInitBinding(remote: string, input: string, provider?: string): boolean {
  try {
    const canonical = getProvider(provider ?? detectProvider(input)).parseRepoInput(input).httpsUrl;
    return repoIdentity(remote) === repoIdentity(canonical);
  } catch {
    return false;
  }
}

/** Only these CLIs participate in the team's automatic first-time setup. */
export const ONBOARDING_AGENTS = ['opencode', 'pi', 'codex', 'kimi', 'claude'] as const;

export interface AgentDetection {
  selected: string[];
  missing: string[];
  disabled: string[];
}

/** Check executable presence, not stale config directories; never start a model. */
export function detectOnboardingAgents(
  disabled: readonly string[] = [],
  present: (command: string) => boolean = isOnPath,
): AgentDetection {
  const result: AgentDetection = { selected: [], missing: [], disabled: [] };
  for (const id of ONBOARDING_AGENTS) {
    if (disabled.includes(id)) result.disabled.push(id);
    else if (present(id)) result.selected.push(id);
    else result.missing.push(id);
  }
  return result;
}

/** Explicit remote aliases let a team support SSH and HTTPS without guessing. */
export function matchOnboardingProject(manifest: ProjectsManifest, remotes: readonly string[]): string {
  const identities = new Set(remotes.map(repoIdentity));
  const matches = manifest.projects.filter(project =>
    project.repositories?.some(remote => identities.has(repoIdentity(remote))),
  );
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(`This checkout matches several team projects (${matches.map(p => p.id).join(', ')}). `
      + 'Ask the team maintainer to disambiguate manifest/projects.yaml, or choose one with --project. Nothing was bound.');
  }
  throw new Error('This checkout does not match a registered source repository. '
    + 'Run init inside your project, or ask the team maintainer to add its Git remote to '
    + 'manifest/projects.yaml (repositories). Nothing was bound.');
}

/** Empty overrides still override Git's default SSH command. */
export async function hasCustomSshTransport(sourceRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.GIT_SSH_COMMAND !== undefined || env.GIT_SSH !== undefined) return true;
  return simpleGit(sourceRoot).raw(['config', '--get-regexp', '^core\\.sshcommand$']).then(value => value.trim().length > 0).catch(() => false);
}

export async function projectForOnboarding(repoPath: string, sourceRoot: string): Promise<string | undefined> {
  const manifest = await loadProjectsManifest(repoPath);
  if (!manifest?.projects.length) return undefined;
  let remotes: string[];
  try {
    remotes = (await simpleGit(sourceRoot).getRemotes(true)).map(remote => remote.refs.fetch).filter(Boolean);
  } catch {
    throw new Error('Could not read this checkout\'s Git remotes. Run init inside a readable source repository. Nothing was bound.');
  }
  // An exact or ambiguous declared match retains the existing behavior.
  const declared = new Set(manifest.projects.flatMap(project => (project.repositories ?? []).map(repoIdentity)));
  if (remotes.some(remote => declared.has(repoIdentity(remote)))) return matchOnboardingProject(manifest, remotes);
  const customSsh = await hasCustomSshTransport(sourceRoot);
  const resolutions = customSsh ? [] : remotes.map(remote => resolveOnboardingSshRemote(remote, sourceRoot));
  const expanded = resolutions.flatMap(result => result.remote ? [result.remote] : []);
  try {
    return matchOnboardingProject(manifest, [...remotes, ...expanded]);
  } catch (error) {
    const details = [
      `Source remotes: ${remotes.map(formatOnboardingRemote).join(', ') || '(none)'}`,
      ...(expanded.length ? [`SSH resolved remotes: ${expanded.map(formatOnboardingRemote).join(', ')}`] : []),
      ...resolutions.flatMap(result => result.diagnostic ? [result.diagnostic] : []),
      ...(customSsh ? ['SSH alias lookup skipped: a custom Git SSH command is configured.'] : []),
      'Branch names do not affect project matching. Use --project <id> to select a declared project explicitly.',
    ];
    throw new Error(`${(error as Error).message}\n${details.join('\n')}`);
  }
}

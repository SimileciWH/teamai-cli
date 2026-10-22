import { describe, expect, it } from 'vitest';
import { detectOnboardingAgents, matchOnboardingProject, matchesInitBinding, ONBOARDING_AGENTS } from '../onboarding.js';
import { validateProjectsManifest } from '../projects.js';
import { TeamaiConfigSchema } from '../types.js';

const manifest = validateProjectsManifest({
  version: 1,
  projects: [
    { id: 'firmware-a', repositories: ['ssh://code.example:29418/ssd/fw/a'], resources: {} },
    { id: 'firmware-b', repositories: ['https://code.example/ssd/fw/b'], resources: {} },
  ],
});

describe('short workspace onboarding', () => {
  it('recognizes provider-supported SSH, HTTPS and short aliases on repeated init', () => {
    for (const input of ['git@github.com:acme/team.git', 'https://github.com/acme/team', 'acme/team']) {
      expect(matchesInitBinding('https://github.com/acme/team.git', input, 'github')).toBe(true);
    }
    expect(matchesInitBinding('ssh://code.example:29418/team/docs', 'ssh://user@code.example:29418/team/docs', 'git')).toBe(true);
    expect(matchesInitBinding('ssh://code.example:29418/team/docs', 'ssh://code.example:29419/team/docs', 'git')).toBe(false);
  });
  it('selects only installed CLIs from the five supported defaults', () => {
    expect(detectOnboardingAgents([], id => ['codex', 'pi', 'cursor'].includes(id))).toEqual({
      selected: ['pi', 'codex'], missing: ['opencode', 'kimi', 'claude'], disabled: [],
    });
  });

  it('skips every absent tool instead of creating a default Claude install', () => {
    expect(detectOnboardingAgents([], () => false)).toEqual({
      selected: [], missing: [...ONBOARDING_AGENTS], disabled: [],
    });
  });

  it('preserves a previous tool exclusion even when its CLI is installed', () => {
    const result = detectOnboardingAgents(['codex'], () => true);
    expect(result.disabled).toEqual(['codex']);
    expect(result.selected).not.toContain('codex');
  });

  it('matches the source remote without depending on checkout or branch names', () => {
    expect(matchOnboardingProject(manifest, ['ssh://developer@CODE.EXAMPLE:29418/ssd/fw/a.git'])).toBe('firmware-a');
  });

  it('can match an upstream remote when origin is a personal fork', () => {
    expect(matchOnboardingProject(manifest, ['https://fork.example/me/a', 'ssh://code.example:29418/ssd/fw/a']))
      .toBe('firmware-a');
  });

  it('does not confuse different hosts, ports, repository case or suffix paths', () => {
    for (const remote of [
      'ssh://other.example:29418/ssd/fw/a', 'ssh://code.example:29419/ssd/fw/a',
      'ssh://code.example:29418/ssd/fw/A', 'ssh://code.example:29418/ssd/fw/a-extra',
    ]) expect(() => matchOnboardingProject(manifest, [remote])).toThrow(/does not match/);
  });

  it('rejects a checkout that matches multiple projects instead of combining resources', () => {
    expect(() => matchOnboardingProject(manifest, ['ssh://code.example:29418/ssd/fw/a', 'https://code.example/ssd/fw/b']))
      .toThrow(/matches several/);
  });

  it('does not assume the only declared project belongs to an unrelated checkout', () => {
    expect(() => matchOnboardingProject({ ...manifest, projects: [manifest.projects[0]] }, []))
      .toThrow(/does not match/);
  });

  it('preserves repository aliases through manifest parsing and editing', () => {
    expect(validateProjectsManifest(manifest).projects[0].repositories).toEqual(manifest.projects[0].repositories);
  });

  it('keeps automatic onboarding opt-in and rejects an empty default role', () => {
    const base = { team: 'test', repo: 'ssh://code.example/team' };
    expect(TeamaiConfigSchema.parse(base).onboarding).toBeUndefined();
    expect(TeamaiConfigSchema.parse({ ...base, onboarding: { defaultRole: 'rd' } }).onboarding?.defaultRole).toBe('rd');
    expect(() => TeamaiConfigSchema.parse({ ...base, onboarding: { defaultRole: '' } })).toThrow();
  });
});

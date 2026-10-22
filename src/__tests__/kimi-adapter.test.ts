import { describe, expect, it } from 'vitest';
import { TeamaiConfigSchema, applyToolRoots } from '../types.js';
import { KNOWN_AGENTS, SELF_MODE_AGENT_CHOICES } from '../known-agents.js';
import { renderForTool } from '../resources/agent-format.js';
import { detectMcpFormat, renderJsonEntry } from '../resources/mcp-format.js';
import { readsTeamRulesFromFile } from '../instruction-targets.js';
import { getUserHome } from '../utils/home.js';
import path from 'node:path';
import { resolveAgentModel } from '../models/aliases.js';

describe('Kimi Code client integration', () => {
  it('uses the documented client folders and relocates all resources together', () => {
    const paths = TeamaiConfigSchema.parse({ team: 'demo', repo: 'test' }).toolPaths;
    expect(KNOWN_AGENTS.find(a => a.id === 'kimi')?.skillsPath).toBe('.kimi-code/skills');
    expect(SELF_MODE_AGENT_CHOICES).toContain('kimi');
    expect(paths.kimi.settings).toBeUndefined();
    expect(paths.kimi.rules).toBeUndefined();
    expect(readsTeamRulesFromFile('kimi')).toBe(true);
    const relocated = applyToolRoots(paths, { kimi: path.join(getUserHome(), '.kimi-work') }).kimi;
    expect(relocated.skills).toBe('.kimi-work/skills');
    expect(relocated.claudemd).toBe('.kimi-work/AGENTS.md');
    expect(relocated.mcp).toBe('.kimi-work/mcp.json');
  });

  it('renders native Markdown agents without Codex model or effort fields', () => {
    const rendered = renderForTool({ name: 'reviewer', description: 'Review a scoped patch', instructions: 'Read the assigned diff.', tools: ['Read'], model: 'some-model', tool_extras: { kimi: { whenToUse: 'Scoped review', maxTurns: 4 } } }, 'kimi');
    expect(rendered.ext).toBe('.md');
    expect(rendered.content).toContain('whenToUse: Scoped review');
    expect(rendered.content).not.toContain('maxTurns');
    expect(rendered.content).not.toContain('some-model');
    expect(rendered.content).not.toContain('model_reasoning_effort');
  });

  it('uses Kimi transport and timeout fields', () => {
    expect(detectMcpFormat('kimi')).toBe('kimi');
    const entry = renderJsonEntry('kimi', { name: 'events', transport: 'sse', url: 'https://example.test/events', timeout: 7000 });
    expect(entry).toEqual({ transport: 'sse', url: 'https://example.test/events', startupTimeoutMs: 7000 });
    expect(renderJsonEntry('kimi', { name: 'local', transport: 'stdio', command: 'node', args: ['server.js'] })).toEqual({ command: 'node', args: ['server.js'] });
  });

  it('preserves an explicit empty tool allowlist instead of granting every tool', () => {
    const rendered = renderForTool({ name: 'no-tools', description: 'Read the supplied prompt only', instructions: 'Answer without tools.', tools: [] }, 'kimi');
    expect(rendered.content).toContain('tools: []');
    const inherited = renderForTool({ name: 'default-tools', description: 'Use default tools', instructions: 'Answer.' }, 'kimi');
    expect(inherited.content).not.toContain('tools:');
  });

  it('does not hold Kimi agent delivery on malformed aliases for a field it cannot use', () => {
    const resolved = resolveAgentModel({ ok: false, reason: 'Malformed model aliases' }, {
      name: 'reviewer', description: 'Review the supplied diff', instructions: 'Read only.', model: 'review-model',
    }, 'kimi');
    expect(resolved).toEqual({ ok: true, step: 'default' });
  });
});

import { describe, expect, it, vi } from 'vitest';

const { loadState, loadLocalConfig } = vi.hoisted(() => ({
  loadState: vi.fn(() => { throw new Error('configuration unavailable'); }),
  loadLocalConfig: vi.fn(() => { throw new Error('configuration unavailable'); }),
}));
vi.mock('../config.js', async (original) => ({
  ...(await original<typeof import('../config.js')>()), loadState, loadLocalConfig,
}));
vi.mock('../utils/logger.js', () => ({ log: { debug: vi.fn(), info: vi.fn() } }));

import { INTERNAL_DISTRIBUTION } from '../internal-distribution.js';
import { checkForUpdate, doUpdate, fetchLatestVersion, update } from '../update.js';

describe('internal distribution update boundary', () => {
  it('disables registry queries and hook updates even without configuration', async () => {
    expect(INTERNAL_DISTRIBUTION).toBe(true);
    expect(await fetchLatestVersion('https://registry.npmjs.org')).toBeNull();
    expect((await checkForUpdate({ force: true })).available).toBe(false);
    await doUpdate();
    await update({ check: true });
    await update({});
    expect(loadState).not.toHaveBeenCalled();
    expect(loadLocalConfig).not.toHaveBeenCalled();
  });
});

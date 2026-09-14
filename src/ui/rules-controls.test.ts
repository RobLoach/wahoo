import { describe, expect, it } from 'vitest';
import { describeRules, ruleLines } from './rules-controls.ts';
import { DEFAULT_RULES } from '../engine/types.ts';

describe('house-rule wording', () => {
  it('describes the defaults without noise', () => {
    const text = describeRules({ ...DEFAULT_RULES });
    expect(text).toBe(
      'teammate stomping allowed · 7 splits up to two bunnies · no burrow jumping',
    );
  });

  it('mentions the non-default toggles', () => {
    const text = describeRules({
      friendlyFire: false,
      sevenMaxBunnies: 4,
      burrowJump: true,
      finger: false,
      cpuSnappy: true,
      turnTimer: 60,
    });
    expect(text).toContain('no teammate stomping');
    expect(text).toContain('7 splits freely');
    expect(text).toContain('burrow jumping allowed');
    expect(text).toContain('no finger reaction');
    expect(text).toContain('snappy CPU turns');
    expect(text).toContain('60s turn timer');
  });

  it('lists every rule, labelled, for the modal', () => {
    const lines = ruleLines({ ...DEFAULT_RULES, turnTimer: 30 });
    expect(lines).toHaveLength(6);
    expect(Object.fromEntries(lines)).toMatchObject({
      'The 7': 'may split across two bunnies',
      'CPU turns': 'relaxed',
      'Turn timer (online)': '30 seconds',
    });
  });
});

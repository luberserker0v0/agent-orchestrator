import { describe, it, expect } from 'vitest';
import { planMigration } from './placement.js';

const MODEL = { providerID: 'anthropic', id: 'claude-sonnet-4' };

describe('planMigration', () => {
  it('selects a Ready same-model instance on another node', () => {
    const decision = planMigration(
      { name: 'a', nodeName: 'n1', model: MODEL },
      [
        { name: 'b', nodeName: 'n2', model: MODEL, phase: 'Ready' },
        { name: 'c', nodeName: 'n3', model: MODEL, phase: 'Ready' },
      ],
    );
    expect(decision).toEqual({ action: 'migrate', target: 'b', reason: expect.stringContaining('n1 -> n2') });
  });

  it('excludes non-Ready candidates', () => {
    const decision = planMigration(
      { name: 'a', nodeName: 'n1', model: MODEL },
      [{ name: 'b', nodeName: 'n2', model: MODEL, phase: 'QuotaExhausted' }],
    );
    expect(decision.action).toBe('wait-no-target');
  });

  it('excludes different models', () => {
    const decision = planMigration(
      { name: 'a', nodeName: 'n1', model: MODEL },
      [{ name: 'b', nodeName: 'n2', model: { providerID: 'anthropic', id: 'other' }, phase: 'Ready' }],
    );
    expect(decision.action).toBe('wait-no-target');
  });

  it('excludes the same known node', () => {
    const decision = planMigration(
      { name: 'a', nodeName: 'n1', model: MODEL },
      [{ name: 'b', nodeName: 'n1', model: MODEL, phase: 'Ready' }],
    );
    expect(decision.action).toBe('wait-no-target');
  });

  it('admits unknown nodes with a weaker guarantee note', () => {
    const decision = planMigration(
      { name: 'a', model: MODEL },
      [{ name: 'b', model: MODEL, phase: 'Ready' }],
    );
    expect(decision.action).toBe('migrate');
    if (decision.action === 'migrate') {
      expect(decision.reason).toContain('unverified');
    }
  });

  it('waits when the exhausted model is unknown', () => {
    const decision = planMigration(
      { name: 'a', nodeName: 'n1' },
      [{ name: 'b', nodeName: 'n2', model: MODEL, phase: 'Ready' }],
    );
    expect(decision).toEqual({ action: 'wait-no-target', reason: 'exhausted instance model unknown' });
  });

  it('waits when no candidates exist', () => {
    expect(planMigration({ name: 'a', nodeName: 'n1', model: MODEL }, []).action).toBe('wait-no-target');
  });
});

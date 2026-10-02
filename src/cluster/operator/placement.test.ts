import { describe, it, expect } from 'vitest';
import { planMigration, rankCandidates, rankNodes, refillWindowMs, isRefillDue } from './placement.js';

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

describe('rankCandidates', () => {
  it('orders by node load then name', () => {
    const ranked = rankCandidates(
      { name: 'a', nodeName: 'n1', model: MODEL },
      [
        { name: 'c', nodeName: 'n3', model: MODEL, phase: 'Ready' },
        { name: 'b', nodeName: 'n2', model: MODEL, phase: 'Ready' },
      ],
      new Map([['n2', 5], ['n3', 1]]),
    );
    expect(ranked.map((r) => r.name)).toEqual(['c', 'b']);
    expect(ranked[0].load).toBe(1);
  });

  it('sorts unknown nodes after known load', () => {
    const ranked = rankCandidates(
      { name: 'a', nodeName: 'n1', model: MODEL },
      [
        { name: 'u', model: MODEL, phase: 'Ready' },
        { name: 'b', nodeName: 'n2', model: MODEL, phase: 'Ready' },
      ],
      new Map([['n2', 3]]),
    );
    expect(ranked.map((r) => r.name)).toEqual(['b', 'u']);
    expect(ranked[1].nodeKnown).toBe(false);
  });

  it('planMigration prefers the least-loaded node', () => {
    const decision = planMigration(
      { name: 'a', nodeName: 'n1', model: MODEL },
      [
        { name: 'c', nodeName: 'n3', model: MODEL, phase: 'Ready' },
        { name: 'b', nodeName: 'n2', model: MODEL, phase: 'Ready' },
      ],
      new Map([['n2', 9], ['n3', 0]]),
    );
    expect(decision).toEqual({ action: 'migrate', target: 'c', reason: expect.stringContaining('load 0') });
  });
});

describe('rankNodes', () => {
  it('orders by load then name, unknown last', () => {
    expect(rankNodes(['n3', 'n1', 'n2'], new Map([['n1', 2], ['n2', 0]]))).toEqual(['n2', 'n1', 'n3']);
  });
});

describe('refill policy', () => {
  it('resolves per-model overrides over the default', () => {
    const policy = { defaultWindowMs: 1000, perModel: { 'a/m': 5000 } };
    expect(refillWindowMs(policy, { providerID: 'a', id: 'm' })).toBe(5000);
    expect(refillWindowMs(policy, { providerID: 'a', id: 'other' })).toBe(1000);
    expect(refillWindowMs(policy)).toBe(1000);
  });

  it('detects due windows and rejects invalid input', () => {
    expect(isRefillDue(new Date(Date.now() - 2000).toISOString(), Date.now(), 1000)).toBe(true);
    expect(isRefillDue(new Date().toISOString(), Date.now(), 60_000)).toBe(false);
    expect(isRefillDue(undefined, Date.now(), 0)).toBe(false);
    expect(isRefillDue('not-a-date', Date.now(), 0)).toBe(false);
  });
});

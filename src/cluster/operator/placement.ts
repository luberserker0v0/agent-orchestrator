export interface ModelIdentity {
  providerID: string;
  id: string;
}

export interface ExhaustedInstance {
  name: string;
  nodeName?: string;
  model?: ModelIdentity;
}

export interface MigrationCandidate {
  name: string;
  nodeName?: string;
  model?: ModelIdentity;
  phase: string;
}

export type PlanDecision =
  | { action: 'migrate'; target: string; reason: string }
  | { action: 'wait-no-target'; reason: string };

function sameModel(a?: ModelIdentity, b?: ModelIdentity): boolean {
  if (!a || !b) return false;
  return a.providerID === b.providerID && a.id === b.id;
}

/**
 * Select a migration target for a quota-exhausted instance (pure function).
 * Hard rules (per plan: same model, different machine):
 * - candidate must be `Ready`
 * - candidate model must equal the exhausted instance model; when the
 *   exhausted model is unknown no target is selected (fail safe)
 * - candidate must not sit on the same *known* node (unknown nodes are
 *   eligible with a weaker guarantee)
 * Deterministic: lowest name wins among eligible candidates.
 */
export interface RankedCandidate {
  name: string;
  /** Lower is better: known-node load first, unknown nodes penalized. */
  score: number;
  load: number;
  nodeKnown: boolean;
  reason: string;
}

/**
 * Rank eligible migration targets: Ready + same model + different known node,
 * ordered by node load (instance count) ascending, unknown nodes last,
 * name ascending for determinism.
 */
export function rankCandidates(
  exhausted: ExhaustedInstance,
  candidates: MigrationCandidate[],
  loadByNode?: Map<string, number>,
): RankedCandidate[] {
  if (!exhausted.model) return [];
  const model = exhausted.model;
  const maxKnownLoad = Math.max(
    0,
    ...[...(loadByNode?.values() ?? [])].filter((n) => Number.isFinite(n)),
  );
  return candidates
    .filter((c) => c.phase === 'Ready')
    .filter((c) => sameModel(model, c.model))
    .filter((c) => !(exhausted.nodeName && c.nodeName && exhausted.nodeName === c.nodeName))
    .map((c) => {
      const nodeKnown = !!c.nodeName;
      const load = c.nodeName ? (loadByNode?.get(c.nodeName) ?? 0) : maxKnownLoad + 1;
      return {
        name: c.name,
        score: load,
        load,
        nodeKnown,
        reason:
          `model ${model.providerID}/${model.id}, load ${load}` +
          (nodeKnown ? ` (node ${exhausted.nodeName ?? '?'} -> ${c.nodeName})` : ' (node affinity unverified: node unknown)'),
      };
    })
    .sort((a, b) => a.score - b.score || Number(b.nodeKnown) - Number(a.nodeKnown) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function planMigration(
  exhausted: ExhaustedInstance,
  candidates: MigrationCandidate[],
  loadByNode?: Map<string, number>,
): PlanDecision {
  if (!exhausted.model) {
    return { action: 'wait-no-target', reason: 'exhausted instance model unknown' };
  }
  const ranked = rankCandidates(exhausted, candidates, loadByNode);
  if (ranked.length === 0) {
    return { action: 'wait-no-target', reason: 'no Ready instance with matching model on another node' };
  }
  const target = ranked[0];
  return { action: 'migrate', target: target.name, reason: target.reason };
}

export interface RefillPolicy {
  /** Default quota refill window in ms (time-based refill per locked decision). */
  defaultWindowMs: number;
  /** Per-model overrides keyed by `providerID/modelID`. */
  perModel?: Record<string, number>;
}

export function modelKey(model?: ModelIdentity): string | undefined {
  if (!model) return undefined;
  return `${model.providerID}/${model.id}`;
}

/** Resolve the applicable refill window for a model (per-model override or default). */
export function refillWindowMs(policy: RefillPolicy, model?: ModelIdentity): number {
  const key = modelKey(model);
  if (key && policy.perModel && Number.isFinite(policy.perModel[key]) && (policy.perModel[key] as number) > 0) {
    return policy.perModel[key] as number;
  }
  return policy.defaultWindowMs;
}

/** True when the quota error is older than the window (invalid timestamps never clear). */
export function isRefillDue(lastErrorAt: string | undefined, nowMs: number, windowMs: number): boolean {
  if (!lastErrorAt) return false;
  const at = Date.parse(lastErrorAt);
  if (!Number.isFinite(at)) return false;
  return nowMs - at >= windowMs;
}

/** Rank node names by load ascending (unknown load sorts last), name for determinism. */
export function rankNodes(nodeNames: string[], loadByNode?: Map<string, number>): string[] {
  return [...nodeNames].sort((a, b) => {
    const loadA = loadByNode?.get(a);
    const loadB = loadByNode?.get(b);
    const scoreA = loadA ?? Number.MAX_SAFE_INTEGER;
    const scoreB = loadB ?? Number.MAX_SAFE_INTEGER;
    return scoreA - scoreB || (a < b ? -1 : a > b ? 1 : 0);
  });
}

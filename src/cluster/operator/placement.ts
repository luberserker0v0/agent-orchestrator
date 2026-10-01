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
export function planMigration(exhausted: ExhaustedInstance, candidates: MigrationCandidate[]): PlanDecision {
  if (!exhausted.model) {
    return { action: 'wait-no-target', reason: 'exhausted instance model unknown' };
  }
  const eligible = candidates
    .filter((c) => c.phase === 'Ready')
    .filter((c) => sameModel(exhausted.model, c.model))
    .filter((c) => !(exhausted.nodeName && c.nodeName && exhausted.nodeName === c.nodeName))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (eligible.length === 0) {
    return { action: 'wait-no-target', reason: 'no Ready instance with matching model on another node' };
  }
  const target = eligible[0];
  const sameNodeUnknown = !exhausted.nodeName || !target.nodeName;
  return {
    action: 'migrate',
    target: target.name,
    reason:
      `model ${exhausted.model.providerID}/${exhausted.model.id}` +
      (sameNodeUnknown ? ' (node affinity unverified: node unknown)' : ` (node ${exhausted.nodeName} -> ${target.nodeName})`),
  };
}

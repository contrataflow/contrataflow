import type { ProvisioningStepStatus } from '@contrataflow/types';

/*
 * Plano de provisionamento (US-099 · RN-TEN-06/07): ordem topológica dos seeders por `dependsOn` e
 * checklist calculado. Ciclo ou dependência ausente é erro de configuração e impede o boot.
 */

export interface SeederNode {
  readonly key: string;
  readonly dependsOn: readonly string[];
}

/**
 * Ordem de desempate entre seeders sem dependência entre si (fluxo principal, passo 6): mantém o
 * checklist estável e igual ao da story; chaves desconhecidas vêm depois, em ordem alfabética.
 */
export const CANONICAL_STEP_ORDER: readonly string[] = [
  'tenancy.primaryOrganization',
  'tenancy.settings',
  'catalog.items',
  'access.defaultRoles',
  'document.systemTypes',
  'document.templateLibrary',
  'workflow.seedWorkflows',
  'catalog.holidays',
  'identity.firstAdmin',
];

export class SeedingPlanError extends Error {
  constructor(
    readonly reason: 'CYCLE' | 'MISSING_DEPENDENCY',
    readonly keys: readonly string[],
  ) {
    super(
      reason === 'CYCLE'
        ? `Ciclo entre seeders de tenant: ${keys.join(' → ')}.`
        : `Seeder de tenant depende de etapa não registrada: ${keys.join(', ')}.`,
    );
    this.name = 'SeedingPlanError';
  }
}

function rank(key: string): number {
  const index = CANONICAL_STEP_ORDER.indexOf(key);
  return index === -1 ? CANONICAL_STEP_ORDER.length : index;
}

function compare(a: string, b: string): number {
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Kahn com desempate canônico. @throws SeedingPlanError */
export function orderSeeders<T extends SeederNode>(seeders: readonly T[]): T[] {
  const byKey = new Map(seeders.map((seeder) => [seeder.key, seeder]));
  const missing = seeders.flatMap((seeder) =>
    seeder.dependsOn
      .filter((dependency) => !byKey.has(dependency))
      .map((d) => `${seeder.key}→${d}`),
  );
  if (missing.length > 0) throw new SeedingPlanError('MISSING_DEPENDENCY', missing);

  const pending = new Map(seeders.map((seeder) => [seeder.key, new Set(seeder.dependsOn)]));
  const ordered: T[] = [];
  while (pending.size > 0) {
    const ready = [...pending.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([key]) => key)
      .sort(compare);
    const next = ready[0];
    if (next === undefined) throw new SeedingPlanError('CYCLE', [...pending.keys()].sort(compare));
    pending.delete(next);
    for (const dependencies of pending.values()) dependencies.delete(next);
    const seeder = byKey.get(next);
    if (seeder) ordered.push(seeder);
  }
  return ordered;
}

export interface ChecklistStep {
  readonly key: string;
  readonly status: ProvisioningStepStatus;
  readonly version: string | null;
  readonly details?: Readonly<Record<string, number>>;
}

export interface ProvisioningChecklist {
  readonly complete: boolean;
  readonly steps: readonly ChecklistStep[];
}

/** RN-TEN-06: completo quando todas as etapas estão `DONE`. */
export function checklistOf(steps: readonly ChecklistStep[]): ProvisioningChecklist {
  return { complete: steps.every((step) => step.status === 'DONE'), steps };
}

export function pendingSteps(checklist: ProvisioningChecklist): string[] {
  return checklist.steps.filter((step) => step.status !== 'DONE').map((step) => step.key);
}

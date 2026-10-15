import { describe, expect, it } from 'vitest';

import { SeedingPlanError, checklistOf, orderSeeders, pendingSteps } from './seeding-plan.js';

const node = (key: string, ...dependsOn: string[]) => ({ key, dependsOn });
const keys = (nodes: readonly { key: string }[]) => nodes.map((n) => n.key);

describe('ordem topológica dos seeders (RN-TEN-07)', () => {
  it('segue a ordem da story quando as dependências permitem', () => {
    const ordered = orderSeeders([
      node('identity.firstAdmin', 'access.defaultRoles'),
      node('catalog.holidays'),
      node('workflow.seedWorkflows', 'document.systemTypes', 'access.defaultRoles'),
      node('document.templateLibrary', 'document.systemTypes'),
      node('document.systemTypes'),
      node('access.defaultRoles'),
      node('catalog.items'),
    ]);
    expect(keys(ordered)).toEqual([
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
      'catalog.holidays',
      'identity.firstAdmin',
    ]);
  });

  it('dependência vence a ordem canônica; chaves desconhecidas vão depois, em ordem alfabética', () => {
    const ordered = orderSeeders([
      node('zeta.custom'),
      node('access.defaultRoles', 'alpha.custom'),
      node('alpha.custom'),
    ]);
    expect(keys(ordered)).toEqual(['alpha.custom', 'access.defaultRoles', 'zeta.custom']);
  });

  it('ciclo impede o boot', () => {
    expect(() => orderSeeders([node('a.x', 'b.y'), node('b.y', 'a.x'), node('c.z')])).toThrow(
      expect.objectContaining({ reason: 'CYCLE', keys: ['a.x', 'b.y'] }) as SeedingPlanError,
    );
  });

  it('dependência ausente impede o boot', () => {
    expect(() => orderSeeders([node('identity.firstAdmin', 'access.defaultRoles')])).toThrow(
      SeedingPlanError,
    );
    try {
      orderSeeders([node('identity.firstAdmin', 'access.defaultRoles')]);
    } catch (error) {
      expect((error as SeedingPlanError).reason).toBe('MISSING_DEPENDENCY');
      expect((error as SeedingPlanError).keys).toEqual(['identity.firstAdmin→access.defaultRoles']);
    }
  });

  it('lista vazia é um plano válido', () => {
    expect(orderSeeders([])).toEqual([]);
  });
});

describe('checklist calculado (RN-TEN-06)', () => {
  it('completo só com todas as etapas DONE', () => {
    const done = checklistOf([
      { key: 'tenancy.tenantRecord', status: 'DONE', version: null },
      { key: 'catalog.items', status: 'DONE', version: '1', details: { items: 84 } },
    ]);
    expect(done.complete).toBe(true);
    expect(pendingSteps(done)).toEqual([]);

    const partial = checklistOf([
      { key: 'tenancy.tenantRecord', status: 'DONE', version: null },
      { key: 'catalog.items', status: 'PENDING', version: '1' },
      { key: 'tenancy.complete', status: 'PENDING', version: null },
    ]);
    expect(partial.complete).toBe(false);
    expect(pendingSteps(partial)).toEqual(['catalog.items', 'tenancy.complete']);
  });
});

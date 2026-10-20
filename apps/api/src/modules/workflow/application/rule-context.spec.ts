import { describe, expect, it, vi } from 'vitest';

import type { TenantTx } from '#shared/database/prisma.js';

import {
  RuleContextBuilder,
  RuleContextContributorRegistrationError,
  RuleContextContributorRegistry,
  RuleContextInvalidError,
} from './rule-context.js';
import type { RuleContextContributor, RuleContextSeed } from './rule-context.js';
import { ruleProcess } from '../../../../test/support/workflow-engine-fixtures.js';
import type { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';

/* US-041 — `RuleContextBuilder`: semente do `process` + contribuidores → RuleContext v1 validado. */

const tx = {} as TenantTx;
const NOW = new Date('2026-10-15T15:00:00.000Z');

const businessDaysElapsed = vi.fn(() => Promise.resolve(4));
const calendar = { businessDaysElapsed } as unknown as BusinessCalendarFacade;

const seed = (overrides: Partial<RuleContextSeed> = {}): RuleContextSeed => ({
  processId: 'p-1',
  now: NOW,
  process: ruleProcess(),
  stage: { key: 'ESTUDOS_PRELIMINARES', enteredAt: new Date('2026-10-09T12:00:00.000Z') },
  documents: [
    {
      documentTypeCode: 'ETP',
      status: 'DRAFT',
      isComplete: false,
      versionNumber: null,
      approvedAt: null,
    },
  ],
  ...overrides,
});

function builderWith(...contributors: RuleContextContributor[]) {
  const registry = new RuleContextContributorRegistry();
  for (const contributor of contributors) registry.register(contributor);
  return new RuleContextBuilder(registry, calendar);
}

describe('RuleContextBuilder (US-041 · DEC-016)', () => {
  it('sem contribuidores: semente + seções vazias + dias úteis na etapa pelo calendário', async () => {
    const { context, documents } = await builderWith().build(tx, seed());
    expect(context).toEqual({
      version: 1,
      now: NOW.toISOString(),
      process: ruleProcess(),
      documents: {
        ETP: {
          exists: true,
          count: 1,
          status: 'DRAFT',
          isComplete: false,
          versionNumber: null,
          approvedAt: null,
        },
      },
      priceResearch: {
        exists: false,
        completed: false,
        totalEstimatedValue: null,
        itemsBelowMinimum: 0,
        itemsWithOutliers: 0,
        itemsWithoutValidQuotes: 0,
      },
      risks: { count: 0, highOrExtremeCount: 0, withoutTreatmentCount: 0 },
      stage: {
        key: 'ESTUDOS_PRELIMINARES',
        enteredAt: '2026-10-09T12:00:00.000Z',
        businessDaysInStage: 4,
      },
    });
    expect(documents).toHaveLength(1);
    expect(businessDaysElapsed).toHaveBeenCalledWith(tx, new Date('2026-10-09T12:00:00.000Z'), NOW);
  });

  it('contribuidores acrescentam seções e SUBSTITUEM os documentos dos seus tipos', async () => {
    const etp: RuleContextContributor = {
      name: 'etp',
      contribute: (_tx, request) => {
        expect(request).toEqual({ processId: 'p-1', now: NOW });
        return Promise.resolve({
          documents: [
            {
              documentTypeCode: 'ETP',
              status: 'DRAFT',
              isComplete: true,
              versionNumber: null,
              approvedAt: null,
            },
          ],
        });
      },
    };
    const research: RuleContextContributor = {
      name: 'price-research',
      contribute: () =>
        Promise.resolve({
          priceResearch: { exists: true, completed: true, totalEstimatedValue: 1000 },
          risks: { count: 2 },
          process: { itemsCount: 7 },
        }),
    };
    const { context, documents } = await builderWith(etp, research).build(tx, seed());
    expect(documents).toHaveLength(1);
    expect(context.documents.ETP?.isComplete).toBe(true);
    expect(context.priceResearch).toMatchObject({
      exists: true,
      completed: true,
      itemsWithOutliers: 0,
    });
    expect(context.risks).toEqual({ count: 2, highOrExtremeCount: 0, withoutTreatmentCount: 0 });
    expect(context.process.itemsCount).toBe(7);
  });

  it('processo sem etapa ativa: stage vazio, sem consultar o calendário', async () => {
    const days = vi.fn();
    const builder = new RuleContextBuilder(new RuleContextContributorRegistry(), {
      businessDaysElapsed: days,
    } as unknown as BusinessCalendarFacade);
    const { context } = await builder.build(tx, seed({ stage: null }));
    expect(context.stage).toEqual({
      key: '',
      enteredAt: NOW.toISOString(),
      businessDaysInStage: 0,
    });
    expect(days).not.toHaveBeenCalled();
  });

  it('contexto fora do schema v1 (defeito de contribuidor) = RuleContextInvalidError', async () => {
    const broken: RuleContextContributor = {
      name: 'quebrado',
      contribute: () => Promise.resolve({ risks: { count: 1.5 } }),
    };
    await expect(builderWith(broken).build(tx, seed())).rejects.toBeInstanceOf(
      RuleContextInvalidError,
    );
  });

  it('registro duplicado é recusado', () => {
    const registry = new RuleContextContributorRegistry();
    const contributor = { name: 'risk', contribute: () => Promise.resolve({}) };
    registry.register(contributor);
    expect(() => {
      registry.register(contributor);
    }).toThrow(RuleContextContributorRegistrationError);
    expect(registry.all()).toEqual([contributor]);
  });
});

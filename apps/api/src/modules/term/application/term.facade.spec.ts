import { describe, expect, it } from 'vitest';

import { runWithRequestContext, runWithTenantScope } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { TermFacade } from './term.facade.js';
import { createTermOfReference } from '../domain/term-of-reference.js';
import { InMemoryTermRepository } from '../infrastructure/term.repositories.js';

const TENANT = '0192d120-0000-7000-8000-0000000000a0';
const OTHER = '0192d120-0000-7000-8000-0000000000b0';
const TERM = '0192d120-0000-7000-8000-0000000000c1';
const tx = {} as TenantTx;
const USER = '0192d120-0000-7000-8000-0000000000f1';

/** Contexto de requisição no tenant (o repositório em memória filtra por ele, como a RLS). */
const inTenant = <T>(tenantId: string, fn: () => T): T =>
  runWithRequestContext({ correlationId: 'us-120', ip: '', userAgent: 'vitest' }, () =>
    runWithTenantScope({ tenantId, userId: USER, membershipId: USER }, fn),
  );

describe('TermFacade', () => {
  it('aiDraftContextIn (US-120): condições tipadas e valor estimado do TR; outro tenant → null', async () => {
    const terms = new InMemoryTermRepository();
    const facade = new TermFacade(terms);
    const term = {
      ...createTermOfReference({
        documentId: TERM,
        tenantId: TENANT,
        processId: '0192d120-0000-7000-8000-0000000000d1',
        processObject: 'Aquisição de computadores',
        fieldConfig: {},
        completedResearch: {
          id: '0192d120-0000-7000-8000-0000000000e1',
          totalEstimatedValue: '125000',
        },
        creatorId: null,
        now: new Date('2026-10-20T12:00:00.000Z'),
      }),
      contractDurationMonths: 12,
      paymentTermDays: 30,
      contractGuaranteePercent: '5',
    };
    await inTenant(TENANT, () => terms.insert(tx, term));

    const read = await inTenant(TENANT, () => facade.aiDraftContextIn(tx, TERM));
    expect(read).toMatchObject({
      id: TERM,
      contractDurationMonths: 12,
      paymentTermDays: 30,
      contractGuaranteePercent: '5',
      deliveryLocation: null,
      estimatedTotalValue: '125000.00',
      estimatedValueSource: 'PRICE_RESEARCH',
    });
    expect(read).not.toHaveProperty('createdById');
    await expect(inTenant(OTHER, () => facade.aiDraftContextIn(tx, TERM))).resolves.toBeNull();
  });
});

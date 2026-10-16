import { describe, expect, it } from 'vitest';

import type { OrganizationFacade } from '#modules/organization/application/organization.facade.js';
import type { ProcessFacade } from '#modules/process/application/process.facade.js';
import type { TenantTx } from '#shared/database/prisma.js';

import {
  DepartmentLookupSource,
  ProcessLookupSource,
  ProcessStageLookupSource,
} from './process-lookup.sources.js';

const tx = {} as TenantTx;
const UNIT = '0192f000-0000-7000-8000-0000000000d1';
const PROCESS = '0192f000-0000-7000-8000-000000000001';
const STAGE = '0192f000-0000-7000-8000-0000000000e1';

describe('Fontes de nomes da timeline para ProcessCreated (US-001)', () => {
  it('DEPARTMENT: nome da unidade pela fachada do organization', async () => {
    const organization = {
      departmentNames: () => Promise.resolve(new Map([[UNIT, 'Setor de Manutenção']])),
    } as unknown as OrganizationFacade;
    const source = new DepartmentLookupSource(organization);
    expect(source.kind).toBe('DEPARTMENT');
    expect([...(await source.lookup(tx, [UNIT]))]).toEqual([
      [UNIT, { name: 'Setor de Manutenção' }],
    ]);
  });

  it('PROCESS e PROCESS_STAGE: código/sigilo e nome da etapa pela fachada do process', async () => {
    const processes = {
      processReferences: () =>
        Promise.resolve(new Map([[PROCESS, { code: '0012/2026', isBudgetConfidential: false }]])),
      stageNames: () => Promise.resolve(new Map([[STAGE, 'Formalização da demanda']])),
    } as unknown as ProcessFacade;
    const processSource = new ProcessLookupSource(processes);
    const stageSource = new ProcessStageLookupSource(processes);
    expect([processSource.kind, stageSource.kind]).toEqual(['PROCESS', 'PROCESS_STAGE']);
    expect([...(await processSource.lookup(tx, [PROCESS]))]).toEqual([
      [PROCESS, { code: '0012/2026', isBudgetConfidential: false }],
    ]);
    expect([...(await stageSource.lookup(tx, [STAGE]))]).toEqual([
      [STAGE, { name: 'Formalização da demanda' }],
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { ProcessDfdApprovalSync } from './process-dfd-approval.sync.js';
import type { ProcessDfdDuplication } from './process-dfd-duplication.js';
import type { ProcessListPresenter } from './process-list.presenter.js';
import { ProcessFacade } from './process.facade.js';
import type { AccessFacade } from '../../access/application/access.facade.js';
import type { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import type { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import {
  enterStage,
  openingMovement,
  stageEntryAssignment,
} from '../domain/process-runtime-records.js';
import { createProcess, draftProcess } from '../domain/process.js';
import { InMemoryProcessRepository } from '../infrastructure/in-memory-process.repository.js';
import { InMemoryProcessItemRepository } from '../infrastructure/process-item.repositories.js';
import { InMemoryProcessParticipantRepository } from '../infrastructure/process-participant.repositories.js';
import { InMemoryTagRepository } from '../infrastructure/tag.repositories.js';

type ConfidentialBudgetAccess = Awaited<ReturnType<AccessFacade['confidentialBudgetAccess']>>;

const A = '0192f000-0000-7000-8000-00000000000a';
const B = '0192f000-0000-7000-8000-00000000000b';
const PROCESS = '0192f000-0000-7000-8000-000000000001';
const STAGE = '0192f000-0000-7000-8000-0000000000e1';
const WF_STAGE = '0192f000-0000-7000-8000-0000000000e2';
const VERSION = '0192f000-0000-7000-8000-0000000000f1';
const UNIT = '0192f000-0000-7000-8000-0000000000d1';
const ANA = '0192f000-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-10-16T13:00:00.000Z');
const tx = {} as TenantTx;

function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId: 'c', ip: '', userAgent: '' }, () => {
    updateRequestContext({ tenantId });
    return fn();
  });
}

describe('ProcessFacade (US-001 · fontes PROCESS e PROCESS_STAGE da timeline)', () => {
  const participants = new InMemoryProcessParticipantRepository();
  const repository = new InMemoryProcessRepository(participants, new InMemoryTagRepository());
  const workflow = {
    publishedDefinitionIn: () =>
      Promise.resolve({ stages: [{ id: WF_STAGE, name: 'Formalização da demanda' }] }),
  } as unknown as WorkflowFacade;
  let budget: ConfidentialBudgetAccess = {
    scope: { userId: ANA, tenantWide: false, organizationIds: [], departmentIds: [] },
    custodyDepartmentIds: [],
    stepUpAvailable: false,
  };
  const access = {
    confidentialBudgetAccess: () => Promise.resolve(budget),
  } as unknown as AccessFacade;
  const tenancy = {
    settingValues: () => Promise.resolve(new Map<string, unknown>()),
  } as unknown as TenancyFacade;
  const facade = new ProcessFacade(
    repository,
    workflow,
    access,
    tenancy,
    participants,
    () => NOW,
    {} as ProcessDfdDuplication,
    {} as ProcessListPresenter,
    new InMemoryProcessItemRepository(),
    {} as ProcessDfdApprovalSync,
  );
  const viewer = (
    userId: string,
    scope: Partial<ConfidentialBudgetAccess['scope']> = {},
    custodyDepartmentIds: string[] = [],
  ) => {
    budget = {
      scope: { userId, tenantWide: false, organizationIds: [], departmentIds: [], ...scope },
      custodyDepartmentIds,
      stepUpAvailable: false,
    };
  };

  const seed = () => {
    const draft = draftProcess(
      {
        title: 'Aquisição de cimento',
        object: 'Cimento para manutenção das vias.',
        contractingTypeId: UNIT,
        requestingSecretariatId: UNIT,
        requestingDepartmentId: UNIT,
        originId: UNIT,
        pcaStatus: 'NOT_APPLICABLE',
        priority: 'MEDIUM',
        isPriceRegistration: false,
        confirmDuplicate: false,
      },
      { today: '2026-10-16', currentYear: 2026, requireInternalCode: false },
    );
    const process = createProcess(draft, {
      id: PROCESS,
      tenantId: A,
      organizationId: UNIT,
      now: NOW,
      createdById: ANA,
      currentYear: 2026,
      numbering: { number: 12, year: 2026, code: '0012/2026' },
      workflowVersionId: VERSION,
      initialStage: {
        processStageId: STAGE,
        workflowStageId: WF_STAGE,
        departmentId: UNIT,
        assigneeId: ANA,
        dueAt: null,
      },
    });
    const stage = enterStage({
      id: STAGE,
      tenantId: A,
      processId: PROCESS,
      workflowStageId: WF_STAGE,
      sequence: 1,
      departmentId: UNIT,
      assigneeId: ANA,
      enteredAt: NOW,
      dueAt: null,
      slaDays: null,
      slaType: null,
      movementId: STAGE,
    });
    return inTenant(A, () =>
      repository.insertCreation(tx, {
        process,
        stage,
        assignment: stageEntryAssignment(STAGE, stage),
        movement: openingMovement({
          id: STAGE,
          stage,
          actorId: ANA,
          ip: null,
          userAgent: null,
          correlationId: 'c',
          channel: 'WEB',
        }),
      }),
    );
  };

  it('código e sigilo do processo só no tenant da transação', async () => {
    await seed();
    await expect(inTenant(A, () => facade.processReferences(tx, [PROCESS]))).resolves.toEqual(
      new Map([[PROCESS, { code: '0012/2026', isBudgetConfidential: false }]]),
    );
    await expect(inTenant(B, () => facade.processReferences(tx, [PROCESS]))).resolves.toEqual(
      new Map(),
    );
  });

  it('nome da etapa da passagem pela versão fixada; de outro tenant, nada', async () => {
    await expect(inTenant(A, () => facade.stageNames(tx, [STAGE]))).resolves.toEqual(
      new Map([[STAGE, 'Formalização da demanda']]),
    );
    await expect(inTenant(B, () => facade.stageNames(tx, [STAGE]))).resolves.toEqual(new Map());
  });

  describe('POL-09 de um processo (US-060 · RN-TML-13)', () => {
    const OTHER = '0192f000-0000-7000-8000-0000000000a2';
    const can = (tenantId = A) =>
      inTenant(tenantId, () => facade.canViewConfidentialBudget(tx, PROCESS));

    it('custódia atual: o responsável vê', async () => {
      viewer(ANA);
      await expect(can()).resolves.toBe(true);
    });

    it('sem permissão nem custódia: não vê (mesmo com o orçamento hoje público)', async () => {
      viewer(OTHER);
      await expect(can()).resolves.toBe(false);
    });

    it('PROCESS_VIEW_CONFIDENTIAL_BUDGET no tenant ou no órgão do processo: vê', async () => {
      viewer(OTHER, { tenantWide: true });
      await expect(can()).resolves.toBe(true);
      viewer(OTHER, { organizationIds: [UNIT] });
      await expect(can()).resolves.toBe(true);
    });

    it('fila da unidade só vale sem responsável', async () => {
      viewer(OTHER, {}, [UNIT]);
      await expect(can()).resolves.toBe(false);
    });

    it('processo de outro tenant: falha fechada', async () => {
      viewer(OTHER, { tenantWide: true });
      await expect(can(B)).resolves.toBe(false);
    });
  });
});

import type { ProcessStatus } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import type { ProcessVisibilityScope } from '#shared/auth/process-access.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import type { ProcessRuntimeReader } from './ports.js';
import type { ProcessRuntimeAccessReader } from './process-access.reader.js';
import { ProcessAttachmentTargets } from './process-attachment-targets.js';
import type { AccessFacade } from '../../access/application/access.facade.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';

const PROCESS = '0192a000-0000-7000-8000-0000000000c1';
const USER = '0192a000-0000-7000-8000-0000000000a1';
const tx = {} as TenantTx;

function targets(options: { status?: ProcessStatus; visible?: boolean; exists?: boolean } = {}) {
  const exists = options.exists ?? true;
  const access = {
    processId: PROCESS,
    organizationId: null,
    departmentIds: [],
    userIds: [USER],
    participations: [],
  };
  const reader = {
    load: () => Promise.resolve(exists ? access : null),
  } as unknown as ProcessRuntimeAccessReader;
  const runtimes = {
    load: () =>
      Promise.resolve(
        exists
          ? ({ id: PROCESS, status: options.status ?? 'IN_PROGRESS' } as ProcessRuntime)
          : null,
      ),
  } as unknown as ProcessRuntimeReader;
  const scope: ProcessVisibilityScope = {
    userId: options.visible === false ? 'outro' : USER,
    tenantWide: false,
    organizationIds: [],
    departmentIds: [],
  };
  const facade = {
    processVisibilityScope: () => Promise.resolve(scope),
  } as unknown as AccessFacade;
  return new ProcessAttachmentTargets(runtimes, reader, facade);
}

const ref = { targetType: 'PROCESS' as const, targetId: PROCESS };

describe('ProcessAttachmentTargets (US-068 · V-04)', () => {
  it('processo visível → alvo com o processo; invisível ou inexistente → null (404)', async () => {
    await expect(targets().load(tx, ref)).resolves.toMatchObject({ processId: PROCESS });
    await expect(targets({ visible: false }).load(tx, ref)).resolves.toBeNull();
    await expect(targets({ exists: false }).load(tx, ref)).resolves.toBeNull();
  });

  it.each(['CANCELED', 'COMPLETED', 'PUBLISHED'] as const)(
    'processo %s → 409 INVALID_PROCESS_STATUS',
    async (status) => {
      const reader = targets({ status });
      const target = await reader.load(tx, ref);
      if (target === null) throw new Error('alvo esperado');
      await expect(reader.assertAttachable(tx, target)).rejects.toMatchObject({
        code: 'INVALID_PROCESS_STATUS',
        status: 409,
      });
    },
  );

  it('processo em andamento admite anexo; sumiu entre a leitura e a regra → 404', async () => {
    const target = { ...ref, processId: PROCESS, process: null };
    await expect(targets().assertAttachable(tx, target)).resolves.toBeUndefined();
    await expect(targets({ exists: false }).assertAttachable(tx, target)).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

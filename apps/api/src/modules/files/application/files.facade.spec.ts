import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { FilesFacade } from './files.facade.js';
import { createAttachment } from '../domain/attachment.js';
import { InMemoryAttachmentRepository } from '../infrastructure/in-memory-attachment.repository.js';

const TENANT = '0192a000-0000-7000-8000-00000000000a';
const OTHER = '0192a000-0000-7000-8000-00000000000b';
const ID = '0192a000-0000-7000-8000-0000000000a1';

describe('FilesFacade', () => {
  it('rótulos de anexos só do tenant do contexto (timeline ATTACHMENT_REMOVED)', async () => {
    const repository = new InMemoryAttachmentRepository();
    repository.rows.set(
      ID,
      createAttachment({
        id: ID,
        tenantId: TENANT,
        processId: ID,
        targetType: 'PROCESS',
        targetId: ID,
        categoryId: null,
        fileName: 'ata.pdf',
        extension: 'pdf',
        declaredMimeType: 'application/pdf',
        sizeBytes: 10,
        storageKey: `tenants/${TENANT}/processes/${ID}/attachments/${ID}/ata.pdf`,
        quarantineKey: `tenants/${TENANT}/uploads/${ID}`,
        description: null,
        uploadedById: ID,
        now: new Date(),
      }),
    );
    const facade = new FilesFacade(repository);
    const labelsIn = (tenantId: string) =>
      runWithRequestContext({ correlationId: 'c', ip: '', userAgent: '' }, () => {
        updateRequestContext({ tenantId });
        return facade.attachmentLabels({} as TenantTx, [ID]);
      });
    expect((await labelsIn(TENANT)).get(ID)).toEqual({
      fileName: 'ata.pdf',
      targetType: 'PROCESS',
    });
    expect((await labelsIn(OTHER)).size).toBe(0);
  });
});

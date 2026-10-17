import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { FilesFacade } from './files.facade.js';
import { createAttachment, deleteAttachment, markAvailable } from '../domain/attachment.js';
import type { Attachment, NewAttachmentInput } from '../domain/attachment.js';
import { InMemoryAttachmentRepository } from '../infrastructure/in-memory-attachment.repository.js';

const TENANT = '0192a000-0000-7000-8000-00000000000a';
const OTHER = '0192a000-0000-7000-8000-00000000000b';
const ID = '0192a000-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-10-17T12:00:00.000Z');
const CARLA = '0192a000-0000-7000-8000-0000000000c1';
const SOURCE = '0192a000-0000-7000-8000-0000000000b1';
const TARGET = '0192a000-0000-7000-8000-0000000000b2';
const DOC = '0192a000-0000-7000-8000-0000000000d1';
const NEW_DOC = '0192a000-0000-7000-8000-0000000000d2';

function intent(overrides: Partial<NewAttachmentInput> = {}): Attachment {
  const id = overrides.id ?? ID;
  return createAttachment({
    id,
    tenantId: TENANT,
    processId: ID,
    targetType: 'PROCESS',
    targetId: ID,
    categoryId: null,
    fileName: 'ata.pdf',
    extension: 'pdf',
    declaredMimeType: 'application/pdf',
    sizeBytes: 10,
    storageKey: `tenants/${TENANT}/processes/${ID}/attachments/${id}/ata.pdf`,
    quarantineKey: `tenants/${TENANT}/uploads/${id}`,
    description: null,
    uploadedById: ID,
    now: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });
}

/** Anexo já varrido e liberado (P3), como o `file-scan` o deixa. */
function available(overrides: Partial<NewAttachmentInput> = {}): Attachment {
  const scanning: Attachment = { ...intent(overrides), status: 'SCANNING' };
  return markAvailable(
    scanning,
    { sha256: 'a'.repeat(64), detectedMimeType: 'application/pdf', scanResult: { engine: 'fake' } },
    new Date('2026-01-01T00:01:00.000Z'),
  );
}

function inTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId: 'c', ip: '', userAgent: '' }, () => {
    updateRequestContext({
      tenantId,
      actor: { type: 'USER', userId: CARLA, membershipId: null },
    });
    return work();
  });
}

describe('FilesFacade', () => {
  it('rótulos de anexos só do tenant do contexto (timeline ATTACHMENT_REMOVED)', async () => {
    const repository = new InMemoryAttachmentRepository();
    repository.rows.set(ID, intent());
    const facade = new FilesFacade(repository, () => NOW);
    const labelsIn = (tenantId: string) =>
      inTenant(tenantId, () => facade.attachmentLabels({} as TenantTx, [ID]));
    expect((await labelsIn(TENANT)).get(ID)).toEqual({
      fileName: 'ata.pdf',
      targetType: 'PROCESS',
    });
    expect((await labelsIn(OTHER)).size).toBe(0);
  });

  it('cópia lógica na duplicação: mesmo objeto, novo registro no novo processo (US-011 · RN-PROC-121)', async () => {
    const repository = new InMemoryAttachmentRepository();
    const ofProcess = available({
      id: '0192a000-0000-7000-8000-0000000000e1',
      processId: SOURCE,
      targetId: SOURCE,
    });
    const ofDocument = available({
      id: '0192a000-0000-7000-8000-0000000000e2',
      processId: SOURCE,
      targetType: 'DOCUMENT',
      targetId: DOC,
    });
    const ofUncopiedDocument = available({
      id: '0192a000-0000-7000-8000-0000000000e3',
      processId: SOURCE,
      targetType: 'DOCUMENT',
      targetId: '0192a000-0000-7000-8000-0000000000d9',
    });
    const ofComment = available({
      id: '0192a000-0000-7000-8000-0000000000e4',
      processId: SOURCE,
      targetType: 'COMMENT',
      targetId: '0192a000-0000-7000-8000-0000000000f1',
    });
    const pending = intent({
      id: '0192a000-0000-7000-8000-0000000000e5',
      processId: SOURCE,
      targetId: SOURCE,
    });
    const removed = deleteAttachment(
      available({
        id: '0192a000-0000-7000-8000-0000000000e6',
        processId: SOURCE,
        targetId: SOURCE,
      }),
      'Enviado por engano',
      NOW,
      CARLA,
    );
    for (const row of [ofProcess, ofDocument, ofUncopiedDocument, ofComment, pending, removed]) {
      repository.rows.set(row.id, row);
    }
    const facade = new FilesFacade(repository, () => NOW);

    const result = await inTenant(TENANT, () =>
      facade.copyLogicallyIn({} as TenantTx, {
        sourceProcessId: SOURCE,
        targetProcessId: TARGET,
        documents: new Map([[DOC, NEW_DOC]]),
      }),
    );

    expect(result).toEqual({ copied: 2, skipped: 1 });
    const copies = [...repository.rows.values()].filter((row) => row.processId === TARGET);
    expect(copies.map((row) => [row.targetType, row.targetId, row.sourceAttachmentId])).toEqual([
      ['PROCESS', TARGET, ofProcess.id],
      ['DOCUMENT', NEW_DOC, ofDocument.id],
    ]);
    for (const copy of copies) {
      const source = copy.sourceAttachmentId === ofProcess.id ? ofProcess : ofDocument;
      expect(copy).toMatchObject({
        status: 'AVAILABLE',
        storageKey: source.storageKey,
        sha256: source.sha256,
        scannedAt: source.scannedAt,
        quarantineKey: null,
        createdAt: NOW,
        updatedById: CARLA,
        version: 1,
      });
      expect(copy.id).not.toBe(source.id);
    }
    // A origem não muda (RN-PROC-125).
    expect(repository.rows.get(ofProcess.id)).toEqual(ofProcess);
  });
});

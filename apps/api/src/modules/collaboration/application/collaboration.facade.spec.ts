import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';

import { CollaborationFacade } from './collaboration.facade.js';
import type { DocumentFacade } from '../../document/application/document.facade.js';
import { createComment } from '../domain/comment.js';
import { InMemoryCommentRepository } from '../infrastructure/in-memory-comment.repository.js';

const TENANT = '0192d071-0000-7000-8000-000000000001';
const PROCESS = '0192d071-0000-7000-8000-000000000002';
const DOCUMENT = '0192d071-0000-7000-8000-000000000003';
const USER = '0192d071-0000-7000-8000-000000000004';

function inTenant<T>(work: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    { correlationId: 'c-1', ip: '127.0.0.1', userAgent: 'vitest' },
    () => {
      updateRequestContext({
        tenantId: TENANT,
        actor: { type: 'USER', userId: USER, membershipId: null },
      });
      return work();
    },
  );
}

describe('CollaborationFacade', () => {
  it('commentLabels: texto, sigilo do documento-alvo e exclusão (fonte COMMENT da timeline)', async () => {
    const repository = new InMemoryCommentRepository();
    const base = {
      tenantId: TENANT,
      processId: PROCESS,
      parentId: null,
      authorId: USER,
      body: { type: 'doc' },
      now: new Date('2026-10-17T10:00:00Z'),
    };
    const onProcess = createComment({
      ...base,
      id: '0192d071-0000-7000-8000-0000000000a1',
      target: { targetType: 'PROCESS', documentId: null, sectionKey: null },
      bodyText: 'Rever o item 2.',
    });
    const onDocument = createComment({
      ...base,
      id: '0192d071-0000-7000-8000-0000000000a2',
      target: { targetType: 'DOCUMENT', documentId: DOCUMENT, sectionKey: null },
      bodyText: 'Cotação alta.',
    });
    repository.seed(onProcess, { ...onDocument, deletedAt: new Date(), deletedById: USER });
    const documents = {
      commentDocumentLabels: () =>
        Promise.resolve(
          new Map([
            [DOCUMENT, { code: 'PP 0001/2026', title: 'Pesquisa', confidentiality: 'RESTRICTED' }],
          ]),
        ),
    } as unknown as DocumentFacade;
    const facade = new CollaborationFacade(repository, documents);

    const labels = await inTenant(() =>
      runSimulatedTransaction((tx) =>
        facade.commentLabels(tx, [onProcess.id, onDocument.id, PROCESS]),
      ),
    );
    expect(labels.get(onProcess.id)).toEqual({
      excerpt: 'Rever o item 2.',
      restricted: false,
      isDeleted: false,
    });
    expect(labels.get(onDocument.id)).toEqual({
      excerpt: 'Cotação alta.',
      restricted: true,
      isDeleted: true,
    });
    expect(labels.has(PROCESS)).toBe(false);
  });
});

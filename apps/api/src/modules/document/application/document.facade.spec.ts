import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';

import type { DocumentAiTargets } from './document-ai-target.js';
import type { DocumentApprovalTransitions } from './document-approval.transitions.js';
import type { CreateDocumentInput, DocumentCreationService } from './document-creation.service.js';
import { DocumentFacade } from './document.facade.js';
import { DocumentValidatorRegistry } from './document.ports.js';
import type { DocumentValidator } from './document.ports.js';
import type { TypedCollectionGuard } from './typed-collection-guard.js';
import {
  buildDocument,
  buildDocumentType,
  buildVersion,
} from '../../../../test/support/document-fixtures.js';
import { InMemoryDocumentTypeRepository } from '../infrastructure/in-memory-document-type.repository.js';
import { InMemoryDocumentRepository } from '../infrastructure/in-memory-document.repository.js';

const TENANT = '0192f065-0000-7000-8000-00000000000a';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const CARLA = '0192f065-0000-7000-8000-0000000000c1';
const SOURCE = '0192f065-0000-7000-8000-0000000000b1';
const TARGET = '0192f065-0000-7000-8000-0000000000b2';

function facadeWith(creation: Partial<DocumentCreationService> = {}) {
  const documents = new InMemoryDocumentRepository();
  const types = new InMemoryDocumentTypeRepository();
  const validators = new DocumentValidatorRegistry();
  const facade = new DocumentFacade(
    documents,
    types,
    validators,
    creation as DocumentCreationService,
    {} as DocumentApprovalTransitions,
    {} as DocumentAiTargets,
    {} as TypedCollectionGuard,
    () => NOW,
  );
  return { facade, documents, types, validators };
}

function inTenant<T>(work: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    { correlationId: 'c-1', ip: '127.0.0.1', userAgent: 'vitest' },
    () => {
      updateRequestContext({
        tenantId: TENANT,
        actor: { type: 'USER', userId: CARLA, membershipId: null },
      });
      return work();
    },
  );
}

describe('DocumentFacade (US-065)', () => {
  it('registra um DocumentValidator por módulo tipado e recusa um segundo do mesmo módulo', () => {
    const { facade, validators } = facadeWith();
    const dfd: DocumentValidator = { module: 'DFD', validate: () => Promise.resolve([]) };
    facade.registerValidator(dfd);
    facade.registerValidator(dfd);
    expect(validators.find('DFD')).toBe(dfd);
    expect(validators.find(null)).toBeNull();
    expect(validators.find('ETP')).toBeNull();
    expect(() => {
      facade.registerValidator({ module: 'DFD', validate: () => Promise.resolve([]) });
    }).toThrow(/já registrado/);
  });

  it('fornece os nomes congelados da timeline: rótulo do documento e número da versão', async () => {
    const { facade, documents, types } = facadeWith();
    const type = buildDocumentType({ tenantId: TENANT, name: 'Estudo Técnico Preliminar' });
    types.seed(type);
    const document = buildDocument({
      tenantId: TENANT,
      documentTypeId: type.id,
      code: 'ETP 0001/2026',
      title: 'ETP da aquisição de cimento',
    });
    documents.seed(document);
    const version = buildVersion(document, { versionNumber: 3 });
    documents.seedVersion(version);

    await inTenant(() =>
      runSimulatedTransaction(async (tx) => {
        const labels = await facade.documentLabels(tx, [document.id, 'ausente']);
        expect([...labels]).toEqual([
          [
            document.id,
            {
              code: 'ETP 0001/2026',
              title: 'ETP da aquisição de cimento',
              typeName: 'Estudo Técnico Preliminar',
            },
          ],
        ]);
        expect([...(await facade.versionNumbers(tx, [version.id]))]).toEqual([[version.id, 3]]);
      }),
    );
  });

  it('copia como rascunho só os estruturados ativos da origem (US-011 · RN-PROC-120)', async () => {
    const inputs: CreateDocumentInput[] = [];
    const { facade, documents, types } = facadeWith({
      create: (_tx, input) => {
        inputs.push(input);
        return Promise.resolve(buildDocument({ processId: input.processId }));
      },
    });
    const dfd = buildDocumentType({ tenantId: TENANT, code: 'DFD', kind: 'STRUCTURED' });
    const retired = buildDocumentType({
      tenantId: TENANT,
      code: 'ANTIGO',
      kind: 'STRUCTURED',
      isActive: false,
    });
    const memo = buildDocumentType({ tenantId: TENANT, code: 'OFICIO', kind: 'FREE_TEXT' });
    types.seed(dfd);
    types.seed(retired);
    types.seed(memo);
    const approved = buildDocument({
      tenantId: TENANT,
      processId: SOURCE,
      documentTypeId: dfd.id,
      status: 'APPROVED',
      confidentiality: 'RESTRICTED',
      title: 'DFD da merenda',
      draftContent: {
        sections: {
          OBJETO: {
            state: 'FILLED',
            content: { type: 'doc' },
            justification: null,
            revision: 7,
            updatedAt: '2026-01-02T10:00:00.000Z',
            updatedById: '0192f065-0000-7000-8000-0000000000d1',
          },
        },
      },
    });
    documents.seed(approved);
    documents.seed(
      buildDocument({ tenantId: TENANT, processId: SOURCE, documentTypeId: retired.id }),
    );
    documents.seed(buildDocument({ tenantId: TENANT, processId: SOURCE, documentTypeId: memo.id }));
    documents.seed(
      buildDocument({
        tenantId: TENANT,
        processId: SOURCE,
        documentTypeId: dfd.id,
        status: 'CANCELED',
      }),
    );

    const result = await inTenant(() =>
      runSimulatedTransaction((tx) =>
        facade.copyStructuredAsDraftsIn(tx, {
          sourceProcessId: SOURCE,
          targetProcessId: TARGET,
          idempotencyKey: 'K9',
        }),
      ),
    );

    expect(result.skipped).toBe(1);
    expect([...result.copied.keys()]).toEqual([approved.id]);
    expect(inputs).toEqual([
      {
        processId: TARGET,
        documentTypeId: dfd.id,
        title: 'DFD da merenda',
        templateVersionId: approved.templateVersionId,
        draftContent: {
          sections: {
            OBJETO: {
              state: 'FILLED',
              content: { type: 'doc' },
              justification: null,
              revision: 1,
              updatedAt: NOW.toISOString(),
              updatedById: CARLA,
            },
          },
        },
        confidentiality: 'RESTRICTED',
        sourceDocumentId: approved.id,
        idempotencyKey: 'K9',
      },
    ]);
  });
});

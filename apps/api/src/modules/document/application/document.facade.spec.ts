import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';

import type { DocumentApprovalTransitions } from './document-approval.transitions.js';
import type { DocumentCreationService } from './document-creation.service.js';
import { DocumentFacade } from './document.facade.js';
import { DocumentValidatorRegistry } from './document.ports.js';
import type { DocumentValidator } from './document.ports.js';
import {
  buildDocument,
  buildDocumentType,
  buildVersion,
} from '../../../../test/support/document-fixtures.js';
import { InMemoryDocumentTypeRepository } from '../infrastructure/in-memory-document-type.repository.js';
import { InMemoryDocumentRepository } from '../infrastructure/in-memory-document.repository.js';

const TENANT = '0192f065-0000-7000-8000-00000000000a';

function facadeWith() {
  const documents = new InMemoryDocumentRepository();
  const types = new InMemoryDocumentTypeRepository();
  const validators = new DocumentValidatorRegistry();
  const facade = new DocumentFacade(
    documents,
    types,
    validators,
    {} as DocumentCreationService,
    {} as DocumentApprovalTransitions,
  );
  return { facade, documents, types, validators };
}

function inTenant<T>(work: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    { correlationId: 'c-1', ip: '127.0.0.1', userAgent: 'vitest' },
    () => {
      updateRequestContext({ tenantId: TENANT });
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
});

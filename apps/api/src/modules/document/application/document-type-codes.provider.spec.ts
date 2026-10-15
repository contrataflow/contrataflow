import { describe, expect, it } from 'vitest';

import { DocumentTypeCatalog } from '#shared/document/document-type-catalog.js';

import { DocumentTypeCodesAdapter } from './document-type-codes.provider.js';
import type { DocumentTypeRepository } from './ports.js';
import type { DocumentType } from '../domain/document-type.js';

describe('DocumentTypeCodesAdapter (porta DocumentTypeCatalog — US-040)', () => {
  it('registra-se no catálogo e separa os códigos ativos dos inativos do tenant', async () => {
    const types = [
      { code: 'DFD', isActive: true },
      { code: 'OFICIO', isActive: false },
    ] as DocumentType[];
    const repository = { list: () => Promise.resolve(types) } as unknown as DocumentTypeRepository;
    const catalog = new DocumentTypeCatalog();
    await expect(catalog.codesOf({} as never)).resolves.toMatchObject({ active: new Set() });

    new DocumentTypeCodesAdapter(repository, catalog).onModuleInit();

    await expect(catalog.codesOf({} as never)).resolves.toEqual({
      active: new Set(['DFD']),
      inactive: new Set(['OFICIO']),
    });
  });
});

import { describe, expect, it } from 'vitest';

import { TermImportedFromEtp } from './events.js';
import {
  hasImportSelection,
  TERM_IMPORT_MESSAGES,
  termImportApplySchema,
  termImportPreviewSchema,
} from './term-import.js';

const ID = '0192d037-0000-7000-8000-0000000000e1';

describe('termImportApplySchema (TRM-06 · V-01/V-03)', () => {
  it('copyItems padrão true; seleção vazia = REQUIRED com a mensagem da story', () => {
    expect(termImportApplySchema.parse({ importToken: 't', sections: [], fields: [] })).toEqual({
      importToken: 't',
      sections: [],
      fields: [],
      copyItems: true,
    });
    const result = termImportApplySchema.safeParse({
      importToken: 't',
      sections: [],
      fields: [],
      copyItems: false,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['sections'],
      message: TERM_IMPORT_MESSAGES.noSelection,
      params: { code: 'REQUIRED' },
    });
  });

  it('token ausente, campo desconhecido e chave extra são recusados', () => {
    expect(termImportApplySchema.safeParse({ sections: ['OBJECT'], fields: [] }).success).toBe(
      false,
    );
    expect(
      termImportApplySchema.safeParse({ importToken: 't', sections: [], fields: ['objeto'] })
        .success,
    ).toBe(false);
    expect(
      termImportApplySchema.safeParse({ importToken: 't', sections: [], fields: [], extra: 1 })
        .success,
    ).toBe(false);
  });

  it('hasImportSelection e mensagens', () => {
    expect(hasImportSelection({ sections: [], fields: [], copyItems: false })).toBe(false);
    expect(
      hasImportSelection({ sections: [], fields: ['priceResearchId'], copyItems: false }),
    ).toBe(true);
    expect(TERM_IMPORT_MESSAGES.appendedFrom(2, '20/10/2026')).toBe(
      'Importado do ETP v2 em 20/10/2026',
    );
    expect(TERM_IMPORT_MESSAGES.appendedFrom(null, '20/10/2026')).toBe(
      'Importado do ETP em 20/10/2026',
    );
    expect(TERM_IMPORT_MESSAGES.applied(4, 8)).toBe(
      'Importação aplicada: 4 seções e 8 itens atualizados',
    );
    expect(TERM_IMPORT_MESSAGES.applied(1, 1)).toBe(
      'Importação aplicada: 1 seção e 1 item atualizado',
    );
    expect(TERM_IMPORT_MESSAGES.sectionTooLong('Objeto')).toContain('"Objeto"');
  });
});

describe('termImportPreviewSchema e TermImportedFromEtp', () => {
  it('prévia mínima válida', () => {
    expect(
      termImportPreviewSchema.safeParse({
        importToken: 'v1.a.b',
        expiresAt: '2026-10-20T15:15:00.000Z',
        etp: { id: ID, code: null, status: 'DRAFT', versionNumber: null, inProgress: true },
        sections: [],
        fields: [],
        items: { count: 0, copyQuantities: true, copyCalculationMemoToNotes: false, preview: [] },
        replacesPriceResearchValue: false,
      }).success,
    ).toBe(true);
  });

  it('evento: routing key fixa; etpVersionId pode ser nulo (FA-02)', () => {
    const resolved = TermImportedFromEtp.resolve({
      termId: ID,
      etpId: ID,
      etpVersionId: null,
      sectionsImported: ['OBJECT'],
      itemsImported: 0,
    });
    expect(resolved).toMatchObject({
      eventType: 'TermImportedFromEtp',
      routingKey: 'term.imported_from_etp',
      aggregateType: 'TermOfReference',
    });
  });
});

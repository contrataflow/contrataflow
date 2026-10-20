import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_MESSAGES,
  documentCancelSchema,
  documentReopenSchema,
  documentTransitionSchema,
  documentUpdateSchema,
  draftContentSchema,
} from './document.js';
import { DocumentFinalized, DocumentReopened, DocumentVersionCreated } from './events.js';

/* US-065 — contratos do ciclo de vida do documento (api/03-documents.md · events.md §4.3). */

const ID = '0192f065-0000-7000-8000-0000000000d1';
const REASON = 'Ajuste pedido pelo controle interno.';

describe('requisições do ciclo de vida', () => {
  it('justificativa de reabertura/cancelamento tem ao menos 20 caracteres (V-03)', () => {
    expect(documentReopenSchema.safeParse({ reopenReason: REASON }).success).toBe(true);
    const short = documentCancelSchema.safeParse({ cancellationReason: '   curto   ' });
    expect(short.success).toBe(false);
    expect(short.error?.issues[0]?.message).toBe(DOCUMENT_MESSAGES.reasonTooShort);
    expect(documentCancelSchema.safeParse({ cancellationReason: 'x'.repeat(2001) }).success).toBe(
      false,
    );
  });

  it('finalizar/submeter sem corpo = nenhum aviso reconhecido; campo desconhecido recusado', () => {
    expect(documentTransitionSchema.parse(undefined)).toEqual({});
    expect(documentTransitionSchema.parse({ acknowledgedWarnings: ['ETP_X'] })).toEqual({
      acknowledgedWarnings: ['ETP_X'],
    });
    expect(documentTransitionSchema.safeParse({ status: 'FINALIZED' }).success).toBe(false);
  });

  it('DOC-04 exige título ou responsável e nunca aceita status (RN-DOC-41)', () => {
    expect(documentUpdateSchema.safeParse({}).success).toBe(false);
    expect(documentUpdateSchema.safeParse({ title: 'Abc' }).success).toBe(false);
    expect(documentUpdateSchema.parse({ title: '  Despacho final  ' })).toEqual({
      title: 'Despacho final',
    });
    expect(documentUpdateSchema.safeParse({ status: 'APPROVED' }).success).toBe(false);
  });

  it('rascunho de trabalho por seção (entities.md §5.3.1)', () => {
    expect(
      draftContentSchema.safeParse({
        sections: {
          OBJETO: {
            state: 'FILLED',
            content: { type: 'doc', content: [] },
            justification: null,
            revision: 2,
            updatedAt: '2026-10-16T13:00:00Z',
            updatedById: ID,
          },
        },
      }).success,
    ).toBe(true);
    expect(draftContentSchema.safeParse({ sections: { X: { state: 'OUTRO' } } }).success).toBe(
      false,
    );
  });
});

describe('eventos de documento (DEC-162)', () => {
  it('routing key document.<fato>.<tipo_em_minúsculas>', () => {
    const payload = { documentId: ID, documentTypeCode: 'PARECER_TECNICO', documentVersionId: ID };
    expect(DocumentFinalized.resolve(payload).routingKey).toBe(
      'document.finalized.parecer_tecnico',
    );
    expect(
      DocumentVersionCreated.resolve({
        ...payload,
        versionNumber: 1,
        reason: 'FINALIZATION',
        contentHash: 'a'.repeat(64),
      }).routingKey,
    ).toBe('document.version_created.parecer_tecnico');
    expect(
      DocumentReopened.resolve({
        documentId: ID,
        documentTypeCode: 'ETP',
        fromStatus: 'APPROVED',
        baseVersionId: ID,
      }).routingKey,
    ).toBe('document.reopened.etp');
  });

  it('payload sem conteúdo nem justificativa: campos extras são recusados', () => {
    expect(() =>
      DocumentReopened.resolve({
        documentId: ID,
        documentTypeCode: 'ETP',
        fromStatus: 'APPROVED',
        baseVersionId: null,
        reason: 'texto livre',
      }),
    ).toThrow(/DocumentReopened/);
  });
});

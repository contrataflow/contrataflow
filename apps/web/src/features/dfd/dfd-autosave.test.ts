import type { DfdDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import {
  classifyDfdAutosaveError,
  dfdHeaderPatch,
  headerDraftOf,
  mergeDfdHeader,
  resumeStep,
  sectionKeyOf,
  sectionTarget,
} from './dfd-autosave';

const TODAY = '2026-10-17';

const DFD = {
  id: '0192a000-0000-7000-8000-000000000d01',
  documentId: '0192a000-0000-7000-8000-000000000d01',
  processId: '0192a000-0000-7000-8000-000000000b01',
  code: 'DFD 0005/2026',
  title: 'DFD — Aquisição',
  status: 'DRAFT',
  templateVersionId: null,
  documentVersion: 1,
  draftRevision: 1,
  requestDate: TODAY,
  requestingDepartmentId: '0192a000-0000-7000-8000-000000000c01',
  responsibleId: '0192a000-0000-7000-8000-000000000a01',
  objectSummary: 'Aquisição de insumos para a UBS Centro',
  priority: 'MEDIUM',
  expectedDate: null,
  estimatedValue: null,
  estimatedValueMasked: false,
  pcaStatus: 'NOT_APPLICABLE',
  pcaYear: null,
  pcaItemCode: null,
  pcaJustification: null,
  wizardStep: 'IDENTIFICATION',
  completedSteps: [],
  createdAt: '2026-10-17T15:00:00.000Z',
  updatedAt: '2026-10-17T15:00:00.000Z',
  version: 8,
} satisfies DfdDto;

const base = headerDraftOf(DFD);

const apiError = (status: number, code: string, problem: Record<string, unknown> = {}) =>
  new ApiError({
    status,
    code,
    detail: `detalhe ${code}`,
    problem: {
      type: 'https://docs.contrataflow.com.br/errors/x',
      title: 't',
      status,
      detail: `detalhe ${code}`,
      instance: '/x',
      code,
      correlationId: 'c',
      errors: [],
      violations: [],
      ...problem,
    },
  });

describe('Autosave do DFD — regras de tela (US-015)', () => {
  it('alvos: SECTION:<CHAVE> e HEADER', () => {
    expect(sectionTarget('JUSTIFICATION')).toBe('SECTION:JUSTIFICATION');
    expect(sectionKeyOf('SECTION:NOTES')).toBe('NOTES');
    expect(sectionKeyOf('HEADER')).toBeNull();
  });

  describe('dfdHeaderPatch (RN-DFD-27)', () => {
    it('envia apenas os campos alterados', () => {
      expect(dfdHeaderPatch({ ...base, priority: 'HIGH' }, base, { today: TODAY }).patch).toEqual({
        priority: 'HIGH',
      });
      expect(dfdHeaderPatch(base, base, { today: TODAY }).patch).toEqual({});
    });

    it('segura o grupo inteiro enquanto inválido (CHECKs de dfds) e não apaga obrigatórios', () => {
      const planned = dfdHeaderPatch({ ...base, pcaStatus: 'PLANNED', priority: 'LOW' }, base, {
        today: TODAY,
      });
      expect(planned).toEqual({ patch: { priority: 'LOW' }, held: ['pcaStatus'] });
      expect(
        dfdHeaderPatch({ ...base, pcaStatus: 'PLANNED', pcaYear: 2027 }, base, { today: TODAY })
          .patch,
      ).toEqual({ pcaStatus: 'PLANNED', pcaYear: 2027 });
      expect(dfdHeaderPatch({ ...base, objectSummary: '  ' }, base, { today: TODAY }).held).toEqual(
        ['objectSummary'],
      );
      expect(
        dfdHeaderPatch({ ...base, estimatedValue: '10,5' }, base, { today: TODAY }).patch,
      ).toEqual({});
      expect(
        dfdHeaderPatch(
          { ...base, pcaItemCode: '  ' },
          { ...base, pcaItemCode: 'PCA-1' },
          { today: TODAY },
        ).patch,
      ).toEqual({ pcaItemCode: null });
    });

    it('POL-09: a estimativa mascarada nunca é enviada', () => {
      const masked = { ...base, estimatedValueMasked: true };
      expect(
        dfdHeaderPatch({ ...masked, estimatedValue: '10.00' }, masked, { today: TODAY }).patch,
      ).toEqual({});
    });
  });

  describe('mergeDfdHeader (RN-DFD-28)', () => {
    it('campos diferentes: sem conflito; o local passa a ter a alteração do servidor', () => {
      const merged = mergeDfdHeader(
        base,
        { ...base, priority: 'URGENT' },
        { ...base, expectedDate: '2027-03-01' },
      );
      expect(merged.conflicts).toEqual([]);
      expect(merged.remote).toEqual(['expectedDate']);
      expect(merged.local).toMatchObject({ priority: 'URGENT', expectedDate: '2027-03-01' });
      expect(
        dfdHeaderPatch(merged.local, { ...base, expectedDate: '2027-03-01' }, { today: TODAY })
          .patch,
      ).toEqual({
        priority: 'URGENT',
      });
    });

    it('mesmo campo: conflito; passos unidos', () => {
      const merged = mergeDfdHeader(
        base,
        { ...base, priority: 'HIGH', completedSteps: ['JUSTIFICATION'] },
        { ...base, priority: 'URGENT', completedSteps: ['IDENTIFICATION'] },
      );
      expect(merged.conflicts).toEqual(['priority']);
      expect(merged.local.completedSteps).toEqual(['IDENTIFICATION', 'JUSTIFICATION']);
    });
  });

  describe('classifyDfdAutosaveError (FA-01..09)', () => {
    it.each([
      [
        apiError(412, 'SECTION_REVISION_CONFLICT', { meta: { current: { revision: 6 } } }),
        'conflict',
      ],
      [apiError(401, 'SESSION_EXPIRED'), 'sessionExpired'],
      [apiError(403, 'NOT_PROCESS_CUSTODIAN'), 'blocked'],
      [
        apiError(409, 'DOCUMENT_NOT_EDITABLE', { meta: { status: 'IN_REVIEW', statusSince: 'x' } }),
        'blocked',
      ],
      [apiError(429, 'RATE_LIMITED'), 'rateLimited'],
      [apiError(503, 'DEPENDENCY_UNAVAILABLE'), 'offline'],
      [new Error('rede'), 'offline'],
    ])('%#: %s → %s', (error, kind) => {
      expect(classifyDfdAutosaveError(error).kind).toBe(kind);
    });

    it('detalhes: meta.current, status do documento, mensagens de 422/413/428', () => {
      expect(
        classifyDfdAutosaveError(
          apiError(412, 'SECTION_REVISION_CONFLICT', { meta: { current: { revision: 6 } } }),
        ),
      ).toEqual({ kind: 'conflict', current: { kind: 'section', current: { revision: 6 } } });
      expect(
        classifyDfdAutosaveError(
          apiError(409, 'DOCUMENT_NOT_EDITABLE', {
            meta: { status: 'IN_REVIEW', statusSince: '2026-10-17T17:40:00.000Z' },
          }),
        ),
      ).toMatchObject({
        detail: {
          code: 'DOCUMENT_NOT_EDITABLE',
          status: 'IN_REVIEW',
          statusSince: '2026-10-17T17:40:00.000Z',
        },
      });
      expect(
        classifyDfdAutosaveError(
          new ApiError({
            status: 422,
            code: 'VALIDATION_ERROR',
            errors: [
              { field: 'content', code: 'TOO_LONG', message: 'O texto excede 50.000 caracteres.' },
            ],
          }),
        ),
      ).toEqual({ kind: 'invalid', message: 'O texto excede 50.000 caracteres.' });
      expect(classifyDfdAutosaveError(apiError(413, 'PAYLOAD_TOO_LARGE'))).toEqual({
        kind: 'invalid',
        message: 'O conteúdo desta seção é grande demais.',
      });
      expect(classifyDfdAutosaveError(apiError(428, 'PRECONDITION_REQUIRED'))).toEqual({
        kind: 'invalid',
        message: 'Recarregue a página para continuar editando.',
      });
      expect(
        classifyDfdAutosaveError(
          new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 7 }),
        ),
      ).toEqual({ kind: 'rateLimited', retryAfterMs: 7000 });
    });
  });

  it('resumeStep (RN-DFD-34): Conclusão com pendência bloqueante abre a Revisão', () => {
    expect(resumeStep('PLANNING', true)).toBe('PLANNING');
    expect(resumeStep('CONCLUSION', false)).toBe('CONCLUSION');
    expect(resumeStep('CONCLUSION', true)).toBe('REVIEW');
  });
});

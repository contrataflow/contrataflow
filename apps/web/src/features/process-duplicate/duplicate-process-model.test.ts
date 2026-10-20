import { duplicateProcessSchema } from '@contrataflow/validation';
import type { ProcessDocumentDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { MANUTENCAO, OBRAS, processDto } from '@test/support/process-fixtures';

import {
  duplicateBody,
  duplicateValuesOf,
  eligibleDocuments,
  splitErrors,
  validateDuplicate,
} from './duplicate-process-model';

const document = (
  kind: 'STRUCTURED' | 'FREE_TEXT' | 'UPLOADED',
  status: ProcessDocumentDto['status'],
  title: string,
) =>
  ({
    id: title,
    title,
    status,
    documentType: { kind },
  }) as unknown as ProcessDocumentDto;

describe('Modelo do diálogo "Duplicar processo" (US-011 · SCR-113)', () => {
  it('pré-preenche título, objeto e unidades da origem, com as cópias opcionais desligadas', () => {
    expect(duplicateValuesOf(processDto())).toEqual({
      title: 'Aquisição de cimento para manutenção de vias',
      object: 'Aquisição de cimento Portland para a manutenção das vias do município.',
      requestingSecretariatId: OBRAS.id,
      requestingDepartmentId: MANUTENCAO.id,
      copyDocuments: false,
      copyAttachments: false,
    });
  });

  it('V-01: os mesmos limites do PRC-02 e as unidades obrigatórias', () => {
    const values = duplicateValuesOf(processDto());
    expect(validateDuplicate(values)).toEqual({});
    expect(
      validateDuplicate({
        ...values,
        title: 'Obra',
        object: '',
        requestingSecretariatId: '',
        requestingDepartmentId: '',
      }),
    ).toEqual({
      title: 'O título deve ter entre 5 e 200 caracteres.',
      object: 'Informe o objeto.',
      requestingSecretariatId: 'Informe a secretaria solicitante.',
      requestingDepartmentId: 'Informe o setor solicitante.',
    });
  });

  it('o corpo do PRC-27 tem os textos aparados e passa no schema da API', () => {
    const body = duplicateBody({
      ...duplicateValuesOf(processDto()),
      title: '  Merenda escolar 2027  ',
      copyDocuments: true,
    });
    expect(body).toMatchObject({ title: 'Merenda escolar 2027', copyDocuments: true });
    expect(duplicateProcessSchema.safeParse(body).success).toBe(true);
  });

  it('FA-03: só documentos estruturados e não cancelados são elegíveis', () => {
    expect(
      eligibleDocuments([
        document('STRUCTURED', 'APPROVED', 'DFD'),
        document('STRUCTURED', 'CANCELED', 'ETP cancelado'),
        document('FREE_TEXT', 'DRAFT', 'Despacho'),
        document('UPLOADED', 'FINALIZED', 'Parecer'),
      ]).map((item) => item.title),
    ).toEqual(['DFD']);
  });

  it('erros da API: campos do diálogo nos campos; referências copiadas à parte (FA-01)', () => {
    expect(
      splitErrors([
        { field: 'title', code: 'TOO_SHORT', message: 'Título curto.' },
        {
          field: 'modalityId',
          code: 'REFERENCE_INACTIVE',
          message: 'Selecione uma modalidade válida.',
        },
        {
          field: 'originId',
          code: 'REFERENCE_INACTIVE',
          message: 'Selecione uma modalidade válida.',
        },
      ]),
    ).toEqual({
      fields: { title: 'Título curto.' },
      others: ['Selecione uma modalidade válida.'],
    });
  });
});

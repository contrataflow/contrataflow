import { describe, expect, it } from 'vitest';

import { ProcessCreated } from './events.js';
import {
  CREATE_PROCESS_STEP_FIELDS,
  PROCESS_MESSAGES,
  checkDuplicateProcessesSchema,
  createProcessSchema,
  pcaIssues,
  processDateIssues,
} from './process.js';

const ID = '0192f000-0000-7000-8000-0000000000c1';

const valid = {
  title: 'Aquisição de cimento para manutenção de vias',
  object: 'Cimento CP-II para a manutenção das vias.',
  contractingTypeId: ID,
  requestingSecretariatId: ID,
  requestingDepartmentId: ID,
  originId: ID,
  pcaStatus: 'NOT_APPLICABLE',
};

describe('createProcessSchema (US-001 · PRC-02)', () => {
  it('aplica os padrões: prioridade MEDIUM, sem SRP e sem confirmação de duplicidade', () => {
    expect(createProcessSchema.parse(valid)).toMatchObject({
      priority: 'MEDIUM',
      isPriceRegistration: false,
      confirmDuplicate: false,
    });
  });

  it('V-01/V-02: mensagens da story por campo', () => {
    const result = createProcessSchema.safeParse({ ...valid, object: 'curto', pcaStatus: 'X' });
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['object', PROCESS_MESSAGES.objectLength],
      ['pcaStatus', PROCESS_MESSAGES.pcaStatusRequired],
    ]);
    expect(
      createProcessSchema.safeParse({ ...valid, contractingTypeId: undefined }).error?.issues[0]
        ?.message,
    ).toBe('Informe o tipo de contratação.');
  });

  it('V-08: valor estimado com até 2 casas, sem sinal', () => {
    expect(createProcessSchema.safeParse({ ...valid, estimatedValue: '1234.56' }).success).toBe(
      true,
    );
    for (const value of ['1.234', '-5', '1,5', 'abc']) {
      expect(createProcessSchema.safeParse({ ...valid, estimatedValue: value }).success).toBe(
        false,
      );
    }
  });

  it('V-09: PCA previsto exige exercício; fora do PCA exige justificativa de 20 caracteres', () => {
    expect(pcaIssues({ pcaStatus: 'PLANNED', pcaYear: null })).toEqual([
      { path: 'pcaYear', message: PROCESS_MESSAGES.pcaYearRequired },
    ]);
    expect(pcaIssues({ pcaStatus: 'NOT_PLANNED', pcaJustification: '  curta  ' })).toEqual([
      { path: 'pcaJustification', message: PROCESS_MESSAGES.pcaJustificationRequired },
    ]);
    expect(
      pcaIssues({ pcaStatus: 'NOT_PLANNED', pcaJustification: 'Demanda emergencial imprevista.' }),
    ).toEqual([]);
    const parsed = createProcessSchema.safeParse({ ...valid, pcaStatus: 'PLANNED' });
    expect(parsed.error?.issues[0]).toMatchObject({
      path: ['pcaYear'],
      params: { code: 'CONDITIONAL_REQUIRED' },
    });
  });

  it('V-07 e RN-PROC-12: prazo alvo ≥ hoje e exercício corrente ou seguinte', () => {
    const context = { today: '2026-10-16', currentYear: 2026 };
    expect(processDateIssues({ targetDate: '2026-10-16' }, context)).toEqual([]);
    expect(
      processDateIssues({ targetDate: '2026-10-15', pcaStatus: 'PLANNED', pcaYear: 2028 }, context),
    ).toEqual([
      { path: 'targetDate', message: PROCESS_MESSAGES.targetDatePast },
      { path: 'pcaYear', message: PROCESS_MESSAGES.pcaYearRange },
    ]);
    expect(processDateIssues({ pcaStatus: 'PLANNED', pcaYear: 2027 }, context)).toEqual([]);
  });

  it('os passos do wizard cobrem todos os campos do corpo, sem repetir', () => {
    const fields = Object.values(CREATE_PROCESS_STEP_FIELDS).flat();
    expect(new Set(fields).size).toBe(fields.length);
    expect([...fields, 'confirmDuplicate'].sort()).toEqual(
      Object.keys(createProcessSchema.shape).sort(),
    );
  });

  it('PRC-03 usa as mesmas regras de título e objeto', () => {
    expect(
      checkDuplicateProcessesSchema.safeParse({ ...valid, title: 'Abc' }).error?.issues[0]?.message,
    ).toBe(PROCESS_MESSAGES.titleLength);
  });
});

describe('ProcessCreated (events.md §4.1)', () => {
  it('routing key process.created e payload estrito (sem valor estimado)', () => {
    const payload = {
      code: null,
      number: null,
      year: 2026,
      title: 'Aquisição de cimento',
      organizationId: ID,
      requestingSecretariatId: ID,
      requestingDepartmentId: ID,
      contractingTypeCode: 'AQUISICAO_BENS',
      modalityCode: null,
      priority: 'MEDIUM',
      workflowId: ID,
      workflowVersionId: ID,
      initialStageKey: 'ABERTURA',
      initialDepartmentId: ID,
      initialResponsibleId: null,
      creationChannel: 'WEB',
      duplicatedFromId: null,
    };
    expect(ProcessCreated.resolve(payload).routingKey).toBe('process.created');
    expect(() => ProcessCreated.resolve({ ...payload, estimatedValue: '10.00' })).toThrow();
  });
});

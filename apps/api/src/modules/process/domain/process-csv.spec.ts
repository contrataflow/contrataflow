import type { ProcessListItemDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  columnValues,
  csvCell,
  csvRowSerializer,
  deadlineSituation,
  fileStamp,
  formatDecimal,
  formatLocalDate,
  formatZonedDateTime,
  neutralizeFormula,
  processExportFileName,
} from './process-csv.js';

const TZ = 'America/Sao_Paulo';
const ID = '0192d003-0000-7000-8000-000000000001';

const item = (overrides: Partial<ProcessListItemDto> = {}): ProcessListItemDto => ({
  id: ID,
  code: '0012/2026',
  number: 12,
  year: 2026,
  internalCode: null,
  title: 'Aquisição de cimento',
  status: 'IN_PROGRESS',
  priority: 'HIGH',
  organization: { id: ID, shortName: 'PMSJ' },
  requestingSecretariat: { id: ID, name: 'Secretaria de Obras' },
  requestingDepartment: { id: ID, name: 'Setor de Manutenção' },
  currentStage: { key: 'ABERTURA', name: 'Abertura' },
  currentDepartment: { id: ID, name: 'Setor de Cotações' },
  currentResponsible: null,
  deadline: {
    dueAt: '2026-10-08T02:59:59.999Z',
    slaType: 'BUSINESS',
    daysLeft: 2,
    overdueDays: null,
    isDueSoon: true,
    isOverdue: false,
    isPaused: false,
  },
  contractingType: { id: ID, code: 'AQUISICAO_BENS', label: 'Aquisição de bens' },
  modality: null,
  origin: { id: ID, code: 'DEMANDA', label: 'Demanda não prevista' },
  isBudgetConfidential: false,
  estimatedValue: '85000.00',
  estimatedValueMasked: false,
  targetDate: '2026-12-31',
  overdueSince: null,
  tags: [],
  openedAt: null,
  createdAt: '2026-09-14T13:02:11.000Z',
  updatedAt: '2026-10-02T18:40:00.000Z',
  ...overrides,
});

describe('CsvRowSerializer — neutralização (RN-PROC-43)', () => {
  it.each(['=1+1', '+5', '-2', '@SUM(A1)', '\tx', '\rx'])('prefixa apóstrofo em %j', (value) => {
    expect(neutralizeFormula(value)).toBe(`'${value}`);
  });

  it('texto comum, vazio e valores do sistema ficam como estão', () => {
    expect(neutralizeFormula('Cimento')).toBe('Cimento');
    expect(neutralizeFormula('')).toBe('');
    expect(csvCell({ kind: 'system', value: '-1,00' })).toBe('-1,00');
    expect(csvCell({ kind: 'text', value: null })).toBe('');
  });

  it('RFC 4180 com `;`: aspas duplicadas e campo entre aspas com separador, aspas ou quebra', () => {
    expect(csvCell({ kind: 'text', value: '=HYPERLINK("http://x.io";"Clique")' })).toBe(
      '"\'=HYPERLINK(""http://x.io"";""Clique"")"',
    );
    expect(csvCell({ kind: 'text', value: 'linha 1\nlinha 2' })).toBe('"linha 1\nlinha 2"');
    expect(csvCell({ kind: 'text', value: 'a,b' })).toBe('a,b');
  });
});

describe('CsvRowSerializer — formato pt-BR (RN-PROC-44)', () => {
  it('decimal com vírgula sem milhar; datas e data-hora no fuso do tenant', () => {
    expect(formatDecimal('1200000.00')).toBe('1200000,00');
    expect(formatLocalDate('2026-10-05')).toBe('05/10/2026');
    expect(formatZonedDateTime(new Date('2026-10-05T02:30:00.000Z'), TZ)).toBe('04/10/2026 23:30');
    expect(fileStamp(new Date('2026-10-05T17:32:00.000Z'), TZ)).toBe('20261005-1432');
    expect(processExportFileName(new Date('2026-10-05T17:32:00.000Z'), TZ)).toBe(
      'processos-20261005-1432.csv',
    );
  });

  it('BOM, cabeçalho com os rótulos do tenant, `;` e CRLF', () => {
    const serializer = csvRowSerializer(['code', 'requestingSecretariat', 'estimatedValue'], {
      timezone: TZ,
      labels: { secretariat: 'Diretoria', department: 'Setor' },
    });
    expect(serializer.header()).toBe(
      '﻿Código;Diretoria solicitante;Valor estimado;Orçamento sigiloso\r\n',
    );
    expect(serializer.line(item())).toBe('0012/2026;Secretaria de Obras;85000,00;Não\r\n');
  });

  it('POL-09: valor mascarado sai como "Sigiloso" e a coluna do sigilo acompanha', () => {
    const masked = item({
      isBudgetConfidential: true,
      estimatedValue: null,
      estimatedValueMasked: true,
    });
    expect(columnValues('estimatedValue', masked, TZ).map(csvCell)).toEqual(['Sigiloso', 'Sim']);
    const open = item({ isBudgetConfidential: true, estimatedValue: '1200000.00' });
    expect(columnValues('estimatedValue', open, TZ).map(csvCell)).toEqual(['1200000,00', 'Sim']);
    expect(columnValues('estimatedValue', item({ estimatedValue: null }), TZ).map(csvCell)).toEqual(
      ['', 'Não'],
    );
  });

  it('rótulos de enum (DEC-184) e demais colunas', () => {
    const full = item({
      currentResponsible: { id: ID, name: 'Ana Souza' },
      internalCode: 'INT-1',
      tags: [
        { id: ID, name: 'Obras', color: null, isActive: true },
        { id: ID, name: 'Urgente', color: null, isActive: true },
      ],
    });
    const cells = (column: Parameters<typeof columnValues>[0]) =>
      columnValues(column, full, TZ).map(csvCell);
    expect(cells('status')).toEqual(['Em andamento']);
    expect(cells('priority')).toEqual(['Alta']);
    expect(cells('stage')).toEqual(['Abertura']);
    expect(cells('currentDepartment')).toEqual(['Setor de Cotações']);
    expect(cells('currentResponsible')).toEqual(['Ana Souza']);
    expect(cells('deadline')).toEqual(['07/10/2026', 'Vence em breve']);
    expect(cells('requestingDepartment')).toEqual(['Setor de Manutenção']);
    expect(cells('organization')).toEqual(['PMSJ']);
    expect(cells('contractingType')).toEqual(['Aquisição de bens']);
    expect(cells('modality')).toEqual(['A definir']);
    expect(cells('origin')).toEqual(['Demanda não prevista']);
    expect(cells('targetDate')).toEqual(['31/12/2026']);
    expect(cells('tags')).toEqual(['Obras | Urgente']);
    expect(cells('internalCode')).toEqual(['INT-1']);
    expect(cells('createdAt')).toEqual(['14/09/2026 10:02']);
    expect(cells('updatedAt')).toEqual(['02/10/2026 15:40']);
    expect(columnValues('stage', item({ currentStage: null }), TZ).map(csvCell)).toEqual(['']);
    expect(columnValues('targetDate', item({ targetDate: null }), TZ).map(csvCell)).toEqual(['']);
  });

  it('situação do prazo', () => {
    const base = item().deadline;
    expect(deadlineSituation({ ...base, isPaused: true })).toBe('Pausado');
    expect(deadlineSituation({ ...base, isOverdue: true })).toBe('Atrasado');
    expect(deadlineSituation({ ...base, dueAt: null })).toBe('Sem prazo');
    expect(deadlineSituation({ ...base, isDueSoon: false })).toBe('No prazo');
    expect(
      columnValues('deadline', item({ deadline: { ...base, dueAt: null } }), TZ).map(csvCell),
    ).toEqual(['', 'Sem prazo']);
  });
});

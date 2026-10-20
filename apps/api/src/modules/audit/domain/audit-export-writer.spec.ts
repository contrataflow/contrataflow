import { describe, expect, it } from 'vitest';

import {
  AUDIT_EXPORT_COLUMNS,
  auditExportFileName,
  auditExportWriter,
  csvCell,
  escapeCsvFormula,
} from './audit-export-writer.js';
import { seal } from './audit-record.js';
import type { SealedAuditRecord } from './audit-record.js';

function sample(overrides: Partial<SealedAuditRecord> = {}): SealedAuditRecord {
  return {
    ...seal({
      id: '0192d075-0000-7000-8000-000000000001',
      occurredAt: new Date('2026-09-02T10:00:00.000Z'),
      tenantId: '0192d075-0000-7000-8000-00000000000a',
      actorType: 'USER',
      actorUserId: '0192d075-0000-7000-8000-0000000000a1',
      actorName: 'Ana "Souza", compras',
      actorMembershipId: null,
      onBehalfOfUserId: null,
      action: 'process.update',
      category: 'DATA_CHANGE',
      result: 'SUCCESS',
      entityType: 'Process',
      entityId: null,
      processId: null,
      changes: [{ path: 'title', old: 'A', new: '=HYPERLINK("x")' }],
      metadata: { processCode: '0012/2026' },
      reasonCode: null,
      ip: '10.0.0.1',
      userAgent: 'Mozilla/5.0\nquebra',
      correlationId: 'corr',
      requestId: null,
      sessionIdHash: null,
    }),
    ...overrides,
  };
}

describe('CsvInjectionEscaper (RN-AUD-20)', () => {
  it.each(['=', '+', '-', '@', '\t', '\r'])(
    'prefixa apóstrofo em valor iniciado por %j',
    (char) => {
      expect(escapeCsvFormula(`${char}SOMA(1;2)`)).toBe(`'${char}SOMA(1;2)`);
    },
  );

  it('não altera texto comum, vazio nem gatilho fora da primeira posição', () => {
    expect(escapeCsvFormula('Clara')).toBe('Clara');
    expect(escapeCsvFormula('')).toBe('');
    expect(escapeCsvFormula('a=b')).toBe('a=b');
    expect(escapeCsvFormula("'=já escapado")).toBe("'=já escapado");
  });

  it('célula RFC 4180: aspas duplicadas e campo entre aspas com vírgula, aspas ou quebra', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell('simples')).toBe('simples');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""');
    expect(csvCell('linha\nnova')).toBe('"linha\nnova"');
    // Escapa a fórmula e depois cita: o apóstrofo fica dentro da célula.
    expect(csvCell('\rcmd')).toBe(`"'\rcmd"`);
    expect(csvCell('=1+1,2')).toBe(`"'=1+1,2"`);
  });
});

describe('AuditExportWriter (AUD-03)', () => {
  it('CSV: BOM + cabeçalho com as colunas de AuditLog e linha CRLF com JSON e escapes', () => {
    const writer = auditExportWriter('csv');
    expect(writer.contentType).toBe('text/csv; charset=utf-8');
    expect(writer.header()).toBe(
      `${String.fromCharCode(0xfeff)}${AUDIT_EXPORT_COLUMNS.join(',')}\r\n`,
    );
    const line = writer.line(sample());
    expect(line.endsWith('\r\n')).toBe(true);
    expect(line).toContain('"Ana ""Souza"", compras"');
    expect(line).toContain(
      '"[{""path"":""title"",""old"":""A"",""new"":""=HYPERLINK(\\""x\\"")""}]"',
    );
    expect(line).toContain('"Mozilla/5.0\nquebra"');
    expect(
      line.startsWith('0192d075-0000-7000-8000-000000000001,2026-09-02T10:00:00.000Z,USER,'),
    ).toBe(true);
  });

  it('CSV: nomes congelados e códigos iniciados por gatilho saem escapados em toda coluna de texto', () => {
    const line = auditExportWriter('csv').line(
      sample({ actorName: '@admin', reasonCode: '-1', userAgent: '+x', metadata: {} }),
    );
    expect(line).toContain(",'@admin,");
    expect(line).toContain(",'-1,");
    expect(line).toContain(",'+x,");
  });

  it('NDJSON: um objeto JSON por linha, sem tenant e sem escapes de planilha', () => {
    const writer = auditExportWriter('ndjson');
    expect(writer.header()).toBe('');
    const line = writer.line(sample({ actorName: '=SOMA(1;2)' }));
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.actorName).toBe('=SOMA(1;2)');
    expect(parsed).not.toHaveProperty('tenantId');
    expect(Object.keys(parsed)).toEqual([...AUDIT_EXPORT_COLUMNS]);
  });

  it('nome do arquivo com o período em UTC e a extensão do formato', () => {
    expect(
      auditExportFileName(
        new Date('2026-09-01T00:00:00Z'),
        new Date('2026-09-07T23:59:59Z'),
        auditExportWriter('ndjson'),
      ),
    ).toBe('auditoria-20260901-20260907.ndjson');
  });
});

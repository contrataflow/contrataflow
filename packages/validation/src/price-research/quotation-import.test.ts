import { describe, expect, it } from 'vitest';

import {
  applyQuotationImportSchema,
  importTemplateFileName,
  isXlsxFileName,
  QUOTATION_IMPORT_MESSAGES,
} from './quotation-import.js';

/* US-028 — contratos da importação de cotações por planilha (PRS-18/19/24). */

describe('importação de cotações por planilha', () => {
  it('V-01: só .xlsx (sem diferenciar caixa)', () => {
    expect(isXlsxFileName('Cotações.XLSX')).toBe(true);
    expect(isXlsxFileName(' cotacoes.xlsx ')).toBe(true);
    expect(isXlsxFileName('cotacoes.xls')).toBe(false);
    expect(isXlsxFileName('cotacoes.xlsx.csv')).toBe(false);
  });

  it('nome do modelo a partir do código da pesquisa', () => {
    expect(importTemplateFileName('PP 0004/2026')).toBe('cotacoes-pp-0004-2026.xlsx');
    expect(importTemplateFileName('Pesquisa Ação/2026')).toBe('cotacoes-pesquisa-acao-2026.xlsx');
    expect(importTemplateFileName(null)).toBe('cotacoes-pesquisa.xlsx');
    expect(importTemplateFileName('///')).toBe('cotacoes-pesquisa.xlsx');
  });

  it('PRS-19: previewToken UUIDv7 obrigatório, sem campos extras', () => {
    const token = '0192d028-0000-7000-8000-000000000999';
    expect(applyQuotationImportSchema.parse({ previewToken: token })).toEqual({
      previewToken: token,
    });
    expect(applyQuotationImportSchema.safeParse({}).success).toBe(false);
    expect(applyQuotationImportSchema.safeParse({ previewToken: 'abc' }).success).toBe(false);
    expect(applyQuotationImportSchema.safeParse({ previewToken: token, extra: 1 }).success).toBe(
      false,
    );
  });

  it('mensagens por linha/célula (V-03..V-05)', () => {
    expect(QUOTATION_IMPORT_MESSAGES.itemNotFound(5)).toBe(
      'Linha 5: item não encontrado nesta pesquisa.',
    );
    expect(QUOTATION_IMPORT_MESSAGES.priceInvalid(5, 'Painel de Preços')).toBe(
      "Linha 5, fonte 'Painel de Preços': preço inválido.",
    );
  });
});

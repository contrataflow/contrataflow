import { describe, expect, it } from 'vitest';

import {
  ContextTooLargeError,
  PERSONAL_DATA_PLACEHOLDER,
  redactPersonalData,
  sanitizeContext,
} from './context-sanitizer.js';
import type { ContextPart } from './context-sanitizer.js';

const OPEN = { isBudgetConfidential: false, maxChars: 100_000 };

const part = (data: unknown, overrides: Partial<ContextPart> = {}): ContextPart => ({
  ref: { kind: 'PROCESS', id: 'p1' },
  label: 'Processo',
  data,
  ...overrides,
});

describe('ContextSanitizer — redação de texto livre (RN-AI-05 · tests.md §3.10)', () => {
  it.each([
    ['CPF com máscara', 'CPF 123.456.789-09 do servidor', 'CPF [dado pessoal omitido] do servidor'],
    ['CPF sem máscara', 'documento 12345678909.', 'documento [dado pessoal omitido].'],
    [
      'e-mail',
      'fale com ana.souza+compras@prefeitura.sp.gov.br hoje',
      'fale com [dado pessoal omitido] hoje',
    ],
    ['telefone com DDD', 'ligar (11) 98765-4321', 'ligar [dado pessoal omitido]'],
    ['telefone fixo', 'ramal 3333-4444', 'ramal [dado pessoal omitido]'],
    ['telefone internacional', '+55 11 91234-5678', '[dado pessoal omitido]'],
    ['CEP', 'Rua A, CEP 01310-100, centro', 'Rua A, [dado pessoal omitido], centro'],
    ['CEP sem prefixo', 'no 01310-100', 'no [dado pessoal omitido]'],
  ])('%s', (_name, input, expected) => {
    expect(redactPersonalData(input).text).toBe(expected);
  });

  it('não confunde quantidades, datas, valores nem CNPJ com dado pessoal', () => {
    for (const text of [
      '30 computadores em 2026',
      'prazo de 120 dias',
      'R$ 1.500,00 por unidade',
      'CNPJ 11.222.333/0001-81',
      'data 16/10/2026',
      'processo 0012/2026',
    ]) {
      expect(redactPersonalData(text)).toEqual({ text, count: 0 });
    }
  });
});

describe('ContextSanitizer — minimização das chaves e sigilo do orçamento', () => {
  it('exclui comentários, anexos, fornecedores, contatos e pessoas em qualquer profundidade', () => {
    const result = sanitizeContext(
      [
        part({
          objeto: 'Aquisição de notebooks',
          requestingDepartmentName: 'Secretaria de Educação',
          organizationName: 'Prefeitura de São José',
          comments: [{ text: 'interno' }],
          attachments: [{ fileName: 'orcamento.pdf' }],
          anexos: ['x'],
          suppliers: [{ name: 'Alfa Ltda' }],
          supplierName: 'Beta',
          fornecedorCnpj: '11222333000181',
          responsibleName: 'Marcos',
          createdById: 'u1',
          approverUserId: 'u2',
          contactEmail: 'a@b.com',
          telefone: '11 3333-4444',
          cpf: '12345678909',
          endereço: 'Rua X',
          itens: [
            { descricao: 'Notebook', quantidade: 30, authorName: 'Ana', acceptanceCriteria: 'ok' },
          ],
          totalItems: 3,
          isBudgetConfidential: false,
        }),
      ],
      OPEN,
    );
    expect(result.parts[0]?.data).toEqual({
      objeto: 'Aquisição de notebooks',
      requestingDepartmentName: 'Secretaria de Educação',
      organizationName: 'Prefeitura de São José',
      itens: [{ descricao: 'Notebook', quantidade: 30, acceptanceCriteria: 'ok' }],
      totalItems: 3,
      isBudgetConfidential: false,
    });
    expect(result.stats.removedKeys).toBe(14);
    expect(result.warnings).toEqual([]);
  });

  it('processo sigiloso: valores saem sempre, com o aviso; processo público mantém', () => {
    const data = {
      itens: [{ descricao: 'Notebook', valorUnitario: 4_321.5, unitPrice: 4_321.5 }],
      estimatedValue: 129_645,
      budgetSource: 'Fonte 1',
      custoTotal: 10,
      totalCount: 4,
      isBudgetConfidential: true,
      hasBudget: true,
    };
    const confidential = sanitizeContext([part(data)], { ...OPEN, isBudgetConfidential: true });
    expect(confidential.parts[0]?.data).toEqual({
      itens: [{ descricao: 'Notebook' }],
      totalCount: 4,
      isBudgetConfidential: true,
      hasBudget: true,
    });
    expect(confidential.warnings).toEqual([{ code: 'BUDGET_CONFIDENTIAL_VALUES_OMITTED' }]);
    expect(sanitizeContext([part(data)], OPEN).parts[0]?.data).toEqual(data);
  });

  it('redige strings dentro de listas e objetos e conta as redações; não-JSON vira null', () => {
    const result = sanitizeContext(
      [
        part({
          notas: ['ligar 3333-4444', 'ok'],
          extra: undefined,
          fn: () => 1,
          n: 2,
          b: true,
          z: null,
        }),
      ],
      OPEN,
    );
    expect(result.parts[0]?.data).toEqual({
      notas: [`ligar ${PERSONAL_DATA_PLACEHOLDER}`, 'ok'],
      extra: null,
      fn: null,
      n: 2,
      b: true,
      z: null,
    });
    expect(result.stats.redactions).toBe(1);
  });
});

describe('ContextSanitizer — tamanho, hashes e determinismo (FA-07)', () => {
  const big = 'x'.repeat(400);

  it('omite partes opcionais que não cabem, com CONTEXT_TRUNCATED', () => {
    const result = sanitizeContext(
      [
        part('obrigatória'),
        part(big, { optional: true, label: 'Opcional grande', ref: { kind: 'CATALOG', id: null } }),
        part('cabe', {
          optional: true,
          label: 'Opcional pequena',
          ref: { kind: 'RISKS', id: null },
        }),
      ],
      { ...OPEN, maxChars: 200 },
    );
    expect(result.parts.map((entry) => entry.label)).toEqual(['Processo', 'Opcional pequena']);
    expect(result.inputRefs.map((ref) => ref.kind)).toEqual(['PROCESS', 'RISKS']);
    expect(result.warnings).toEqual([{ code: 'CONTEXT_TRUNCATED', params: { omittedParts: '1' } }]);
    expect(result.stats.omittedParts).toBe(1);
  });

  it('obrigatório acima do teto → ContextTooLargeError', () => {
    expect(() => sanitizeContext([part(big)], { ...OPEN, maxChars: 100 })).toThrow(
      ContextTooLargeError,
    );
  });

  it('hashes SHA-256 por parte e do contexto, estáveis para a mesma entrada', () => {
    const first = sanitizeContext([part({ b: 1, a: 'x' })], OPEN);
    const second = sanitizeContext([part({ a: 'x', b: 1 })], OPEN);
    expect(first.contextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.contextHash).toBe(second.contextHash);
    expect(first.inputRefs[0]?.contentHash).toBe(second.inputRefs[0]?.contentHash);
    expect(sanitizeContext([part({ a: 'y', b: 1 })], OPEN).contextHash).not.toBe(first.contextHash);
  });
});

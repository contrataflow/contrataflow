import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  blocksToDoc,
  cleanText,
  convertStructuredOutput,
  countToConfirm,
  inlineNodes,
  placeholdersOf,
  plainTextLength,
  toConfirmCategoryOf,
} from './output-converter.js';
import { responseJsonSchema, structuredResponseSchema } from './structured-output.js';

const SECTIONS = [
  { sectionKey: 'NECESSIDADE', title: 'Descrição da necessidade', maxChars: 200 },
  { sectionKey: 'JUSTIFICATIVA', title: 'Justificativa', maxChars: 200 },
];

const paragraphs = (texts: Record<string, string>) => ({
  sections: Object.entries(texts).map(([sectionKey, text]) => ({
    sectionKey,
    blocks: [{ type: 'paragraph', text }],
  })),
});

describe('OutputConverter — texto em linha (RN-AI-07)', () => {
  it('negrito, itálico e marcações [a confirmar] viram nós TipTap permitidos', () => {
    expect(
      inlineNodes('Compra de **30** unidades em *regime* de [a confirmar: prazo] dias'),
    ).toEqual([
      { type: 'text', text: 'Compra de ' },
      { type: 'text', text: '30', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' unidades em ' },
      { type: 'text', text: 'regime', marks: [{ type: 'italic' }] },
      { type: 'text', text: ' de ' },
      { type: 'toConfirm', attrs: { label: 'prazo', category: 'DEADLINE', origin: 'AI' } },
      { type: 'text', text: ' dias' },
    ]);
    expect(inlineNodes('[A confirmar]')).toEqual([
      { type: 'toConfirm', attrs: { label: 'informação', category: 'OTHER', origin: 'AI' } },
    ]);
    expect(inlineNodes('linha 1\nlinha 2')).toEqual([
      { type: 'text', text: 'linha 1' },
      { type: 'hardBreak' },
      { type: 'text', text: 'linha 2' },
    ]);
  });

  it('remove HTML e caracteres de controle (a saída nunca leva marcação executável)', () => {
    expect(cleanText('<script>alert(1)</script>Texto <b>forte</b>\u0007')).toBe(
      'alert(1)Texto forte',
    );
    expect(cleanText('tab\tok')).toBe('tab\tok');
  });

  it('não remonta tags ao remover outras nem ao tirar caracteres de controle', () => {
    expect(cleanText('<<b>script>alert(1)<</b>/script>')).toBe('alert(1)');
    expect(cleanText('<scr<script>ipt>x')).toBe('ipt>x');
    expect(cleanText('<\u0001script>x')).toBe('x');
    expect(cleanText('</<i>b>texto')).toBe('texto');
    expect(cleanText('<a <b>c')).toBe('c');
    expect(cleanText('a < b e c > d; x<y sem fechar')).toBe('a < b e c > d; x<y sem fechar');
    expect(cleanText('<>texto<1>')).toBe('<>texto<1>');
  });

  it('entrada longa adversarial (tags aninhadas ou sem fechamento) roda em tempo linear', () => {
    const startedAt = performance.now();
    expect(cleanText(`${'<'.repeat(50_000)}a${'>a'.repeat(50_000)}`)).toBe('a');
    expect(cleanText('<a'.repeat(50_000))).toBe('<a'.repeat(50_000));
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it.each([
    ['valor estimado', 'VALUE'],
    ['percentual de reajuste', 'VALUE'],
    ['quantidade', 'QUANTITY'],
    ['prazo de entrega', 'DEADLINE'],
    ['data da assinatura', 'DATE'],
    ['decisão da equipe', 'DECISION'],
    ['dado do órgão', 'DATA'],
    ['informação', 'OTHER'],
  ])('categoria do toConfirm: %s → %s', (label, category) => {
    expect(toConfirmCategoryOf(label)).toBe(category);
  });
});

describe('OutputConverter — blocos', () => {
  it('títulos 3–4, listas e tabela simples', () => {
    const doc = blocksToDoc([
      { type: 'heading', level: 3, text: 'Objeto' },
      { type: 'heading', level: 4, text: '' },
      { type: 'bulletList', items: ['a', 'b'] },
      { type: 'orderedList', items: ['c'] },
      { type: 'table', header: ['Item', 'Qtd'], rows: [['Notebook', '[a confirmar]']] },
      { type: 'paragraph', text: '' },
    ]);
    expect(doc.content.map((node) => node.type)).toEqual([
      'heading',
      'bulletList',
      'orderedList',
      'table',
      'paragraph',
    ]);
    expect(doc.content[0]).toMatchObject({ attrs: { level: 3 } });
    expect(doc.content[3]?.content?.[0]?.content?.[0]?.type).toBe('tableHeader');
    expect(countToConfirm(doc)).toBe(1);
    expect(plainTextLength(doc)).toBeGreaterThan(0);
  });
});

describe('OutputConverter — validação da resposta', () => {
  it('converte a resposta válida (objeto ou JSON em texto) com as contagens', () => {
    const raw = paragraphs({ NECESSIDADE: 'A [a confirmar: quantidade]', JUSTIFICATIVA: 'B' });
    for (const input of [raw, JSON.stringify(raw)]) {
      const result = convertStructuredOutput(input, {
        sections: SECTIONS,
        warnings: [{ code: 'CONTEXT_TRUNCATED' }],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        result.output.sections.map((section) => [section.title, section.placeholdersCount]),
      ).toEqual([
        ['Descrição da necessidade', 1],
        ['Justificativa', 0],
      ]);
      expect(result.output.warnings).toEqual([{ code: 'CONTEXT_TRUNCATED' }]);
      expect(placeholdersOf(result.output)).toBe(1);
    }
  });

  it.each([
    ['texto que não é JSON', 'isto não é json', '(raiz): invalid_type'],
    ['fora do schema', { secoes: [] }, 'sections: invalid_type'],
    [
      'seção desconhecida',
      paragraphs({ NECESSIDADE: 'a', JUSTIFICATIVA: 'b', OUTRA: 'c' }),
      'sections.2.sectionKey: unknown_section',
    ],
    ['seção faltando', paragraphs({ NECESSIDADE: 'a' }), 'sections: missing_section'],
    [
      'seção repetida',
      {
        sections: [
          ...paragraphs({ NECESSIDADE: 'a', JUSTIFICATIVA: 'b' }).sections,
          { sectionKey: 'NECESSIDADE', blocks: [] },
        ],
      },
      'sections.2.sectionKey: duplicated_section',
    ],
    [
      'acima de maxChars',
      paragraphs({ NECESSIDADE: 'x'.repeat(201), JUSTIFICATIVA: 'b' }),
      'sections.0.blocks: too_long',
    ],
  ])('%s → inválida (só caminhos e códigos, nunca o texto)', (_name, raw, issue) => {
    const result = convertStructuredOutput(raw, { sections: SECTIONS });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContain(issue);
    expect(result.issues.join(' ')).not.toContain('xxxx');
  });

  it('aceita o schema do gerador (riscos — US-119) e entrega o JSON Schema ao provedor', () => {
    const withRisks = structuredResponseSchema.extend({
      risks: z.array(z.record(z.string(), z.unknown())).min(1),
    });
    const raw = {
      ...paragraphs({ NECESSIDADE: 'a', JUSTIFICATIVA: 'b' }),
      risks: [{ title: 'Atraso' }],
    };
    const risk = {
      proposalKey: 'R1',
      title: 'Atraso',
      description: '',
      categoryCode: 'PRAZO',
      phase: 'PLANNING' as const,
      cause: 'Causa do atraso na entrega.',
      consequence: 'Consequência do atraso na entrega.',
      probability: 2,
      impact: 2,
      rationale: '',
      treatments: [],
    };
    const refined = convertStructuredOutput(raw, {
      sections: SECTIONS,
      schema: withRisks,
      refineRisks: (risks) => {
        expect(risks).toEqual([{ title: 'Atraso' }]);
        return { ok: true, risks: [risk] };
      },
    });
    expect(refined.ok && refined.output.risks).toEqual([risk]);
    // Sem o refinador do mapa de riscos, a proposta não leva `risks`.
    const plain = convertStructuredOutput(raw, { sections: SECTIONS, schema: withRisks });
    expect(plain.ok && plain.output.risks).toBeUndefined();
    const refused = convertStructuredOutput(raw, {
      sections: SECTIONS,
      schema: withRisks,
      refineRisks: () => ({ ok: false, issues: ['risks.0.probability: out_of_scale'] }),
    });
    expect(refused).toEqual({ ok: false, issues: ['risks.0.probability: out_of_scale'] });
    expect(responseJsonSchema()).toMatchObject({ type: 'object', required: ['sections'] });
  });

  it('descarta seção não pedida quando o gerador pede (mapa de riscos sem documento)', () => {
    const raw = paragraphs({ NECESSIDADE: 'a', JUSTIFICATIVA: 'b', INTRODUCTION: 'c' });
    expect(convertStructuredOutput(raw, { sections: SECTIONS }).ok).toBe(false);
    const result = convertStructuredOutput(raw, {
      sections: SECTIONS,
      ignoreUnknownSections: true,
    });
    expect(result.ok && result.output.sections.map((section) => section.sectionKey)).toEqual([
      'NECESSIDADE',
      'JUSTIFICATIVA',
    ]);
  });
});

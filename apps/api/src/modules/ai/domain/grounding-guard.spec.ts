import type { AiGenerationOutput, AiOutputSection, RichTextNode } from '@contrataflow/validation';
import { countToConfirmNodes, richTextPlainText, richTextProblem } from '@contrataflow/validation';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sanitizeContext } from './context-sanitizer.js';
import { FactSet, findFacts, parseDigits, parseSpelled } from './fact-set.js';
import { GroundingGuard, groundSection } from './grounding-guard.js';
import { blocksToDoc } from './output-converter.js';
import { runPostProcessors } from './post-processing.js';

/*
 * US-122 — GroundingGuard (RN-AI-54): tabela de casos pt-BR, exceções (citação legal, numeração de
 * lista, ano), idempotência e a propriedade "nenhuma saída gravada tem número fora do conjunto de
 * fatos". Determinístico: sem provedor, sem rede.
 */

function section(text: string, extra: Partial<AiOutputSection> = {}): AiOutputSection {
  return {
    sectionKey: 'JUSTIFICATION',
    title: 'Justificativa',
    content: blocksToDoc([{ type: 'paragraph', text }]),
    placeholdersCount: 0,
    groundingReplacements: 0,
    ...extra,
  };
}

function nodesOf(grounded: AiOutputSection): RichTextNode[] {
  const doc = grounded.content as { content: RichTextNode[] };
  return doc.content.flatMap((block) => block.content ?? []);
}

const markers = (grounded: AiOutputSection) =>
  nodesOf(grounded)
    .filter((node) => node.type === 'toConfirm')
    .map((node) => `${String(node.attrs?.category)}:${String(node.attrs?.label)}`);

const textOf = (grounded: AiOutputSection) => richTextPlainText(grounded.content);

const NO_FACTS = FactSet.of({});

describe('FactNormalizer: números pt-BR', () => {
  it.each([
    ['1.234,56', 1234.56],
    ['1.200', 1200],
    ['1,5', 1.5],
    ['120', 120],
    ['80.000,00', 80000],
    ['1234.56', 1234.56],
    ['abc', null],
  ])('algarismos %s → %s', (raw, value) => {
    expect(parseDigits(raw)).toBe(value);
  });

  it.each([
    ['dez', 10],
    ['trinta e cinco', 35],
    ['cento e vinte', 120],
    ['mil e quinhentos', 1500],
    ['dez mil', 10_000],
    ['duzentas e uma', 201],
    ['zero', null],
  ])('extenso "%s" → %s', (raw, value) => {
    expect(parseSpelled(raw)).toBe(value);
  });
});

describe('GroundingGuard: trechos sem fato viram [a confirmar] (tabela)', () => {
  it.each([
    ['R$ 1.234,56', 'VALUE:valor'],
    ['R$ 80 mil', 'VALUE:valor'],
    ['dez mil reais', 'VALUE:valor'],
    ['10 (dez) unidades', 'QUANTITY:quantidade'],
    ['cento e vinte unidades', 'QUANTITY:quantidade'],
    ['1.200 kg', 'QUANTITY:quantidade'],
    ['30 dias', 'DEADLINE:prazo'],
    ['trinta dias corridos', 'DEADLINE:prazo'],
    ['12 meses', 'DEADLINE:prazo'],
    ['2 anos', 'DEADLINE:prazo'],
    ['15/03/2026', 'DATE:data'],
    ['15 de março de 2026', 'DATE:data'],
    ['2026-03-15', 'DATE:data'],
    ['5%', 'VALUE:valor'],
    ['5,5 por cento', 'VALUE:valor'],
  ])('"%s" sem entrada → %s', (fact, marker) => {
    const grounded = groundSection(section(`Texto com ${fact} no meio.`), NO_FACTS);
    expect(markers(grounded)).toEqual([marker]);
    expect(grounded.groundingReplacements).toBe(1);
    expect(textOf(grounded)).not.toContain(fact);
    expect(richTextProblem(grounded.content)).toBeNull();
  });

  it.each([
    ['R$ 1.234,56', { estimatedValue: 1234.56 }],
    ['R$ 80.000,00', { estimatedTotalValue: '80000.00' }],
    ['R$ 80 mil', { resumo: 'Orçamento de R$ 80.000,00' }],
    ['10 (dez) unidades', { items: [{ quantity: 10, unit: 'UN' }] }],
    ['dez unidades', { items: [{ quantity: 10 }] }],
    ['30 dias', { deliveryDeadlineDays: 30 }],
    ['1 mês', { resumo: 'entrega em 30 dias' }],
    ['12 meses', { vigenciaMeses: 12 }],
    ['15/03/2026', { neededBy: '2026-03-15' }],
    ['15 de março de 2026', { resumo: 'Precisamos até 15/03/2026.' }],
    ['5%', { adjustmentPercent: 5 }],
  ])('"%s" sustentado por %o permanece', (fact, data) => {
    const grounded = groundSection(section(`Texto com ${fact} no meio.`), FactSet.of(data));
    expect(markers(grounded)).toEqual([]);
    expect(grounded.groundingReplacements).toBe(0);
    expect(textOf(grounded)).toContain(fact);
  });

  it('exceções: citação legal, numeração de lista e ano das entradas ficam como estão', () => {
    const facts = FactSet.of({ exercicio: 2026 });
    for (const text of [
      'Conforme o art. 18, § 1º, inciso II, alínea a, da Lei nº 14.133/2021.',
      'Nos termos do artigo 75, inciso II, e do Decreto 10.024/2019.',
      '1. Objeto; 2. Justificativa; item 3 da lista.',
      'Planejamento para o exercício de 2026.',
    ]) {
      const grounded = groundSection(section(text), facts);
      expect(markers(grounded), text).toEqual([]);
      expect(textOf(grounded)).toBe(text);
    }
    expect(findFacts('art. 18, § 1º').map((match) => match.kind)).toEqual(['CITATION', 'CITATION']);
  });

  it('marcas de texto (negrito) são preservadas em volta da troca', () => {
    const grounded = groundSection(section('**Prazo de 90 dias** para entrega'), NO_FACTS);
    const [bold, marker, boldTail] = nodesOf(grounded);
    expect(bold).toEqual({ type: 'text', text: 'Prazo de ', marks: [{ type: 'bold' }] });
    expect(marker).toMatchObject({ type: 'toConfirm', attrs: { category: 'DEADLINE' } });
    expect(boldTail).toEqual({ type: 'text', text: ' para entrega' });
  });

  it('marcação literal "[a confirmar: …]" que sobrar no texto vira nó sem contar como troca', () => {
    const literal: AiOutputSection = {
      ...section(''),
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Responsável: [a confirmar: dado do órgão].' }],
          },
        ],
      },
    };
    const grounded = groundSection(literal, NO_FACTS);
    expect(markers(grounded)).toEqual(['DATA:dado do órgão']);
    expect(grounded.groundingReplacements).toBe(0);
  });
});

describe('Cenário do Gherkin: entradas com 120 unidades e o ano 2026, sem valor nem prazo', () => {
  it('troca "R$ 80.000,00" e "90 dias"; mantém "120 unidades" e "art. 18, § 1º"', () => {
    const context = sanitizeContext(
      [
        {
          ref: { kind: 'PROCESS_ITEMS', id: '0192f065-0000-7000-8000-0000000000b1' },
          label: 'Itens',
          data: { year: 2026, items: [{ description: 'Cadeira', quantity: 120, unit: 'UN' }] },
        },
      ],
      { isBudgetConfidential: false, maxChars: 10_000 },
    );
    const output: AiGenerationOutput = {
      sections: [
        section(
          'Estimativa de R$ 80.000,00 para 120 unidades, entrega em 90 dias, conforme o art. 18, § 1º.',
        ),
      ],
      warnings: [],
    };
    const result = runPostProcessors([new GroundingGuard()], output, context);
    const [grounded] = result.output.sections;
    if (grounded === undefined) throw new Error('sem seção');
    expect(markers(grounded)).toEqual(['VALUE:valor', 'DEADLINE:prazo']);
    expect(textOf(grounded)).toContain('120 unidades');
    expect(textOf(grounded)).toContain('art. 18, § 1º');
    expect(result).toMatchObject({ groundingReplacements: 2, placeholdersCount: 2 });
    expect(grounded).toMatchObject({ groundingReplacements: 2, placeholdersCount: 2 });
  });
});

describe('Idempotência e propriedade (RN-AI-54)', () => {
  const FACT_VALUES = [10, 120, 30, 2026];
  const facts = FactSet.of({ items: [{ quantity: 120 }], deliveryDays: 30, total: 10 });

  it('rodar o guard sobre a própria saída não troca nada', () => {
    const once = groundSection(
      section('R$ 5.000,00 por 120 unidades em 45 dias e 7% até 01/02/2027.'),
      facts,
    );
    const twice = groundSection({ ...once, groundingReplacements: 0 }, facts);
    expect(twice.content).toEqual(once.content);
    expect(twice.groundingReplacements).toBe(0);
    expect(once.groundingReplacements).toBe(4);
  });

  const fragment = fc.oneof(
    fc.integer({ min: 1, max: 99_999 }).map((value) => `R$ ${value.toLocaleString('pt-BR')},00`),
    fc.integer({ min: 1, max: 500 }).map((value) => `${String(value)} unidades`),
    fc.integer({ min: 1, max: 400 }).map((value) => `${String(value)} dias`),
    fc.integer({ min: 1, max: 48 }).map((value) => `${String(value)} meses`),
    fc.integer({ min: 1, max: 99 }).map((value) => `${String(value)}%`),
    fc
      .tuple(fc.integer({ min: 1, max: 28 }), fc.integer({ min: 1, max: 12 }))
      .map(
        ([day, month]) => `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/2026`,
      ),
    fc.constantFrom(...FACT_VALUES.map((value) => `${String(value)} unidades`)),
    fc.constantFrom('art. 18, § 1º', 'Lei nº 14.133/2021', 'o objeto', 'e', 'para a escola'),
  );

  it('nenhum valor, quantidade, prazo, data ou percentual sem fato sobrevive; o resto fica', () => {
    fc.assert(
      fc.property(fc.array(fragment, { minLength: 1, maxLength: 12 }), (parts) => {
        const grounded = groundSection(section(parts.join(' ')), facts);
        const remaining = nodesOf(grounded)
          .filter((node) => node.type === 'text')
          .flatMap((node) => findFacts(node.text ?? ''));
        for (const match of remaining) expect(facts.supports(match)).toBe(true);
        expect(richTextProblem(grounded.content)).toBeNull();
        expect(countToConfirmNodes(grounded.content as never)).toBe(grounded.groundingReplacements);
        const again = groundSection({ ...grounded, groundingReplacements: 0 }, facts);
        expect(again.groundingReplacements).toBe(0);
      }),
      { numRuns: 300, seed: 122 },
    );
  });
});

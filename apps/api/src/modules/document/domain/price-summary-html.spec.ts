import { DEFAULT_TEMPLATE_LAYOUT, PRICE_SUMMARY_COLLECTIONS } from '@contrataflow/validation';
import type { DocumentSnapshot, SectionDefinition } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { maskConfidentialSnapshot } from './confidential-snapshot.js';
import { brazilianDecimal, MASKED_LABEL, priceSummaryHtml } from './price-summary-html.js';
import { buildRenditionHtml } from './rendition-html.js';

/*
 * US-031 — seção computada `PRICE_SUMMARY` do PDF (RN-PRICE-55/56): a matriz itens × fontes, as
 * estatísticas e o total a partir das coleções `priceSummary*` do snapshot, com a POL-09 aplicada
 * pelo `maskConfidentialSnapshot`; texto sempre escapado; as coleções não se repetem nas tabelas
 * genéricas do fim do documento.
 */

const NOW = new Date('2026-10-17T13:00:00.000Z');

const COLLECTIONS: DocumentSnapshot['collections'] = {
  [PRICE_SUMMARY_COLLECTIONS.summary]: [
    {
      referenceDate: '2026-10-06',
      lastCalculatedAt: '2026-10-06T15:30:00.000Z',
      unitPriceDecimals: 2,
      totalEstimatedValue: '12345.60',
    },
  ],
  [PRICE_SUMMARY_COLLECTIONS.sources]: [
    {
      id: 's1',
      description: 'Orçamento <XYZ>',
      sourceTypeLabel: 'Pesquisa direta',
      supplierName: 'Construtora XYZ',
      quoteDate: '2026-09-30',
    },
    {
      id: 's2',
      description: 'Painel de Preços',
      sourceTypeLabel: 'Sítio eletrônico',
      supplierName: null,
      quoteDate: null,
    },
  ],
  [PRICE_SUMMARY_COLLECTIONS.items]: [
    {
      id: 'i1',
      sequence: 1,
      description: 'Cimento CP II 50 kg',
      unitLabel: 'SC',
      quantity: '1000.0000',
      effectiveMethod: 'MEDIAN',
      validQuotationsCount: 2,
      meanPrice: '1234.5000',
      medianPrice: '1234.5000',
      lowestPrice: '1000.0000',
      highestPrice: '1469.0000',
      stdDeviation: '331.6554',
      coefficientOfVariation: '26.8655',
      recommendedUnitPrice: '1234.50',
      totalPrice: '1234500.00',
      alerts: ['HIGH_CV', 'NOT_A_CODE'],
      cells: [
        { unitPrice: '1000.0000', status: 'VALID', outlierFlag: 'NONE', isExpired: true },
        { unitPrice: '1469.0000', status: 'EXCLUDED', outlierFlag: 'HIGH', isExpired: false },
      ],
    },
    {
      id: 'i2',
      sequence: 2,
      description: 'Areia',
      unitLabel: 'M3',
      quantity: '12.5000',
      effectiveMethod: null,
      validQuotationsCount: 0,
      meanPrice: null,
      medianPrice: null,
      lowestPrice: null,
      highestPrice: null,
      stdDeviation: null,
      coefficientOfVariation: null,
      recommendedUnitPrice: null,
      totalPrice: null,
      alerts: ['NO_VALID_QUOTES'],
      cells: [null, null],
    },
  ],
};

function snapshot(collections = COLLECTIONS): DocumentSnapshot {
  return {
    schemaVersion: 1,
    document: {
      id: '0192f031-0000-7000-8000-000000000001',
      code: 'PP 0001/2026',
      title: 'Pesquisa de preços',
      typeCode: 'PRICE_RESEARCH',
      kind: 'STRUCTURED',
      confidentiality: 'RESTRICTED',
      versionNumber: 1,
    },
    template: null,
    process: {
      id: '0192f031-0000-7000-8000-000000000002',
      code: '0012/2026',
      title: 'Materiais',
      object: 'Aquisição de materiais',
      organizationName: 'Prefeitura A',
      organizationCnpj: null,
      requestingSecretariatName: null,
      requestingDepartmentName: null,
      isBudgetConfidential: true,
    },
    header: {},
    sections: {
      METHODOLOGY: {
        state: 'FILLED',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Metodologia' }] }],
        },
        justification: null,
      },
    },
    collections,
    generatedAt: NOW.toISOString(),
  };
}

const SECTIONS = [
  { key: 'METHODOLOGY', title: 'Metodologia da pesquisa', order: 1, render: 'TEXT' },
  { key: 'PRICE_SUMMARY', title: 'Mapa comparativo de preços', order: 2, render: 'PRICE_SUMMARY' },
] as SectionDefinition[];

describe('brazilianDecimal', () => {
  it('agrupa milhar, usa vírgula e corta zeros além do mínimo de casas', () => {
    expect(brazilianDecimal('1234567.5000', 2)).toBe('1.234.567,50');
    expect(brazilianDecimal('331.6554', 2)).toBe('331,6554');
    expect(brazilianDecimal('100.0000', 0)).toBe('100');
    expect(brazilianDecimal('12.5000', 0)).toBe('12,5');
    expect(brazilianDecimal('-1000.10', 2)).toBe('-1.000,10');
    expect(brazilianDecimal('abc', 2)).toBe('abc');
  });
});

describe('priceSummaryHtml (RN-PRICE-55)', () => {
  it('legenda das fontes, matriz com selos, estatísticas, método, alertas e total', () => {
    const html = priceSummaryHtml(COLLECTIONS);
    expect(html).toContain('Data-base: 06/10/2026 · Calculado em 06/10/2026 15:30 UTC');
    expect(html).toContain('<td>F1</td><td>Orçamento &lt;XYZ&gt;</td>');
    expect(html).toContain(
      '<td>Painel de Preços</td><td>Sítio eletrônico</td><td>—</td><td>—</td>',
    );
    expect(html).toContain('<th>F1</th><th>F2</th>');
    expect(html).toContain('1.000,00<br><span class="cf-badge">Vencida</span>');
    expect(html).toContain(
      '<td class="cf-num cf-excluded">1.469,00<br><span class="cf-badge">Desconsiderada · Acima da mediana</span></td>',
    );
    expect(html).toContain('<td class="cf-num">1.000</td>');
    expect(html).toContain('<td class="cf-num">26,8655</td>');
    expect(html).toContain('<td>Mediana</td>');
    expect(html).toContain('<td class="cf-num">1.234.500,00</td>');
    // Código de alerta desconhecido não é impresso.
    expect(html).toContain('<td>Preços muito dispersos</td>');
    expect(html).toContain('<td>Sem cotações válidas</td>');
    expect(html).toContain('<strong>Valor total estimado:</strong> 12.345,60');
    expect(html).not.toContain('<XYZ>');
  });

  it('POL-09: valores mascarados pelo document saem como "Valor sigiloso"', () => {
    const masked = maskConfidentialSnapshot(snapshot());
    const html = priceSummaryHtml(masked.collections);
    expect(html).toContain(`${MASKED_LABEL}<br><span class="cf-badge">Vencida</span>`);
    expect(html).toContain(`<strong>Valor total estimado:</strong> ${MASKED_LABEL}`);
    for (const value of [
      '1.000,00',
      '1.469,00',
      '1.234,50',
      '26,8655',
      '1.234.500,00',
      '12.345,60',
    ]) {
      expect(html).not.toContain(value);
    }
  });

  it('sem fontes (FA-04) e sem itens', () => {
    const noSources = priceSummaryHtml({
      ...COLLECTIONS,
      [PRICE_SUMMARY_COLLECTIONS.sources]: [],
    });
    expect(noSources).toContain('Cadastre ao menos uma fonte para montar o mapa.');
    expect(noSources).not.toContain('<th>F1</th>');
    expect(priceSummaryHtml({})).toContain('A pesquisa não tem itens.');
  });
});

describe('buildRenditionHtml com a seção PRICE_SUMMARY', () => {
  it('renderiza o mapa na posição da seção e não repete as coleções no fim', () => {
    const { indexHtml } = buildRenditionHtml({
      kind: 'CONTENT',
      snapshot: snapshot(),
      template: { sections: SECTIONS, layout: DEFAULT_TEMPLATE_LAYOUT },
      contentHash: 'f'.repeat(64),
      tenantName: 'Prefeitura A',
      requesterName: 'Lúcia',
      now: NOW,
      timeZone: 'America/Sao_Paulo',
    });
    const methodology = indexHtml.indexOf('1. Metodologia da pesquisa');
    const map = indexHtml.indexOf('2. Mapa comparativo de preços');
    expect(methodology).toBeGreaterThan(-1);
    expect(map).toBeGreaterThan(methodology);
    expect(indexHtml.slice(map)).toContain('<th>F1</th>');
    expect(indexHtml).not.toContain('Seção não preenchida');
    // Sem as tabelas genéricas `cf-collection` das coleções priceSummary*.
    expect(indexHtml).not.toContain('cf-collection');
  });
});

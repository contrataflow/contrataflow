import { CATALOG_TYPES } from '@contrataflow/types';
import { catalogCodeSchema, catalogMetadataSchema } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { CATALOG_SEED, CATALOG_SEED_TOTAL } from './catalog-seed.js';

describe('catálogo-base da plataforma (entities.md §7)', () => {
  it('cobre os 8 catálogos e os 84 itens de sistema', () => {
    expect(Object.keys(CATALOG_SEED).sort()).toEqual([...CATALOG_TYPES].sort());
    expect(CATALOG_SEED_TOTAL).toBe(84);
    expect(CATALOG_SEED.CONTRACTING_TYPE).toHaveLength(11);
    expect(CATALOG_SEED.MODALITY).toHaveLength(7);
    expect(CATALOG_SEED.PROCESS_ORIGIN).toHaveLength(6);
    expect(CATALOG_SEED.UNIT_OF_MEASURE).toHaveLength(26);
    expect(CATALOG_SEED.RISK_CATEGORY).toHaveLength(10);
    expect(CATALOG_SEED.PRICE_SOURCE_TYPE).toHaveLength(8);
    expect(CATALOG_SEED.JUDGMENT_CRITERION).toHaveLength(6);
    expect(CATALOG_SEED.ATTACHMENT_CATEGORY).toHaveLength(10);
  });

  it.each(CATALOG_TYPES)('%s: códigos válidos, únicos e metadata no schema do tipo', (type) => {
    const codes = CATALOG_SEED[type].map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const entry of CATALOG_SEED[type]) {
      expect(catalogCodeSchema.safeParse(entry.code).success, entry.code).toBe(true);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeLessThanOrEqual(150);
      const parsed = catalogMetadataSchema(type).safeParse(entry.metadata);
      expect(parsed.success, `${type}/${entry.code}`).toBe(true);
    }
  });

  it('mantém os códigos estáveis usados por regras e integrações', () => {
    const codeOf = (type: (typeof CATALOG_TYPES)[number]) =>
      CATALOG_SEED[type].map((entry) => entry.code);
    expect(codeOf('MODALITY')).toEqual([
      'PREGAO',
      'CONCORRENCIA',
      'CONCURSO',
      'LEILAO',
      'DIALOGO_COMPETITIVO',
      'DISPENSA',
      'INEXIGIBILIDADE',
    ]);
    expect(codeOf('CONTRACTING_TYPE')).toContain('AQUISICAO_BENS');
    expect(
      CATALOG_SEED.MODALITY.filter((entry) => entry.metadata.isDirectContracting === true),
    ).toHaveLength(2);
  });
});

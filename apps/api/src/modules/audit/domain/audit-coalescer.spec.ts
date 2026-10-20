import { describe, expect, it } from 'vitest';

import { coalesceStateFrom, shouldCoalesce, sizeVariationPct } from './audit-coalescer.js';

const POLICY = { maxRevisionGap: 20, maxSizeVariationPct: 30 };

describe('coalescência de autosave (RN-AUD-06 · FA-05)', () => {
  it('sem registro na janela: grava', () => {
    expect(shouldCoalesce(null, { revision: 1, size: 100 }, POLICY)).toBe(false);
  });

  it('dentro dos limites de revisão e de tamanho: descarta', () => {
    expect(
      shouldCoalesce({ revision: 10, size: 1_000 }, { revision: 30, size: 1_300 }, POLICY),
    ).toBe(true);
    expect(shouldCoalesce({ revision: 10, size: 1_000 }, { revision: 11, size: 700 }, POLICY)).toBe(
      true,
    );
  });

  it('salto de revisão maior que maxRevisionGap reabre a janela', () => {
    expect(
      shouldCoalesce({ revision: 10, size: 1_000 }, { revision: 31, size: 1_000 }, POLICY),
    ).toBe(false);
    // Revisão que volta (nova versão) também conta como salto.
    expect(
      shouldCoalesce({ revision: 40, size: 1_000 }, { revision: 1, size: 1_000 }, POLICY),
    ).toBe(false);
  });

  it('variação de tamanho maior que maxSizeVariationPct reabre a janela', () => {
    expect(sizeVariationPct(1_000, 1_301)).toBeCloseTo(30.1);
    expect(
      shouldCoalesce({ revision: 10, size: 1_000 }, { revision: 11, size: 1_301 }, POLICY),
    ).toBe(false);
    expect(shouldCoalesce({ revision: 10, size: 0 }, { revision: 11, size: 2 }, POLICY)).toBe(
      false,
    );
  });

  it('lê o estado gravado em metadata.coalesce', () => {
    expect(coalesceStateFrom({ scope: 'X', revision: 3, size: 9 })).toEqual({
      revision: 3,
      size: 9,
    });
    expect(coalesceStateFrom({ revision: '3', size: 9 })).toBeNull();
    expect(coalesceStateFrom(null)).toBeNull();
    expect(coalesceStateFrom('x')).toBeNull();
  });
});

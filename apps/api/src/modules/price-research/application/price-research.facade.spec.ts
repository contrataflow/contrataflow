import { describe, expect, it } from 'vitest';

import { PriceResearchFacade } from './price-research.facade.js';

describe('PriceResearchFacade', () => {
  it('é instanciável', () => {
    expect(new PriceResearchFacade()).toBeInstanceOf(PriceResearchFacade);
  });
});

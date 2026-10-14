import { describe, expect, it } from 'vitest';

import { CatalogFacade } from './catalog.facade.js';

describe('CatalogFacade', () => {
  it('é instanciável', () => {
    expect(new CatalogFacade()).toBeInstanceOf(CatalogFacade);
  });
});

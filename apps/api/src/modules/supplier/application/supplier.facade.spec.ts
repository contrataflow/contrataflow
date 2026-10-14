import { describe, expect, it } from 'vitest';

import { SupplierFacade } from './supplier.facade.js';

describe('SupplierFacade', () => {
  it('é instanciável', () => {
    expect(new SupplierFacade()).toBeInstanceOf(SupplierFacade);
  });
});

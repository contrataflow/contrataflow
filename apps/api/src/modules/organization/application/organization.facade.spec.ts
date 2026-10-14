import { describe, expect, it } from 'vitest';

import { OrganizationFacade } from './organization.facade.js';

describe('OrganizationFacade', () => {
  it('é instanciável', () => {
    expect(new OrganizationFacade()).toBeInstanceOf(OrganizationFacade);
  });
});

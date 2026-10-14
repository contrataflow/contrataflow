import { describe, expect, it } from 'vitest';

import { DashboardFacade } from './dashboard.facade.js';

describe('DashboardFacade', () => {
  it('é instanciável', () => {
    expect(new DashboardFacade()).toBeInstanceOf(DashboardFacade);
  });
});

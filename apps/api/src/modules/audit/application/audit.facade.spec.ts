import { describe, expect, it } from 'vitest';

import { AuditFacade } from './audit.facade.js';

describe('AuditFacade', () => {
  it('é instanciável', () => {
    expect(new AuditFacade()).toBeInstanceOf(AuditFacade);
  });
});

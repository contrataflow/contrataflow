import { describe, expect, it } from 'vitest';

import { ApprovalFacade } from './approval.facade.js';

describe('ApprovalFacade', () => {
  it('é instanciável', () => {
    expect(new ApprovalFacade()).toBeInstanceOf(ApprovalFacade);
  });
});

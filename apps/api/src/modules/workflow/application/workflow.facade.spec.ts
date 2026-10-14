import { describe, expect, it } from 'vitest';

import { WorkflowFacade } from './workflow.facade.js';

describe('WorkflowFacade', () => {
  it('é instanciável', () => {
    expect(new WorkflowFacade()).toBeInstanceOf(WorkflowFacade);
  });
});

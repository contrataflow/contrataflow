import { describe, expect, it } from 'vitest';

import { InboxFacade } from './inbox.facade.js';

describe('InboxFacade', () => {
  it('é instanciável', () => {
    expect(new InboxFacade()).toBeInstanceOf(InboxFacade);
  });
});

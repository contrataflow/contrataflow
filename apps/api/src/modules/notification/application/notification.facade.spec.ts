import { describe, expect, it } from 'vitest';

import { NotificationFacade } from './notification.facade.js';

describe('NotificationFacade', () => {
  it('é instanciável', () => {
    expect(new NotificationFacade()).toBeInstanceOf(NotificationFacade);
  });
});

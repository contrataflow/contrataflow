import { getRequestConfig } from 'next-intl/server';

import { DEFAULT_TIME_ZONE, LOCALE, messages } from './messages';

// next-intl sem roteamento por locale: pt-BR fixo (architecture.md §8.10).
export default getRequestConfig(() =>
  Promise.resolve({ locale: LOCALE, messages, timeZone: DEFAULT_TIME_ZONE }),
);

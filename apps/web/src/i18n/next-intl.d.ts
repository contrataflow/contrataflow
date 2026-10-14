import type { LOCALE, Messages } from './messages';

declare module 'next-intl' {
  interface AppConfig {
    Locale: typeof LOCALE;
    Messages: Messages;
  }
}

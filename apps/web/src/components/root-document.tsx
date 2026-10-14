import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import { DEFAULT_TIME_ZONE, LOCALE, messages } from '@/i18n/messages';

import { ZodLocale } from './zod-locale';

/** Documento HTML em pt-BR com as mensagens do next-intl (locale único — RN-FND-95). */
export function RootDocument({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="bg-background font-sans text-foreground antialiased">
        <NextIntlClientProvider locale={LOCALE} messages={messages} timeZone={DEFAULT_TIME_ZONE}>
          <ZodLocale />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

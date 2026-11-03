import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import { inter } from '@/app/fonts/inter';
import { DEFAULT_TIME_ZONE, LOCALE, messages } from '@/i18n/messages';

import { ZodLocale } from './zod-locale';

/**
 * Documento HTML em pt-BR com as mensagens do next-intl (locale único — RN-FND-95). A classe da
 * Inter no `<html>` define `--font-inter`, usada pelo `--font-sans` do tema (prd-6 §2.1).
 */
export function RootDocument({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="pt-BR" className={inter.variable}>
      <body className="bg-background font-sans text-foreground antialiased">
        <NextIntlClientProvider locale={LOCALE} messages={messages} timeZone={DEFAULT_TIME_ZONE}>
          <ZodLocale />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

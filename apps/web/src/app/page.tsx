import { redirect } from 'next/navigation';

import { currentSessionOrUnavailable } from '@/bff/server-session';
import { HOME_PATH } from '@/lib/routes';

// A resposta depende do cookie de sessão: nunca é estática.
export const dynamic = 'force-dynamic';

/**
 * Raiz `/`: sem sessão leva à entrada (`/entrar`, SCR-001); com sessão ativa, ao destino padrão da
 * área autenticada. Sessão vencida ou vínculo encerrado também seguem para `HOME_PATH`, onde o
 * layout de `(app)` aplica o tratamento de cada caso. Redis de sessões fora do ar (`unavailable`)
 * cai em `/entrar`, que continua acessível (DEC-131).
 */
export default async function HomePage() {
  const lookup = await currentSessionOrUnavailable();
  redirect(lookup.status === 'none' || lookup.status === 'unavailable' ? '/entrar' : HOME_PATH);
}

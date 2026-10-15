import 'server-only';

import { HOME_PATH } from '@/lib/routes';

/** Destino padrão após o login quando `returnTo` é ausente ou recusado. */
export const DEFAULT_RETURN_TO = HOME_PATH;

/** Limite de `returnTo` (RN-IAM-03). */
export const RETURN_TO_MAX_LENGTH = 2048;

/** Decodificações sucessivas antes de desistir (`%25252f…` → `/`). */
const MAX_DECODE_ROUNDS = 5;

const ORIGIN_PROBE = 'http://cf.invalid';

function hasForbiddenCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // Controles C0/C1, DEL, barra invertida e separadores Unicode de linha/parágrafo.
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || char === '\\') return true;
    if (code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/** Todas as formas do valor após decodificação repetida; `null` se a codificação for inválida. */
function decodedForms(value: string): string[] | null {
  const forms = [value];
  let current = value;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return forms;
    forms.push(next);
    current = next;
  }
  // Ainda mudando depois de várias rodadas: suspeito.
  return null;
}

function isBlockedPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return (
    lower === '/api' ||
    lower.startsWith('/api/') ||
    lower === '/entrar' ||
    lower.startsWith('/entrar/')
  );
}

/**
 * RN-IAM-03 (anti *open redirect*): aceita só caminho relativo iniciado por uma única `/`, sem
 * `//`, `/\`, esquema, host ou caracteres de controle — verificado em cada forma da decodificação
 * repetida —, com até 2.048 caracteres, fora de `/api/` e `/entrar`, e cuja resolução contra a
 * origem da aplicação mantém a mesma origem. Recusado → `null` (o chamador usa `/painel`).
 */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || value.length > RETURN_TO_MAX_LENGTH) return null;
  const forms = decodedForms(value);
  if (!forms) return null;
  for (const candidate of forms) {
    if (!candidate.startsWith('/') || candidate.startsWith('//')) return null;
    if (hasForbiddenCharacter(candidate)) return null;
    const url = new URL(candidate, ORIGIN_PROBE);
    // `/a/..//evil.com` normaliza para `//evil.com` (protocol-relative): recusado.
    if (url.origin !== ORIGIN_PROBE || url.pathname.startsWith('//')) return null;
    if (isBlockedPath(url.pathname)) return null;
  }
  const url = new URL(value, ORIGIN_PROBE);
  if (url.pathname.startsWith('//')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

import 'server-only';

import { HOME_PATH } from '@/lib/routes';

/** Destino padrão após o login quando `returnTo` é ausente ou recusado. */
export const DEFAULT_RETURN_TO = HOME_PATH;

function hasControlOrBackslash(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || char === '\\') return true;
  }
  return false;
}

/**
 * Aceita só caminhos internos da aplicação (anti *open redirect*): começa com uma única `/`, sem
 * `//`, barra invertida, caracteres de controle, esquema ou rotas do BFF.
 */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || value.length > 2048) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  for (const candidate of [value, decoded]) {
    if (!candidate.startsWith('/') || candidate.startsWith('//')) return null;
    if (hasControlOrBackslash(candidate)) return null;
  }
  const url = new URL(value, 'http://cf.invalid');
  if (url.origin !== 'http://cf.invalid') return null;
  if (url.pathname.startsWith('/api/')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

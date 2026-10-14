import 'server-only';

/*
 * Cookies do BFF (DEC-131 · security.md §7): opacos, `HttpOnly`, `Secure`, `SameSite=Lax`,
 * `Path=/` e prefixo `__Host-` (impede *cookie tossing* por subdomínio). Navegadores aceitam
 * `Secure` em http://localhost (contexto seguro), então os atributos valem também em dev.
 */

/** Cookie de transação do login (`state` vinculado ao browser — login CSRF). */
export const LOGIN_TRANSACTION_COOKIE = '__Host-cf_auth_tx';
export const LOGIN_TRANSACTION_MAX_AGE_SECONDS = 600;

export function readCookie(headers: Headers, name: string): string | null {
  const raw = headers.get('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}

export function serializeCookie(name: string, value: string, maxAgeSeconds?: number): string {
  const attributes = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'];
  if (maxAgeSeconds !== undefined) attributes.push(`Max-Age=${maxAgeSeconds}`);
  return attributes.join('; ');
}

export function clearCookie(name: string): string {
  return serializeCookie(name, '', 0);
}

export interface LoginTransaction {
  readonly state: string;
  readonly returnTo: string;
  readonly stepUp: boolean;
}

export function encodeLoginTransaction(transaction: LoginTransaction): string {
  return Buffer.from(JSON.stringify(transaction), 'utf8').toString('base64url');
}

export function decodeLoginTransaction(value: string | null): LoginTransaction | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<LoginTransaction>;
    if (
      typeof parsed.state !== 'string' ||
      typeof parsed.returnTo !== 'string' ||
      typeof parsed.stepUp !== 'boolean'
    ) {
      return null;
    }
    return { state: parsed.state, returnTo: parsed.returnTo, stepUp: parsed.stepUp };
  } catch {
    return null;
  }
}

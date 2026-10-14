import 'server-only';

/*
 * Cookies do BFF (DEC-131 · security.md §7): opacos, `HttpOnly`, `Secure`, `SameSite=Lax`,
 * `Path=/` e prefixo `__Host-` (impede *cookie tossing* por subdomínio). Navegadores aceitam
 * `Secure` em http://localhost (contexto seguro), então os atributos valem também em dev. O
 * cookie de sessão não tem `Max-Age`: a expiração é controlada no servidor (RN-IAM-10).
 */

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

import 'server-only';

import { parseCidr } from '@/config/env';
import type { Ipv4Cidr } from '@/config/env';

/*
 * IP do cliente (security.md §8 · RN-FND-94): o ALB acrescenta o IP real ao fim de
 * `X-Forwarded-For`; o BFF percorre a lista da direita para a esquerda descartando apenas saltos
 * de proxies confiáveis (`TRUSTED_PROXY_CIDRS`). Valores anteriores, enviados pelo próprio
 * cliente, nunca são aceitos como identidade.
 */

function ipv4ToNumber(ip: string): number | null {
  const cidr = parseCidr(`${ip}/32`);
  return cidr ? cidr.network : null;
}

export function isInCidr(ip: string, cidr: Ipv4Cidr): boolean {
  const value = ipv4ToNumber(ip);
  if (value === null) return false;
  const size = 2 ** (32 - cidr.prefix);
  return Math.floor(value / size) === Math.floor(cidr.network / size);
}

export function isTrustedProxy(ip: string, trusted: readonly Ipv4Cidr[]): boolean {
  return trusted.some((cidr) => isInCidr(ip, cidr));
}

/** IP do cliente a partir de `X-Forwarded-For`; `null` se ausente ou ilegível. */
export function clientIpFrom(
  forwardedFor: string | null,
  trusted: readonly Ipv4Cidr[],
): string | null {
  if (!forwardedFor) return null;
  const hops = forwardedFor
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop !== '');
  for (const hop of hops.reverse()) {
    if (!isTrustedProxy(hop, trusted)) return ipv4ToNumber(hop) === null ? null : hop;
  }
  return null;
}

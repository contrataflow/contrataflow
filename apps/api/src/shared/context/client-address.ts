import { BlockList, isIP } from 'node:net';

/*
 * Endereço do cliente (security.md §8 · RN-AUD-05): o BFF repassa o IP real em `X-Forwarded-For`
 * e o hash da sessão em `X-CF-Session-Id-Hash`; a API só acredita nesses cabeçalhos quando a
 * conexão vem de um proxy confiável (`TRUSTED_PROXY_CIDRS`). Caso contrário vale o IP do socket.
 */

export const SESSION_HASH_HEADER = 'X-CF-Session-Id-Hash';

const SESSION_HASH = /^[0-9a-f]{64}$/;

/** Lista de CIDRs confiáveis (`10.0.0.0/8`, `::1`…) já validados pela configuração. */
export function trustedProxyList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address = '', prefix] = cidr.split('/');
    const type = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return list;
}

/**
 * Forma canônica do IP (a mesma que o PostgreSQL devolve de uma coluna `inet`, para o `rowHash`
 * continuar verificável): IPv4 mapeado em IPv6 (`::ffff:10.0.0.1`) vira IPv4; IPv6 sai minúsculo
 * e comprimido (RFC 5952). Valor que não é IP → `null`.
 */
export function normalizeIp(value: string | null | undefined): string | null {
  const candidate = (value ?? '').trim();
  const family = isIP(candidate);
  if (family === 4) return candidate;
  if (family !== 6) return null;
  let compressed: string;
  try {
    compressed = new URL(`http://[${candidate}]/`).hostname.slice(1, -1);
  } catch {
    return null; // ex.: identificador de zona (`fe80::1%eth0`), que `inet` não aceita
  }
  // IPv4 embutido: o URL o escreve em hexadecimal; o PostgreSQL, em decimal (inet_ntop).
  const words = ipv6Words(compressed);
  const dotted = () => {
    const high = words[6] ?? 0;
    const low = words[7] ?? 0;
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  };
  if (words.slice(0, 5).every((word) => word === 0)) {
    if (words[5] === 0xffff) return dotted();
    if (words[5] === 0 && words[6] !== 0) return `::${dotted()}`;
  }
  return compressed;
}

/** As 8 palavras de 16 bits de um IPv6 na forma comprimida, sem IPv4 embutido. */
function ipv6Words(compressed: string): number[] {
  const [head = '', tail] = compressed.split('::');
  const parse = (part: string) =>
    part === '' ? [] : part.split(':').map((word) => Number.parseInt(word, 16));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

function isTrusted(ip: string, trusted: BlockList): boolean {
  return trusted.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

export interface ClientAddress {
  readonly ip: string;
  readonly sessionIdHash?: string;
}

/**
 * IP do cliente e hash da sessão: de um proxy confiável, o último salto de `X-Forwarded-For` (o
 * que o BFF acrescentou) e o `X-CF-Session-Id-Hash`; de qualquer outra origem, só o socket.
 */
export function resolveClientAddress(
  socketIp: string | undefined,
  headers: {
    readonly forwardedFor: string | undefined;
    readonly sessionIdHash: string | undefined;
  },
  trusted: BlockList,
): ClientAddress {
  const peer = normalizeIp(socketIp);
  if (peer === null || !isTrusted(peer, trusted)) return { ip: peer ?? '' };
  const hops = (headers.forwardedFor ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  const forwarded = normalizeIp(hops.at(-1));
  const sessionIdHash = headers.sessionIdHash?.trim().toLowerCase();
  return {
    ip: forwarded ?? peer,
    ...(sessionIdHash && SESSION_HASH.test(sessionIdHash) ? { sessionIdHash } : {}),
  };
}

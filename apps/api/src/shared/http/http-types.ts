import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Subconjunto da requisição do Express usado pelo pipeline (evita depender de `@types/express`).
 * `body` é preenchido pelo `JsonBodyMiddleware`.
 */
export interface HttpRequest extends IncomingMessage {
  body?: unknown;
  readonly ip?: string;
  readonly originalUrl: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly route?: { readonly path: string };
}

export type HttpResponse = ServerResponse;

/** Caminho sem query string (a query pode conter termos de busca; não vai para logs). */
export function requestPath(request: Pick<HttpRequest, 'originalUrl'>): string {
  const raw = request.originalUrl;
  const index = raw.indexOf('?');
  return index === -1 ? raw : raw.slice(0, index);
}

/** Primeiro valor de um cabeçalho (Node junta repetidos em array só para alguns nomes). */
export function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

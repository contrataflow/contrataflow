import 'server-only';

import { CORRELATION_HEADER } from './correlation';
import { applyApiSecurityHeaders } from './security-headers';

/*
 * Respostas do BFF: problem+json (RFC 9457 · api.md §2) com os mesmos `type`/`code` da API e os
 * cabeçalhos de segurança aplicados também nas respostas de erro (RN-FND-94).
 */

interface ProblemSpec {
  readonly status: number;
  readonly title: string;
  readonly detail: string;
}

/** Erros que o próprio BFF produz (mensagens pt-BR, sem detalhe técnico). */
export const BFF_PROBLEMS = {
  UNAUTHENTICATED: { status: 401, title: 'Não autenticado', detail: 'Entre para continuar.' },
  SESSION_EXPIRED: {
    status: 401,
    title: 'Sessão expirada',
    detail: 'Sua sessão expirou. Entre novamente.',
  },
  CSRF_REJECTED: {
    status: 403,
    title: 'Origem não confirmada',
    detail: 'Não foi possível confirmar a origem da solicitação.',
  },
  MEMBERSHIP_INACTIVE: {
    status: 403,
    title: 'Vínculo inativo',
    detail: 'Seu acesso a este órgão não está ativo.',
  },
  TENANT_SUSPENDED: {
    status: 403,
    title: 'Instituição indisponível',
    detail: 'Esta instituição está temporariamente indisponível.',
  },
  PERMISSION_DENIED: {
    status: 403,
    title: 'Acesso bloqueado',
    detail: 'Seu acesso ao ContrataFlow está bloqueado.',
  },
  NOT_FOUND: {
    status: 404,
    title: 'Não encontrado',
    detail: 'Página não encontrada ou sem acesso.',
  },
  METHOD_NOT_ALLOWED: {
    status: 405,
    title: 'Método não permitido',
    detail: 'Método não suportado nesta rota.',
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    title: 'Corpo muito grande',
    detail: 'O corpo da requisição excede o limite permitido.',
  },
  MALFORMED_REQUEST: {
    status: 400,
    title: 'Requisição malformada',
    detail: 'Não foi possível interpretar a requisição.',
  },
  RATE_LIMITED: {
    status: 429,
    title: 'Muitas tentativas',
    detail: 'Muitas tentativas. Aguarde alguns instantes.',
  },
  DEPENDENCY_UNAVAILABLE: {
    status: 503,
    title: 'Serviço indisponível',
    detail: 'O serviço está temporariamente indisponível. Tente novamente.',
  },
  INTERNAL_ERROR: {
    status: 500,
    title: 'Erro interno',
    detail: 'Ocorreu um erro inesperado.',
  },
} as const satisfies Record<string, ProblemSpec>;

export type BffProblemCode = keyof typeof BFF_PROBLEMS;

export function problemType(code: string): string {
  return `https://docs.contrataflow.com.br/errors/${code.toLowerCase().replaceAll('_', '-')}`;
}

export function problemResponse(
  code: BffProblemCode,
  context: {
    readonly correlationId: string;
    readonly instance: string;
    readonly headers?: HeadersInit;
  },
): Response {
  const spec = BFF_PROBLEMS[code];
  const headers = new Headers(context.headers);
  headers.set('Content-Type', 'application/problem+json');
  headers.set(CORRELATION_HEADER, context.correlationId);
  applyApiSecurityHeaders(headers);
  return new Response(
    JSON.stringify({
      type: problemType(code),
      title: spec.title,
      status: spec.status,
      detail: spec.detail,
      instance: context.instance,
      code,
      correlationId: context.correlationId,
      errors: [],
      violations: [],
    }),
    { status: spec.status, headers },
  );
}

export function jsonResponse(
  body: unknown,
  init: {
    readonly status?: number;
    readonly correlationId: string;
    readonly headers?: HeadersInit;
  },
): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  headers.set(CORRELATION_HEADER, init.correlationId);
  applyApiSecurityHeaders(headers);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

export function redirectResponse(
  location: string,
  init: { readonly correlationId: string; readonly headers?: HeadersInit },
): Response {
  const headers = new Headers(init.headers);
  headers.set('Location', location);
  headers.set(CORRELATION_HEADER, init.correlationId);
  applyApiSecurityHeaders(headers);
  return new Response(null, { status: 302, headers });
}

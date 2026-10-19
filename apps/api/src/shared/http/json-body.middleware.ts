import { Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';

import { headerValue } from './http-types.js';
import type { HttpRequest, HttpResponse } from './http-types.js';
import { acceptsMultipart } from './multipart.js';
import { ApiError } from '../errors/api-error.js';

/** Limite padrão do corpo (DEC-056 · architecture.md §6.3); seções de documento: 1 MB na rota. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json$/i;

/**
 * Leitura do corpo JSON dentro do pipeline do Nest (o body parser padrão do Express fica
 * desligado), para que JSON malformado (V-03), corpo grande e tipo de conteúdo errado passem pelo
 * filtro RFC 9457 com o contexto da requisição: 400 `MALFORMED_REQUEST`, 413
 * `PAYLOAD_TOO_LARGE` e 415 `UNSUPPORTED_MEDIA_TYPE`.
 */
@Injectable()
export class JsonBodyMiddleware implements NestMiddleware<HttpRequest, HttpResponse> {
  async use(request: HttpRequest, _response: HttpResponse, next: () => void): Promise<void> {
    // Upload multipart nas rotas que o aceitam (US-028): o controller lê o arquivo.
    if (acceptsMultipart(request)) {
      next();
      return;
    }
    request.body = await readJsonBody(request);
    next();
  }
}

/** Corpo JSON da requisição, ou `undefined` quando não há corpo. */
export async function readJsonBody(
  request: HttpRequest,
  maxBytes = MAX_BODY_BYTES,
): Promise<unknown> {
  const length = headerValue(request, 'content-length');
  const chunked = headerValue(request, 'transfer-encoding') !== undefined;
  if (!chunked && (length === undefined || Number(length) === 0)) return undefined;

  const [mediaType = '', ...parameters] = (headerValue(request, 'content-type') ?? '')
    .split(';')
    .map((part) => part.trim());
  const charset = parameters
    .find((parameter) => parameter.toLowerCase().startsWith('charset='))
    ?.slice('charset='.length)
    .replaceAll('"', '')
    .toLowerCase();
  if (!JSON_TYPE.test(mediaType) || (charset !== undefined && charset !== 'utf-8')) {
    await readRaw(request, 0);
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  }

  const raw = await readRaw(request, maxBytes);
  if (raw === undefined) throw new ApiError('PAYLOAD_TOO_LARGE');
  if (raw.length === 0) return undefined;

  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch (error) {
    throw new ApiError('MALFORMED_REQUEST', { cause: error });
  }
}

/**
 * Lê o corpo inteiro; acima do limite continua drenando sem guardar (`undefined`), para que a
 * resposta de erro chegue ao cliente sem a conexão ser derrubada no meio do envio.
 */
function readRaw(request: HttpRequest, maxBytes: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    request.once('end', () => {
      resolve(size > maxBytes ? undefined : Buffer.concat(chunks));
    });
    request.once('error', (error) => {
      reject(new ApiError('MALFORMED_REQUEST', { cause: error }));
    });
  });
}

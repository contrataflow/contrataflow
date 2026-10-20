import { headerValue, requestPath } from './http-types.js';
import type { HttpRequest } from './http-types.js';
import { ApiError, validationError } from '../errors/api-error.js';

/*
 * Corpo `multipart/form-data` com UM arquivo (US-028 · PRS-18). O `JsonBodyMiddleware` só deixa o
 * corpo multipart sem ler nas rotas desta lista (as demais continuam recusando com 415
 * `UNSUPPORTED_MEDIA_TYPE`); o controller lê o arquivo depois da autenticação, com o limite do
 * tenant (`uploads.maxFileSizeMb`): acima dele → 413 `FILE_TOO_LARGE` (o restante do corpo é
 * drenado sem guardar, para a resposta chegar ao cliente). O conteúdo nunca vai para logs.
 */

/** Rotas (método + caminho completo) que recebem `multipart/form-data`. */
const MULTIPART_ROUTES: readonly { readonly method: string; readonly path: RegExp }[] = [
  { method: 'POST', path: /^\/api\/v1\/price-research\/[^/]+\/import-preview\/?$/ },
];

const MULTIPART_TYPE = /^multipart\/form-data$/i;

/** O corpo desta requisição é multipart numa rota que o aceita (lido pelo controller). */
export function acceptsMultipart(request: HttpRequest): boolean {
  const mediaType = (headerValue(request, 'content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (!MULTIPART_TYPE.test(mediaType)) return false;
  const path = requestPath(request);
  return MULTIPART_ROUTES.some((route) => route.method === request.method && route.path.test(path));
}

export interface UploadedFile {
  readonly fileName: string;
  /** `Content-Type` declarado na parte (pode faltar ou ser genérico). */
  readonly contentType: string | null;
  readonly data: Buffer;
}

/** Folga para os cabeçalhos das partes e os outros campos do formulário. */
const ENVELOPE_BYTES = 64 * 1024;

/**
 * Lê o corpo multipart e devolve o arquivo do campo `field`: 413 `FILE_TOO_LARGE` acima de
 * `maxFileBytes`, 415 `UNSUPPORTED_MEDIA_TYPE` sem `multipart/form-data` com `boundary`, 422
 * `VALIDATION_ERROR` (`REQUIRED`) sem o campo, 400 `MALFORMED_REQUEST` com o corpo malformado.
 */
export async function readMultipartFile(
  request: HttpRequest,
  options: {
    readonly field: string;
    readonly maxFileBytes: number;
    readonly tooLarge: () => ApiError;
  },
): Promise<UploadedFile> {
  const contentType = headerValue(request, 'content-type') ?? '';
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const marker = boundary?.[1] ?? boundary?.[2];
  if (!MULTIPART_TYPE.test(contentType.split(';')[0]?.trim() ?? '') || marker === undefined) {
    await drain(request);
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  }
  const declared = Number(headerValue(request, 'content-length') ?? '0');
  if (declared > options.maxFileBytes + ENVELOPE_BYTES) {
    await drain(request);
    throw options.tooLarge();
  }
  const body = await readLimited(request, options.maxFileBytes + ENVELOPE_BYTES);
  if (body === null) throw options.tooLarge();

  const file = parseMultipart(body, marker).find((part) => part.name === options.field);
  if (file?.fileName === undefined || file.fileName === null) {
    throw validationError([
      { field: options.field, code: 'REQUIRED', message: 'Envie o arquivo.' },
    ]);
  }
  if (file.data.length > options.maxFileBytes) throw options.tooLarge();
  return { fileName: file.fileName, contentType: file.contentType, data: file.data };
}

/** Consome o restante do corpo sem guardar (a resposta de erro chega inteira ao cliente). */
export function drain(request: HttpRequest): Promise<void> {
  if (request.readableEnded || request.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    request.on('data', () => undefined);
    request.once('end', () => {
      resolve();
    });
    request.once('error', () => {
      resolve();
    });
  });
}

function readLimited(request: HttpRequest, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    request.once('end', () => {
      resolve(size > maxBytes ? null : Buffer.concat(chunks));
    });
    request.once('error', (error) => {
      reject(new ApiError('MALFORMED_REQUEST', { cause: error }));
    });
  });
}

interface Part {
  readonly name: string | null;
  readonly fileName: string | null;
  readonly contentType: string | null;
  readonly data: Buffer;
}

/** Partes do corpo (RFC 7578): delimitadas por `--boundary`, cabeçalhos até a linha vazia. */
export function parseMultipart(body: Buffer, boundary: string): Part[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let start = body.indexOf(delimiter);
  if (start === -1) throw new ApiError('MALFORMED_REQUEST');
  for (;;) {
    const afterDelimiter = start + delimiter.length;
    // `--boundary--` encerra o corpo.
    if (body.subarray(afterDelimiter, afterDelimiter + 2).toString('latin1') === '--') break;
    const headersStart = afterDelimiter + 2;
    const headersEnd = body.indexOf('\r\n\r\n', headersStart);
    if (headersEnd === -1) throw new ApiError('MALFORMED_REQUEST');
    const next = body.indexOf(Buffer.from(`\r\n--${boundary}`), headersEnd + 4);
    if (next === -1) throw new ApiError('MALFORMED_REQUEST');
    const headers = body.subarray(headersStart, headersEnd).toString('utf8');
    const disposition = /^content-disposition:\s*(.+)$/im.exec(headers)?.[1] ?? '';
    parts.push({
      name: dispositionParam(disposition, 'name'),
      fileName: fileNameOf(disposition),
      contentType: /^content-type:\s*(.+)$/im.exec(headers)?.[1]?.trim() ?? null,
      data: body.subarray(headersEnd + 4, next),
    });
    start = next + 2;
  }
  return parts;
}

function dispositionParam(disposition: string, key: string): string | null {
  const match = new RegExp(String.raw`(?:^|;)\s*${key}="([^"]*)"`, 'i').exec(disposition);
  return match?.[1] ?? null;
}

/** `filename*=UTF-8''…` (RFC 5987) tem precedência sobre `filename="…"`; só o nome, sem pastas. */
function fileNameOf(disposition: string): string | null {
  const extended = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  let name = dispositionParam(disposition, 'filename');
  if (extended !== undefined) {
    try {
      name = decodeURIComponent(extended.trim());
    } catch {
      // Mantém o `filename` simples.
    }
  }
  if (name === null) return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.trim();
}

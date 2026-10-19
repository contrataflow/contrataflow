import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { HttpRequest } from './http-types.js';
import { acceptsMultipart, parseMultipart, readMultipartFile } from './multipart.js';
import { ApiError } from '../errors/api-error.js';

/* Upload `multipart/form-data` de um arquivo (US-028 · PRS-18). */

const BOUNDARY = '----cf-boundary';

function body(parts: readonly { headers: string; data: string | Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n${part.headers}\r\n\r\n`));
    chunks.push(typeof part.data === 'string' ? Buffer.from(part.data) : part.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

function fakeRequest(
  payload: Buffer,
  headers: Record<string, string> = {},
  url = '/api/v1/price-research/0192d028-0000-7000-8000-000000000001/import-preview',
): HttpRequest {
  const stream = Readable.from([payload]) as unknown as HttpRequest;
  Object.assign(stream, {
    method: 'POST',
    originalUrl: url,
    headers: {
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      'content-length': String(payload.length),
      ...headers,
    },
  });
  return stream;
}

const tooLarge = () => new ApiError('FILE_TOO_LARGE');
const fileHeaders = (name = 'cotacoes.xlsx', type = 'application/octet-stream') =>
  `Content-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}`;

describe('acceptsMultipart', () => {
  it('só as rotas da lista, com POST e multipart', () => {
    expect(acceptsMultipart(fakeRequest(Buffer.alloc(0)))).toBe(true);
    expect(
      acceptsMultipart(fakeRequest(Buffer.alloc(0), { 'content-type': 'application/json' })),
    ).toBe(false);
    expect(
      acceptsMultipart(fakeRequest(Buffer.alloc(0), {}, '/api/v1/price-research/x/import')),
    ).toBe(false);
    const get = fakeRequest(Buffer.alloc(0));
    Object.assign(get, { method: 'GET' });
    expect(acceptsMultipart(get)).toBe(false);
  });
});

describe('parseMultipart', () => {
  it('separa as partes com nome, arquivo (sem pasta, RFC 5987) e tipo; binário intacto', () => {
    const binary = Buffer.from([0, 13, 10, 45, 45, 255]);
    const parts = parseMultipart(
      body([
        { headers: 'Content-Disposition: form-data; name="note"', data: 'oi' },
        {
          headers: `Content-Disposition: form-data; name="file"; filename="C:\\x\\a.xlsx"; filename*=UTF-8''cota%C3%A7%C3%B5es.xlsx\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
          data: binary,
        },
      ]),
      BOUNDARY,
    );
    expect(parts.map((part) => [part.name, part.fileName, part.contentType])).toEqual([
      ['note', null, null],
      [
        'file',
        'cotações.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ],
    ]);
    expect(parts[1]?.data.equals(binary)).toBe(true);
  });

  it('corpo malformado → 400 MALFORMED_REQUEST', () => {
    expect(() => parseMultipart(Buffer.from('nada'), BOUNDARY)).toThrow(
      expect.objectContaining({ code: 'MALFORMED_REQUEST' }),
    );
    expect(() => parseMultipart(Buffer.from(`--${BOUNDARY}\r\nsem fim`), BOUNDARY)).toThrow(
      expect.objectContaining({ code: 'MALFORMED_REQUEST' }),
    );
  });
});

describe('readMultipartFile', () => {
  it('devolve o arquivo do campo', async () => {
    const file = await readMultipartFile(
      fakeRequest(body([{ headers: fileHeaders('pasta/a.xlsx'), data: 'conteudo' }])),
      { field: 'file', maxFileBytes: 100, tooLarge },
    );
    expect(file).toMatchObject({ fileName: 'a.xlsx', contentType: 'application/octet-stream' });
    expect(file.data.toString()).toBe('conteudo');
  });

  it('acima do limite → FILE_TOO_LARGE (pelo Content-Length, pelo corpo ou pelo arquivo)', async () => {
    const big = body([{ headers: fileHeaders(), data: 'x'.repeat(200) }]);
    await expect(
      readMultipartFile(fakeRequest(big), { field: 'file', maxFileBytes: 100, tooLarge }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    const huge = body([{ headers: fileHeaders(), data: 'x'.repeat(70 * 1024) }]);
    await expect(
      readMultipartFile(fakeRequest(huge, { 'content-length': '10' }), {
        field: 'file',
        maxFileBytes: 1,
        tooLarge,
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(
      readMultipartFile(fakeRequest(huge), { field: 'file', maxFileBytes: 1, tooLarge }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('sem o campo → 422 REQUIRED; sem boundary → 415', async () => {
    await expect(
      readMultipartFile(
        fakeRequest(body([{ headers: 'Content-Disposition: form-data; name="x"', data: '1' }])),
        { field: 'file', maxFileBytes: 100, tooLarge },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      errors: [{ field: 'file', code: 'REQUIRED' }],
    });
    await expect(
      readMultipartFile(fakeRequest(Buffer.from('x'), { 'content-type': 'multipart/form-data' }), {
        field: 'file',
        maxFileBytes: 100,
        tooLarge,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });
});

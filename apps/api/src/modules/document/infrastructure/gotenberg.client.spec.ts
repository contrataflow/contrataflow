import { DEFAULT_TEMPLATE_LAYOUT } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { GotenbergClient, UnconfiguredPdfRenderer } from './gotenberg.client.js';
import {
  PdfRendererRejectedError,
  PdfRendererUnavailableError,
} from '../application/rendition.ports.js';
import type { PdfRenderRequest } from '../application/rendition.ports.js';

const request: PdfRenderRequest = {
  indexHtml: '<html>corpo</html>',
  headerHtml: null,
  footerHtml: '<html>rodapé</html>',
  layout: DEFAULT_TEMPLATE_LAYOUT,
};

function client(respond: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const instance = new GotenbergClient(
    { gotenbergUrl: 'http://gotenberg:3000/', timeoutMs: 5_000 },
    (url, init) => {
      calls.push({ url, init });
      return respond();
    },
  );
  return { instance, calls };
}

describe('GotenbergClient (ADR-007 · RN-DOC-66)', () => {
  it('envia index/footer em multipart para a rota Chromium com as medidas do layout', async () => {
    const pdf = Buffer.from('%PDF-1.7');
    const { instance, calls } = client(() => Promise.resolve(new Response(pdf)));
    const result = await instance.render({
      ...request,
      headerHtml: '<html>topo</html>',
      layout: { ...DEFAULT_TEMPLATE_LAYOUT, orientation: 'landscape' },
    });
    expect(result.equals(pdf)).toBe(true);
    expect(calls[0]?.url).toBe('http://gotenberg:3000/forms/chromium/convert/html');
    const form = calls[0]?.init.body as FormData;
    const names = form.getAll('files').map((file) => (file as File).name);
    expect(names).toEqual(['index.html', 'footer.html', 'header.html']);
    expect(form.get('landscape')).toBe('true');
    expect(form.get('marginBottom')).toBe('20mm');
    expect(form.get('marginLeft')).toBe('20mm');
    expect(form.get('paperWidth')).toBe('8.27');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('5xx/429 e falha de conexão → indisponível (transitório)', async () => {
    for (const status of [503, 500, 429]) {
      const { instance } = client(() => Promise.resolve(new Response('x', { status })));
      await expect(instance.render(request)).rejects.toBeInstanceOf(PdfRendererUnavailableError);
    }
    const { instance } = client(() => Promise.reject(new TypeError('fetch failed')));
    await expect(instance.render(request)).rejects.toBeInstanceOf(PdfRendererUnavailableError);
  });

  it('4xx de entrada → recusado (permanente)', async () => {
    const { instance } = client(() => Promise.resolve(new Response('bad', { status: 400 })));
    await expect(instance.render(request)).rejects.toBeInstanceOf(PdfRendererRejectedError);
  });

  it('sem GOTENBERG_URL: sempre indisponível', async () => {
    await expect(new UnconfiguredPdfRenderer().render()).rejects.toBeInstanceOf(
      PdfRendererUnavailableError,
    );
  });
});

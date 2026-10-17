import { jobQueueOf } from './ai-fixtures.js';
import type { TestApi } from './api-test-app.js';
import { RenderDocumentJob } from '../../src/modules/document/application/render-document.job.js';
import {
  DOCUMENT_RENDITION_REPOSITORY,
  PdfRendererRejectedError,
  PdfRendererUnavailableError,
} from '../../src/modules/document/application/rendition.ports.js';
import type {
  PdfRendererPort,
  PdfRenderRequest,
} from '../../src/modules/document/application/rendition.ports.js';
import type { InMemoryDocumentRenditionRepository } from '../../src/modules/document/infrastructure/in-memory-document-rendition.repository.js';

/*
 * Dublês da renderização em PDF (US-067): um PDF mínimo com N páginas, o conversor falso (grava o
 * HTML recebido para as asserções e simula Gotenberg fora/recusando) e a execução do job como o
 * worker faria — o job enfileirado com o `meta` do pedido, na tentativa informada.
 */

/** PDF mínimo com N páginas (o suficiente para a contagem — nunca para um leitor). */
export function fakePdf(pages: number, marker = ''): Buffer {
  const kids = Array.from({ length: pages }, (_, index) => `${String(index + 3)} 0 R`).join(' ');
  const objects = Array.from(
    { length: pages },
    (_, index) => `${String(index + 3)} 0 obj << /Type /Page /Parent 2 0 R >> endobj`,
  ).join('\n');
  return Buffer.from(
    `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
      `2 0 obj << /Type /Pages /Kids [${kids}] /Count ${String(pages)} >> endobj\n` +
      `${objects}\n%${marker}\n%%EOF`,
    'latin1',
  );
}

export class FakePdfRenderer implements PdfRendererPort {
  readonly engine = 'fake';
  readonly requests: PdfRenderRequest[] = [];
  /** `unavailable` = 503/conexão; `rejected` = 4xx; `invalid` = bytes que não são PDF. */
  failing: 'unavailable' | 'rejected' | 'invalid' | null = null;
  pages = 2;

  render(request: PdfRenderRequest): Promise<Buffer> {
    this.requests.push(request);
    if (this.failing === 'unavailable') {
      return Promise.reject(new PdfRendererUnavailableError(503));
    }
    if (this.failing === 'rejected') return Promise.reject(new PdfRendererRejectedError(400));
    if (this.failing === 'invalid') return Promise.resolve(Buffer.from('<html>erro</html>'));
    return Promise.resolve(fakePdf(this.pages, String(this.requests.length)));
  }

  /** Último HTML do corpo recebido. */
  lastHtml(): string {
    return this.requests.at(-1)?.indexHtml ?? '';
  }
}

export function renditionRepositoryOf(api: TestApi): InMemoryDocumentRenditionRepository {
  return api.app.get(DOCUMENT_RENDITION_REPOSITORY, { strict: false });
}

/** Executa o `document-render` como o worker: o job enfileirado (meta do pedido) na tentativa. */
export function runRender(api: TestApi, renditionId: string, attempt = 1) {
  const job = jobQueueOf(api).find('document-render', renditionId);
  if (job === undefined) throw new Error(`document-render de ${renditionId} não enfileirado`);
  return api.app.get(RenderDocumentJob).process({
    id: job.jobId,
    queue: job.queue,
    name: job.name,
    attempt,
    data: job.data,
  });
}

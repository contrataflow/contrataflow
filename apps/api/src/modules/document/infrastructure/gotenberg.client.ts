import {
  PdfRendererRejectedError,
  PdfRendererUnavailableError,
} from '../application/rendition.ports.js';
import type { PdfRendererPort, PdfRenderRequest } from '../application/rendition.ports.js';
import { classifyRendererStatus } from '../domain/document-rendition.js';

/*
 * Cliente do Gotenberg (US-067 · ADR-007 · DEC-060): rota Chromium `forms/chromium/convert/html`,
 * multipart com `index.html` + `header.html`/`footer.html` (repetidos em cada página) e as medidas
 * do `LayoutDefinition`. O Gotenberg não tem credenciais de storage: tudo vai embutido na
 * requisição (storage.md §10). Conexão, timeout e 5xx/429 → indisponível (transitório, alimenta o
 * disjuntor); outro 4xx → recusado (permanente). Nunca loga o HTML.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GotenbergConfig {
  readonly gotenbergUrl: string;
  readonly timeoutMs: number;
}

/** A4 em polegadas (Chromium). */
const A4 = { width: 8.27, height: 11.69 } as const;
/** Espaço mínimo para o rodapé (hash + paginação) e para o cabeçalho, em mm. */
const MIN_FOOTER_MM = 18;
const MIN_HEADER_MM = 15;

function millimeters(value: number): string {
  return `${String(Math.round(value * 10) / 10)}mm`;
}

export class GotenbergClient implements PdfRendererPort {
  readonly engine = 'gotenberg';

  constructor(
    private readonly config: GotenbergConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async render(request: PdfRenderRequest): Promise<Buffer> {
    const { layout } = request;
    const form = new FormData();
    form.append('files', new Blob([request.indexHtml], { type: 'text/html' }), 'index.html');
    form.append('files', new Blob([request.footerHtml], { type: 'text/html' }), 'footer.html');
    if (request.headerHtml !== null) {
      form.append('files', new Blob([request.headerHtml], { type: 'text/html' }), 'header.html');
    }
    const landscape = layout.orientation === 'landscape';
    form.append('paperWidth', String(A4.width));
    form.append('paperHeight', String(A4.height));
    form.append('landscape', String(landscape));
    form.append(
      'marginTop',
      millimeters(
        request.headerHtml === null
          ? layout.marginsMm.top
          : Math.max(layout.marginsMm.top, MIN_HEADER_MM),
      ),
    );
    form.append('marginBottom', millimeters(Math.max(layout.marginsMm.bottom, MIN_FOOTER_MM)));
    form.append('marginLeft', millimeters(layout.marginsMm.left));
    form.append('marginRight', millimeters(layout.marginsMm.right));
    form.append('printBackground', 'true');
    form.append('preferCssPageSize', 'false');

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.config.gotenbergUrl.replace(/\/+$/, '')}/forms/chromium/convert/html`,
        { method: 'POST', body: form, signal: AbortSignal.timeout(this.config.timeoutMs) },
      );
    } catch (error) {
      throw new PdfRendererUnavailableError(null, { cause: error });
    }
    if (!response.ok) {
      // Descarta o corpo (mensagem do Gotenberg pode ecoar parte do HTML).
      await response.body?.cancel().catch(() => undefined);
      if (classifyRendererStatus(response.status) === 'TRANSIENT') {
        throw new PdfRendererUnavailableError(response.status);
      }
      throw new PdfRendererRejectedError(response.status);
    }
    try {
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new PdfRendererUnavailableError(null, { cause: error });
    }
  }
}

/** Sem `GOTENBERG_URL`: renderização adiada (o job pausa sem consumir tentativa). */
export class UnconfiguredPdfRenderer implements PdfRendererPort {
  readonly engine = 'gotenberg';

  render(): Promise<Buffer> {
    return Promise.reject(new PdfRendererUnavailableError(null));
  }
}

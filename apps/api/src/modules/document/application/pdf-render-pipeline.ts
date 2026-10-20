import { Inject, Injectable } from '@nestjs/common';

import { PdfRendererCircuit } from './pdf-renderer-circuit.js';
import { PDF_RENDERER, PdfRendererUnavailableError } from './rendition.ports.js';
import type { PdfRendererPort } from './rendition.ports.js';
import { inspectPdf } from '../domain/pdf-inspection.js';
import type { PdfFacts } from '../domain/pdf-inspection.js';
import type { RenditionHtml } from '../domain/rendition-html.js';

/*
 * HTML → PDF pelo conversor (US-067 · ADR-007), compartilhado pelo `document-render` dos documentos
 * e pela prévia do template (US-109 · RN-TPL-25): o disjuntor do Gotenberg (aberto → nem chama),
 * a conversão e a conferência dos bytes (SHA-256, tamanho e páginas). Quem chama classifica as
 * falhas e decide onde gravar o PDF.
 */

/** Disjuntor aberto (ou meia-abertura ocupada): a dependência está fora, nada foi enviado. */
export class RendererCircuitOpenError extends Error {
  constructor() {
    super('Conversor de PDF indisponível (disjuntor aberto).');
    this.name = 'RendererCircuitOpenError';
  }
}

export interface ConvertedPdf {
  readonly bytes: Buffer;
  /** `null` = os bytes não são um PDF utilizável (`INVALID_PDF`). */
  readonly facts: PdfFacts | null;
}

@Injectable()
export class PdfRenderPipeline {
  constructor(
    @Inject(PDF_RENDERER) private readonly renderer: PdfRendererPort,
    readonly circuit: PdfRendererCircuit,
  ) {}

  /**
   * @throws RendererCircuitOpenError
   * @throws PdfRendererUnavailableError (alimenta o disjuntor) / PdfRendererRejectedError
   */
  async convert(html: RenditionHtml): Promise<ConvertedPdf> {
    if (!this.circuit.tryAcquire()) throw new RendererCircuitOpenError();
    let bytes: Buffer;
    try {
      bytes = await this.renderer.render({
        indexHtml: html.indexHtml,
        headerHtml: html.headerHtml,
        footerHtml: html.footerHtml,
        layout: html.layout,
      });
      this.circuit.recordSuccess();
    } catch (error) {
      if (error instanceof PdfRendererUnavailableError) this.circuit.recordFailure();
      else this.circuit.recordSuccess();
      throw error;
    }
    return { bytes, facts: inspectPdf(bytes) };
  }
}

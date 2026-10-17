import { TEMPLATE_LOGO_MIME_TYPES } from '@contrataflow/validation';
import type { LayoutDefinition } from '@contrataflow/validation';
import { Injectable, Logger } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { AttachmentFileRegistry } from '#shared/files/attachment-files.js';
import type { AttachmentFile } from '#shared/files/attachment-files.js';

import {
  templateLogoNotAvailable,
  templateLogoNotFound,
  templateLogoNotImage,
} from './template.errors.js';
import type { RenditionLogo } from '../domain/rendition-html.js';

/*
 * Logo do layout de impressão (US-109 · RN-TPL-23): anexo `TENANT_ASSET` do próprio tenant,
 * `AVAILABLE`, imagem PNG/JPEG/SVG. O PATCH confere a referência (outro tenant = inexistente — a
 * resposta não revela que o anexo existe fora, V-05); a renderização lê os bytes pela porta
 * `AttachmentFileRegistry` (o `files` é o dono) e os embute no cabeçalho como `data:` URI — o
 * Gotenberg não acessa o storage. Logo que deixou de estar disponível sai do PDF (aviso em log).
 */

/** Teto do logo embutido no HTML do PDF. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

const EXTENSION_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
};

function imageMimeOf(file: AttachmentFile): string | null {
  const mime = file.detectedMimeType ?? EXTENSION_MIME[file.extension.toLowerCase()] ?? null;
  return mime !== null && (TEMPLATE_LOGO_MIME_TYPES as readonly string[]).includes(mime)
    ? mime
    : null;
}

@Injectable()
export class TemplateLogoService {
  private readonly logger = new Logger('TemplateLogo');

  constructor(private readonly files: AttachmentFileRegistry) {}

  /** RN-TPL-23 no PATCH: 422 `REFERENCE_NOT_FOUND`/`INVALID_FORMAT` ou 409 `ATTACHMENT_NOT_AVAILABLE`. */
  async assertUsable(tx: TenantTx, attachmentId: string): Promise<void> {
    const file = await this.files.find(tx, attachmentId);
    if (file?.targetType !== 'TENANT_ASSET') throw templateLogoNotFound();
    if (file.status !== 'AVAILABLE') throw templateLogoNotAvailable();
    if (imageMimeOf(file) === null) throw templateLogoNotImage();
  }

  /** O logo do layout pronto para o HTML do PDF; `null` = sem logo (ou indisponível agora). */
  async load(tx: TenantTx, layout: LayoutDefinition | null): Promise<RenditionLogo | null> {
    const logo = layout?.logo;
    if (logo === undefined) return null;
    const file = await this.files.find(tx, logo.attachmentId);
    const mime =
      file?.targetType === 'TENANT_ASSET' && file.status === 'AVAILABLE' ? imageMimeOf(file) : null;
    const bytes =
      mime === null ? null : await this.files.readContent(tx, logo.attachmentId, LOGO_MAX_BYTES);
    if (mime === null || bytes === null) {
      this.logger.warn(
        { event: 'template_layout.logo_unavailable', attachmentId: logo.attachmentId },
        'template_layout.logo_unavailable',
      );
      return null;
    }
    return {
      dataUri: `data:${mime};base64,${bytes.toString('base64')}`,
      position: logo.position,
      maxHeightMm: logo.maxHeightMm,
    };
  }
}

import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import type {
  AttachmentTarget,
  AttachmentTargetReader,
  AttachmentTargetRef,
} from '#shared/files/attachment-targets.js';

import { templateVersionNotDraft, templateVersionNotFound } from './template.errors.js';
import { TEMPLATE_REPOSITORY } from './template.ports.js';
import type { TemplateRepository } from './template.ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';

/*
 * Logo (timbre) do layout de impressão como alvo de anexo (US-109 · RN-TPL-23 · storage.md §4): o
 * ativo é do TENANT (`TENANT_ASSET`, sem processo, chave `assets/`), enviado a partir do rascunho
 * de um template — `targetId` = a versão `DRAFT`. Anexar exige `TEMPLATE_MANAGE` (além do
 * `ATTACHMENT_UPLOAD` conferido pelo `files`) e o rascunho ainda editável (409
 * `TEMPLATE_VERSION_NOT_DRAFT`). Depois de `AVAILABLE`, o logo vale em qualquer template do tenant.
 */

@Injectable()
export class TemplateAssetAttachmentTargets implements AttachmentTargetReader {
  readonly targetTypes = ['TENANT_ASSET'] as const;

  constructor(
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async load(tx: TenantTx, ref: AttachmentTargetRef): Promise<AttachmentTarget | null> {
    const version = await this.templates.findVersionById(tx, ref.targetId);
    return version === null ? null : { ...ref, processId: null, process: null };
  }

  async assertAttachable(tx: TenantTx, target: AttachmentTarget): Promise<void> {
    this.access.assertCan('TEMPLATE_MANAGE', { mfaPolicy: await this.identity.mfaPolicy() });
    const version = await this.templates.findVersionById(tx, target.targetId);
    if (version === null) throw templateVersionNotFound();
    if (version.status !== 'DRAFT') throw templateVersionNotDraft(version.id, version.status);
  }
}

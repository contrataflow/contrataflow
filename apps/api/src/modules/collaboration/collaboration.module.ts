import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { DocumentProcessContextModule } from '#shared/document/document-process-context.js';

import { CollaborationFacade } from './application/collaboration.facade.js';
import {
  CreateCommentCommand,
  DeleteCommentCommand,
  UpdateCommentCommand,
} from './application/comment.commands.js';
import { ListCommentsQuery } from './application/comment.queries.js';
import { CommentGate, CommentPresenter, CommentRecorder } from './application/comment.support.js';
import { COMMENT_CLOCK, COMMENT_REPOSITORY, COMMENT_TRANSACTIONS } from './application/ports.js';
import {
  InMemoryCommentRepository,
  InMemoryCommentTransactions,
} from './infrastructure/in-memory-comment.repository.js';
import {
  PrismaCommentRepository,
  PrismaCommentTransactions,
} from './infrastructure/prisma-comment.repository.js';
import { CommentController } from './presentation/comment.controller.js';
import { AccessModule } from '../access/access.module.js';
import { DocumentModule } from '../document/document.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { ProcessModule } from '../process/process.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): comentários em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `collaboration` (DEC-040, nível 4): outros módulos usam somente a fachada exportada. Dono
 * de `Comment` (e, com a US-072, de `Mention`). US-071: comentar no processo e em documentos
 * (CMT-01..04) — o processo vem do kernel compartilhado (`DocumentProcessContextRegistry`), a
 * permissão do `access`, o alvo documento da fachada do `document`, POL-09 do `process` e o autor
 * de `identity`/`organization`.
 */
@Module({
  imports: [
    AccessModule,
    DocumentModule,
    DocumentProcessContextModule,
    IdentityModule,
    OrganizationModule,
    ProcessModule,
  ],
  controllers: [CommentController],
  providers: [
    CollaborationFacade,
    ListCommentsQuery,
    CreateCommentCommand,
    UpdateCommentCommand,
    DeleteCommentCommand,
    CommentGate,
    CommentPresenter,
    CommentRecorder,
    PrismaCommentRepository,
    PrismaCommentTransactions,
    InMemoryCommentTransactions,
    { provide: InMemoryCommentRepository, useFactory: () => new InMemoryCommentRepository() },
    {
      provide: COMMENT_REPOSITORY,
      inject: [APP_CONFIG, PrismaCommentRepository, InMemoryCommentRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaCommentRepository,
        memory: InMemoryCommentRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: COMMENT_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaCommentTransactions, InMemoryCommentTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaCommentTransactions,
        memory: InMemoryCommentTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: COMMENT_CLOCK, useValue: () => new Date() },
  ],
  exports: [CollaborationFacade],
})
export class CollaborationModule {}

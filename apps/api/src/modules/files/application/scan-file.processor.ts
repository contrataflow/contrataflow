import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';

import { isUploadExtension } from '@contrataflow/types';
import type { AttachmentReasonCode } from '@contrataflow/types';
import { AttachmentRejected, AttachmentUploaded } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';
import { StorageService } from '#shared/storage/storage.service.js';

import { AntivirusCircuit } from './antivirus-circuit.js';
import {
  ANTIVIRUS,
  ATTACHMENT_REPOSITORY,
  AntivirusUnavailableError,
  FILES_CLOCK,
  FILES_SETTINGS,
  FILES_TRANSACTIONS,
} from './files-ports.js';
import type {
  AntivirusPort,
  AttachmentRepository,
  FilesClock,
  FilesSettings,
  FilesTransactions,
} from './files-ports.js';
import { recordScan } from './scan-telemetry.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import {
  canClaimScan,
  claimedAttempt,
  markAvailable,
  markRejected,
  releaseScan,
  startScanning,
} from '../domain/attachment.js';
import type { Attachment, ScanResult } from '../domain/attachment.js';
import { ContentInspector } from '../domain/content-inspector.js';
import type { ContentVerdict } from '../domain/content-inspector.js';
import { classifyFinding } from '../domain/scan-verdict.js';
import type { AntivirusResult } from '../domain/scan-verdict.js';

/*
 * `ScanFileHandler` do `file-scan` (US-068 · RN-DOC-74/75/76 · storage.md §5.3 · queues.md §4.5),
 * em três passos — nenhuma chamada a S3/ClamAV dentro de transação:
 *
 *   1. Trava (transação curta): `UPLOADED` → `SCANNING`, ou `SCANNING` de tentativa anterior/trava
 *      vencida, por gravação condicional (versão lida). Duas entregas da mesma tentativa → só uma
 *      assume; a outra conclui sem efeito (Gherkin "[Concorrência]").
 *   2. Varredura (fora de transação): UM stream da quarentena dividido entre a inspeção de tipo
 *      (*magic bytes* + estrutura), o SHA-256 e o `INSTREAM` do ClamAV. Antivírus fora do ar (ou
 *      disjuntor aberto) → devolve a trava, o anexo FICA `SCANNING` e o job pausa sem consumir
 *      tentativa (`ScanDeferredError`) — nunca `AVAILABLE` sem varredura limpa (P3).
 *   3. Resultado (transação curta): limpo → `CopyObject` para `documents` ANTES, depois `AVAILABLE`
 *      + auditoria `attachment.scan_result` + `AttachmentUploaded` (timeline síncrona); malware →
 *      `INFECTED`; tipo/estrutura/tamanho → `REJECTED`; nos dois, `AttachmentRejected`. Por fim
 *      remove o objeto da quarentena (melhor esforço; o lifecycle de 1 dia cobre falhas).
 *
 * Nunca em log: nome do arquivo, conteúdo ou assinatura do malware (só em `scan_result`, no banco).
 */

export type ScanOutcome = 'AVAILABLE' | 'INFECTED' | 'REJECTED' | 'SKIPPED';

export interface ScanFileInput {
  readonly attachmentId: string;
  /** Tentativa do job (começa em 1). */
  readonly attempt: number;
  /** Última tentativa da política da fila: a falha vira `attachment.scan_failed`. */
  readonly lastAttempt?: boolean;
}

/**
 * Antivírus indisponível: o job pausa e volta SEM consumir tentativa (queues.md §10.3); o anexo
 * permanece `SCANNING`. O runtime do worker traduz para a pausa da fila (`consumesAttempt`).
 */
export class ScanDeferredError extends Error {
  readonly consumesAttempt = false;
  readonly dependency = 'clamav';

  constructor(readonly retryAfterSeconds: number) {
    super('Varredura adiada: antivírus indisponível.');
    this.name = 'ScanDeferredError';
  }
}

/** A inspeção de tipo decidiu antes do fim: aborta a leitura (e o envio ao ClamAV). */
class ContentRejectedError extends Error {
  constructor(readonly verdict: Extract<ContentVerdict, { ok: false }>) {
    super('Conteúdo rejeitado na inspeção de tipo.');
    this.name = 'ContentRejectedError';
  }
}

interface ScanRun {
  readonly sha256: string;
  readonly bytes: number;
  readonly antivirus: AntivirusResult | null;
  readonly content: ContentVerdict;
}

interface Decision {
  readonly status: 'AVAILABLE' | 'INFECTED' | 'REJECTED';
  readonly reasonCode: AttachmentReasonCode | null;
  readonly signature: string | null;
  readonly detectedMimeType: string | null;
}

const SETTING_EXTENSIONS = 'uploads.allowedExtensions';

@Injectable()
export class ScanFileProcessor {
  private readonly logger = new Logger('ScanFileHandler');

  constructor(
    @Inject(FILES_TRANSACTIONS) private readonly transactions: FilesTransactions,
    @Inject(ATTACHMENT_REPOSITORY) private readonly attachments: AttachmentRepository,
    @Inject(FILES_CLOCK) private readonly clock: FilesClock,
    @Inject(FILES_SETTINGS) private readonly settings: FilesSettings,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    @Inject(ANTIVIRUS) private readonly antivirus: AntivirusPort,
    private readonly circuit: AntivirusCircuit,
    private readonly storage: StorageService,
    private readonly tenancy: TenancyFacade,
  ) {}

  async process(input: ScanFileInput): Promise<ScanOutcome> {
    const startedAt = performance.now();
    const claimed = await this.claim(input);
    if (claimed === null) return 'SKIPPED';
    const { attachment, allowedExtensions } = claimed;

    if (!this.circuit.tryAcquire()) {
      await this.release(attachment, input.attempt);
      throw this.deferred(attachment, input, startedAt);
    }

    let run: ScanRun | null;
    try {
      run = await this.scan(attachment, allowedExtensions);
      this.circuit.recordSuccess();
    } catch (error) {
      await this.release(attachment, input.attempt);
      if (error instanceof AntivirusUnavailableError) {
        this.circuit.recordFailure();
        throw this.deferred(attachment, input, startedAt);
      }
      this.logFailure(attachment, input, error);
      throw error;
    }

    const decision = this.decide(attachment, run);
    if (decision.status === 'AVAILABLE') await this.promote(attachment, run);
    const outcome = await this.complete(attachment, input.attempt, decision, run, startedAt);
    if (outcome !== 'SKIPPED') await this.discardQuarantine(attachment);
    return outcome;
  }

  /** Passo 1: trava condicional + allowlist vigente do tenant. `null` = nada a fazer. */
  private claim(
    input: ScanFileInput,
  ): Promise<{ attachment: Attachment; allowedExtensions: string[] } | null> {
    return this.transactions.run(async (tx) => {
      const current = await this.attachments.findById(tx, input.attachmentId);
      const now = this.clock();
      if (
        current === null ||
        !canClaimScan(current, input.attempt, now, this.settings.scanLeaseMs)
      ) {
        this.logger.log(
          {
            event: 'attachment.scan_skipped',
            attachmentId: input.attachmentId,
            status: current?.status ?? null,
            attempt: input.attempt,
          },
          'attachment.scan_skipped',
        );
        return null;
      }
      const next = startScanning(current, input.attempt, now);
      if (!(await this.attachments.update(tx, next, current.version))) return null;
      const values = await this.tenancy.settingValues(tx, [SETTING_EXTENSIONS]);
      const extensions = values.get(SETTING_EXTENSIONS);
      return {
        attachment: next,
        allowedExtensions: Array.isArray(extensions) ? extensions.map(String) : [],
      };
    });
  }

  /** Devolve a trava (o anexo segue `SCANNING`); perder a corrida aqui não é erro. */
  private async release(attachment: Attachment, attempt: number): Promise<void> {
    await this.transactions.run(async (tx) => {
      const current = await this.attachments.findById(tx, attachment.id);
      if (current?.status !== 'SCANNING' || claimedAttempt(current) !== attempt) return;
      await this.attachments.update(
        tx,
        releaseScan(current, attempt, this.clock()),
        current.version,
      );
    });
  }

  /** Passo 2: leitura ÚNICA da quarentena dividida entre tipo, SHA-256 e ClamAV (*tee*). */
  private async scan(attachment: Attachment, allowedExtensions: string[]): Promise<ScanRun> {
    const source = await this.storage.openRead({
      bucket: 'quarantine',
      key: attachment.quarantineKey ?? '',
    });
    const extension = attachment.extension;
    if (!isUploadExtension(extension)) {
      return { sha256: '', bytes: 0, antivirus: null, content: notAllowed() };
    }
    const inspector = new ContentInspector({ extension, allowedExtensions });
    if (source === null) {
      // Objeto expirou na quarentena (lifecycle) antes da varredura: nada a liberar.
      return { sha256: '', bytes: 0, antivirus: null, content: inspector.finish() };
    }
    const hash = createHash('sha256');
    let bytes = 0;
    const tee = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        const verdict = inspector.update(chunk);
        if (verdict !== null && !verdict.ok) {
          callback(new ContentRejectedError(verdict));
          return;
        }
        callback(null, chunk);
      },
    });
    source.on('error', (error) => tee.destroy(error));
    source.pipe(tee);
    try {
      const antivirus = await this.antivirus.scan(tee);
      return { sha256: hash.digest('hex'), bytes, antivirus, content: inspector.finish() };
    } catch (error) {
      if (!(error instanceof ContentRejectedError)) throw error;
      destroyQuietly(source);
      return { sha256: hash.digest('hex'), bytes, antivirus: null, content: error.verdict };
    }
  }

  /** RN-DOC-76: malware prevalece; depois tipo/estrutura; depois tamanho; senão limpo. */
  private decide(attachment: Attachment, run: ScanRun): Decision {
    if (run.antivirus !== null && !run.antivirus.clean) {
      const finding = classifyFinding(run.antivirus.signature);
      return {
        status: finding.status,
        reasonCode: finding.reasonCode,
        signature: run.antivirus.signature,
        detectedMimeType: run.content.detectedMimeType,
      };
    }
    if (!run.content.ok) {
      return {
        status: 'REJECTED',
        reasonCode: run.content.reasonCode,
        signature: null,
        detectedMimeType: run.content.detectedMimeType,
      };
    }
    if (run.antivirus === null || run.bytes !== attachment.sizeBytes) {
      return {
        status: 'REJECTED',
        reasonCode: 'SIZE_MISMATCH',
        signature: null,
        detectedMimeType: run.content.detectedMimeType,
      };
    }
    return {
      status: 'AVAILABLE',
      reasonCode: null,
      signature: null,
      detectedMimeType: run.content.detectedMimeType,
    };
  }

  /** Promoção quarentena → `documents` antes do commit de `AVAILABLE` (cópia é idempotente). */
  private async promote(attachment: Attachment, run: ScanRun): Promise<void> {
    await this.storage.copy({
      from: { bucket: 'quarantine', key: attachment.quarantineKey ?? '' },
      to: { bucket: 'documents', key: attachment.storageKey },
      contentType: run.content.detectedMimeType ?? 'application/octet-stream',
      metadata: {
        'cf-tenant-id': attachment.tenantId,
        'cf-attachment-id': attachment.id,
        'cf-sha256': run.sha256,
        'cf-schema': '1',
      },
    });
  }

  /** Passo 3: grava o resultado SE a trava ainda é desta tentativa. */
  private async complete(
    claimed: Attachment,
    attempt: number,
    decision: Decision,
    run: ScanRun,
    startedAt: number,
  ): Promise<ScanOutcome> {
    const durationMs = Math.round(performance.now() - startedAt);
    const engineVersion = run.antivirus === null ? null : await this.engineVersion();
    const scanResult: ScanResult = {
      engine: this.antivirus.engine,
      engineVersion,
      signature: decision.signature,
      ...(decision.reasonCode === null ? {} : { reasonCode: decision.reasonCode }),
      detectedMimeType: decision.detectedMimeType,
      durationMs,
    };
    const sha256 = run.bytes > 0 ? run.sha256 : null;
    const outcome = await this.transactions.run(async (tx) => {
      const current = await this.attachments.findById(tx, claimed.id);
      if (current?.status !== 'SCANNING' || claimedAttempt(current) !== attempt) return null;
      const now = this.clock();
      const next =
        decision.status === 'AVAILABLE'
          ? markAvailable(
              current,
              {
                sha256: run.sha256,
                detectedMimeType: decision.detectedMimeType ?? '',
                scanResult,
              },
              now,
            )
          : markRejected(current, decision.status, { sha256, scanResult }, now);
      if (!(await this.attachments.update(tx, next, current.version))) return null;
      await this.recordResult(tx, next, decision);
      return next;
    });
    if (outcome === null) return 'SKIPPED';
    this.logCompleted(outcome, decision, durationMs);
    return decision.status;
  }

  private async recordResult(tx: TenantTx, next: Attachment, decision: Decision): Promise<void> {
    await this.audit.record(tx, {
      action: 'attachment.scan_result',
      entityType: 'Attachment',
      entityId: next.id,
      processId: next.processId,
      metadata: {
        status: next.status,
        ...(decision.reasonCode === null ? {} : { reasonCode: decision.reasonCode }),
        sha256: next.sha256,
      },
    });
    if (next.status === 'AVAILABLE') {
      await this.outbox.record(
        tx,
        AttachmentUploaded.of({
          aggregateId: next.id,
          processId: next.processId,
          payload: {
            attachmentId: next.id,
            targetType: next.targetType,
            targetId: next.targetId,
            fileName: next.fileName,
            sizeBytes: next.sizeBytes,
            sha256: next.sha256 ?? '',
          },
        }),
      );
      return;
    }
    await this.outbox.record(
      tx,
      AttachmentRejected.of({
        aggregateId: next.id,
        processId: next.processId,
        payload: {
          attachmentId: next.id,
          status: next.status === 'INFECTED' ? 'INFECTED' : 'REJECTED',
          reasonCode: decision.reasonCode ?? 'STRUCTURAL_CHECK_FAILED',
        },
      }),
    );
  }

  private async engineVersion(): Promise<string | null> {
    try {
      return await this.antivirus.version();
    } catch {
      return null;
    }
  }

  private async discardQuarantine(attachment: Attachment): Promise<void> {
    try {
      await this.storage.delete({ bucket: 'quarantine', key: attachment.quarantineKey ?? '' });
    } catch (error) {
      this.logger.warn(
        {
          event: 'attachment.quarantine_cleanup_failed',
          attachmentId: attachment.id,
          errorClass: error instanceof Error ? error.name : 'unknown',
        },
        'attachment.quarantine_cleanup_failed',
      );
    }
  }

  private deferred(
    attachment: Attachment,
    input: ScanFileInput,
    startedAt: number,
  ): ScanDeferredError {
    recordScan('DEFERRED', null, Math.round(performance.now() - startedAt));
    this.logger.warn(
      {
        event: 'attachment.scan_retry',
        attachmentId: attachment.id,
        attempt: input.attempt,
        errorClass: 'AntivirusUnavailable',
        circuit: this.circuit.state,
      },
      'attachment.scan_retry',
    );
    return new ScanDeferredError(Math.max(1, this.circuit.retryAfterSeconds()));
  }

  private logFailure(attachment: Attachment, input: ScanFileInput, error: unknown): void {
    const errorClass = error instanceof Error ? error.name : 'unknown';
    if (input.lastAttempt === true) {
      this.logger.error(
        {
          event: 'attachment.scan_failed',
          attachmentId: attachment.id,
          errorCode: errorClass,
          correlationId: requireRequestContext().correlationId,
        },
        'attachment.scan_failed',
      );
      return;
    }
    this.logger.warn(
      {
        event: 'attachment.scan_retry',
        attachmentId: attachment.id,
        attempt: input.attempt,
        errorClass,
      },
      'attachment.scan_retry',
    );
  }

  private logCompleted(attachment: Attachment, decision: Decision, durationMs: number): void {
    recordScan(decision.status, decision.reasonCode, durationMs);
    this.logger.log(
      {
        event: 'attachment.scan_completed',
        attachmentId: attachment.id,
        result: decision.status,
        ...(decision.reasonCode === null ? {} : { reasonCode: decision.reasonCode }),
        durationMs,
      },
      'attachment.scan_completed',
    );
    if (decision.status === 'INFECTED') {
      // Alerta de segurança informativo (storage.md §14) — nunca a assinatura.
      this.logger.warn(
        {
          event: 'security.malware_detected',
          attachmentId: attachment.id,
          tenantId: attachment.tenantId,
          correlationId: requireRequestContext().correlationId,
        },
        'security.malware_detected',
      );
    }
  }
}

function notAllowed(): ContentVerdict {
  return { ok: false, reasonCode: 'TYPE_NOT_ALLOWED', detectedMimeType: null };
}

function destroyQuietly(stream: Readable): void {
  stream.on('error', () => undefined);
  stream.destroy();
}

'use client';

import type { AttachmentReasonCode } from '@contrataflow/types';
import type { AttachmentDto, DocumentVersionDto } from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  confirmAttachment,
  createAttachmentIntent,
  fetchAttachment,
  uploadToStorage,
} from '@/features/attachments/attachments.api';
import { checkLocalFile } from '@/features/attachments/upload-rules';
import { isApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';
import { useTenantId } from '@/lib/session/session-context';

import { documentKeys } from './documents.api';
import { uploadDocumentVersion } from './uploaded-documents.api';

/*
 * Envio do arquivo do documento externo (US-064 · fluxo principal 4–7 · FA-01/03/05): validação
 * local → intenção (ATT-02, alvo `DOCUMENT`) → PUT direto na quarentena com progresso → confirmação
 * (ATT-03) → *polling* de ATT-04 (1 s a 15 s) até `AVAILABLE`/`INFECTED`/`REJECTED` → DOC-19 com o
 * `If-Match` da versão atual do documento. A chave de idempotência do DOC-19 nasce com o arquivo e é
 * reaproveitada em "Tentar novamente" (o reenvio não duplica a versão — FA-05); o anexo já varrido
 * também (não reenvia o arquivo). Rejeitado: escolher outro arquivo (FA-01).
 */

export type FileUploadPhase =
  'idle' | 'uploading' | 'scanning' | 'registering' | 'done' | 'rejected' | 'failed';

export interface FileUploadState {
  readonly phase: FileUploadPhase;
  readonly fileName: string | null;
  readonly progress: number;
  /** Motivo resumido da rejeição pela varredura. */
  readonly reasonCode: AttachmentReasonCode | null;
  /** Código da falha (API ou `NETWORK`) e o `detail` da API. */
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  /** Recusa da validação local (antes de qualquer chamada). */
  readonly localRejection: 'TYPE' | 'SIZE' | 'EMPTY' | null;
  readonly version: DocumentVersionDto | null;
}

export const IDLE_UPLOAD: FileUploadState = {
  phase: 'idle',
  fileName: null,
  progress: 0,
  reasonCode: null,
  errorCode: null,
  errorDetail: null,
  localRejection: null,
  version: null,
};

export interface FileUploadDeps {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly createRequest?: () => XMLHttpRequest;
}

const POLL_START_MS = 1_000;
const POLL_MAX_MS = 15_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** O envio em curso: o arquivo, o anexo (quando já criado) e a chave do DOC-19. */
interface Attempt {
  readonly file: File;
  readonly mimeType: string;
  attachment: AttachmentDto | null;
  readonly key: string;
}

export function useDocumentFileUpload(
  document: { readonly id: string; readonly version: number },
  deps: FileUploadDeps = {},
) {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [state, setState] = useState<FileUploadState>(IDLE_UPLOAD);
  const attempt = useRef<Attempt | null>(null);
  const alive = useRef(true);
  // O `If-Match` é o da versão mais recente lida (o documento é recarregado depois de cada envio).
  const documentVersion = useRef(document.version);
  const { createRequest, sleep = defaultSleep } = deps;

  useEffect(() => {
    documentVersion.current = document.version;
  }, [document.version]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const patch = useCallback((changes: Partial<FileUploadState>) => {
    if (alive.current) setState((current) => ({ ...current, ...changes }));
  }, []);

  const fail = useCallback(
    (error: unknown) => {
      patch({
        phase: 'failed',
        errorCode: isApiError(error) ? error.code : 'NETWORK',
        errorDetail: isApiError(error) ? (error.problem?.detail ?? null) : null,
      });
      if (isApiError(error) && (error.status === 412 || error.status === 409)) {
        // O documento mudou (outra versão, status): recarrega para o próximo `If-Match`/ações.
        void queryClient.invalidateQueries({ queryKey: documentKeys.all(tenantId, document.id) });
      }
    },
    [document.id, patch, queryClient, tenantId],
  );

  /** Passo 6: DOC-19 com o anexo `AVAILABLE`. */
  const register = useCallback(
    async (current: Attempt, attachment: AttachmentDto) => {
      patch({ phase: 'registering', errorCode: null, errorDetail: null });
      try {
        const version = await uploadDocumentVersion(
          document.id,
          { attachmentId: attachment.id },
          documentVersion.current,
          current.key,
        );
        patch({ phase: 'done', version });
        await queryClient.invalidateQueries({ queryKey: documentKeys.all(tenantId, document.id) });
      } catch (error) {
        fail(error);
      }
    },
    [document.id, fail, patch, queryClient, tenantId],
  );

  /** Passo 5: espera a varredura terminar (nunca usa o arquivo antes de `AVAILABLE`). */
  const awaitScan = useCallback(
    async (attachmentId: string): Promise<AttachmentDto | null> => {
      const mounted = () => alive.current;
      let wait = POLL_START_MS;
      while (mounted()) {
        await sleep(wait);
        if (!mounted()) return null;
        try {
          const attachment = await fetchAttachment(attachmentId);
          if (attachment.status !== 'UPLOADED' && attachment.status !== 'SCANNING') {
            return attachment;
          }
        } catch {
          // Falha momentânea da consulta: tenta de novo no próximo intervalo.
        }
        wait = Math.min(wait * 2, POLL_MAX_MS);
      }
      return null;
    },
    [sleep],
  );

  const run = useCallback(
    async (current: Attempt) => {
      try {
        let attachment = current.attachment;
        if (attachment?.status !== 'AVAILABLE') {
          patch({ phase: 'uploading', progress: 0, errorCode: null, errorDetail: null });
          const intent = await createAttachmentIntent({
            targetType: 'DOCUMENT',
            targetId: document.id,
            fileName: current.file.name,
            declaredMimeType: current.mimeType,
            sizeBytes: current.file.size,
          });
          current.attachment = intent.attachment;
          await uploadToStorage(
            intent.upload,
            current.file,
            (progress) => {
              patch({ progress });
            },
            createRequest,
          );
          patch({ progress: 100, phase: 'scanning' });
          const confirmation = await confirmAttachment(intent.attachment.id);
          if (confirmation.status === 'INFECTED' || confirmation.status === 'REJECTED') {
            patch({ phase: 'rejected', reasonCode: confirmation.reasonCode ?? null });
            return;
          }
          const scanned = await awaitScan(intent.attachment.id);
          if (scanned === null) return;
          current.attachment = scanned;
          if (scanned.status !== 'AVAILABLE') {
            patch({ phase: 'rejected', reasonCode: scanned.reasonCode });
            return;
          }
          attachment = scanned;
        }
        await register(current, attachment);
      } catch (error) {
        fail(error);
      }
    },
    [awaitScan, createRequest, document.id, fail, patch, register],
  );

  /** Seleção do arquivo (input ou soltar): um arquivo por vez. */
  const start = useCallback(
    (file: File) => {
      const check = checkLocalFile(file);
      if (!check.ok) {
        setState({ ...IDLE_UPLOAD, fileName: file.name, localRejection: check.reason });
        return;
      }
      const current: Attempt = {
        file,
        mimeType: check.mimeType,
        attachment: null,
        key: newIdempotencyKey(),
      };
      attempt.current = current;
      setState({ ...IDLE_UPLOAD, phase: 'uploading', fileName: file.name });
      void run(current);
    },
    [run],
  );

  /** "Tentar novamente": mesma chave; o anexo já disponível não é reenviado. */
  const retry = useCallback(() => {
    const current = attempt.current;
    if (current !== null) void run(current);
  }, [run]);

  const reset = useCallback(() => {
    attempt.current = null;
    setState(IDLE_UPLOAD);
  }, []);

  return { state, start, retry, reset };
}

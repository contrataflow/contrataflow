'use client';

import { Alert, Button, buttonClassName } from '@contrataflow/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

import { DFD_STEP_SLUGS } from './dfd-model';
import { createDfd, dfdHref } from './dfd.api';
import {
  useActiveDocumentTypes,
  useProcessDocuments,
} from '../process-documents/process-documents.api';

/** Resultado de uma tentativa de criar o DFD (FA-02 e "Falha de banco"). */
export type ElaborateOutcome =
  | { readonly kind: 'exists'; readonly code: string | null; readonly dfdId: string | null }
  | { readonly kind: 'failed'; readonly correlationId: string | null };

/**
 * DFD-02 a partir do processo (US-014 · fluxo principal 1–5): a `Idempotency-Key` nasce uma vez por
 * clique e é reaproveitada no reenvio do mesmo clique (duplo clique = mesma resposta); 201 navega
 * para o SCR-007 no passo indicado por `wizardStep`; 409 `DOCUMENT_ALREADY_EXISTS` oferece "Abrir
 * DFD" (FA-02); falha mostra a mensagem com o `correlationId`.
 */
export function useElaborateDfd(processId: string) {
  const router = useRouter();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const key = useRef<string | null>(null);
  const [outcome, setOutcome] = useState<ElaborateOutcome | null>(null);
  const mutation = useMutation({
    mutationFn: () => {
      key.current ??= newIdempotencyKey();
      return createDfd(processId, null, key.current);
    },
    onSuccess: async ({ dfd }) => {
      key.current = null;
      setOutcome(null);
      await queryClient.invalidateQueries({
        queryKey: tenantKey(tenantId, 'processes', processId),
      });
      router.push(dfdHref(processId, dfd.id, DFD_STEP_SLUGS[dfd.wizardStep]));
    },
    onError: (error: unknown) => {
      key.current = null;
      if (isApiError(error) && error.code === 'DOCUMENT_ALREADY_EXISTS') {
        const meta = (error.problem?.meta ?? {}) as {
          code?: string | null;
          existingDfdId?: string;
        };
        setOutcome({ kind: 'exists', code: meta.code ?? null, dfdId: meta.existingDfdId ?? null });
        return;
      }
      setOutcome({
        kind: 'failed',
        correlationId: isApiError(error) ? error.correlationId : null,
      });
    },
  });
  return {
    elaborate: () => {
      if (!mutation.isPending) mutation.mutate();
    },
    pending: mutation.isPending,
    outcome,
    dismiss: () => {
      setOutcome(null);
    },
  };
}

/** Alerta do resultado (FA-02 "Abrir DFD" ou falha com o código de correlação). */
export function ElaborateDfdOutcome({
  processId,
  outcome,
}: {
  readonly processId: string;
  readonly outcome: ElaborateOutcome | null;
}) {
  const t = useTranslations('dfd.elaborate');
  if (outcome === null) return null;
  if (outcome.kind === 'exists') {
    return (
      <Alert
        tone="info"
        title={outcome.code === null ? t('existsNoCode') : t('exists', { code: outcome.code })}
      >
        {outcome.dfdId === null ? null : (
          <div className="mt-2">
            <Link
              href={dfdHref(processId, outcome.dfdId)}
              className={buttonClassName({ variant: 'secondary', size: 'sm' })}
            >
              {t('open')}
            </Link>
          </div>
        )}
      </Alert>
    );
  }
  return (
    <Alert
      tone="error"
      title={
        outcome.correlationId === null
          ? t('failed')
          : t('failedWithCode', { correlationId: outcome.correlationId })
      }
    />
  );
}

/**
 * "Elaborar DFD" no painel do processo (SCR-006 · fluxo principal 1): exibido só quando o DOC-01
 * diz que o usuário pode criar o tipo `DFD` agora (`meta.creatableTypeIds` — `DFD_CREATE` + POL-02
 * + etapa + sem DFD ativo no processo). A UI nunca recalcula a regra.
 */
export function ElaborateDfdButton({ processId }: { readonly processId: string }) {
  const t = useTranslations('dfd.elaborate');
  const documents = useProcessDocuments(processId);
  const types = useActiveDocumentTypes();
  const action = useElaborateDfd(processId);
  const dfdType = types.data?.find((type) => type.systemModule === 'DFD');
  // `creatableTypeIds` já exclui o tipo singular com documento ativo (RN-DOC-16 · FA-02).
  const creatable =
    dfdType !== undefined && documents.data?.meta.creatableTypeIds.includes(dfdType.id) === true;
  if (!creatable && action.outcome === null) return null;
  return (
    <div className="flex flex-col gap-2">
      {creatable ? (
        <Button
          variant="primary"
          size="sm"
          aria-disabled={action.pending ? true : undefined}
          onClick={action.elaborate}
        >
          {action.pending ? t('creating') : t('action')}
        </Button>
      ) : null}
      <ElaborateDfdOutcome processId={processId} outcome={action.outcome} />
    </div>
  );
}

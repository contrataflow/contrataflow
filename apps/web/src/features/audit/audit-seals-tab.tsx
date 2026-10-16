'use client';

import type {
  AuditSealDto,
  AuditSealVerification,
  VerifyAuditSeals,
} from '@contrataflow/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useShellSession } from '@/lib/session/session-context';

import { auditKeys, verifyAuditSeals } from './audit-seals.api';
import { SealList } from './seal-list';
import {
  EMPTY_RANGE,
  classifyVerifyError,
  isoToLocalInput,
  rangeOfSeals,
  verificationIndex,
} from './seal-model';
import type { RangeInput } from './seal-model';
import { SealVerificationPanel } from './seal-verification-panel';
import { SealVerificationResult } from './seal-verification-result';

/**
 * Aba "Selos" de SCR-037 (US-074): `SealList` (AUD-04) + `SealVerificationPanel` e
 * `SealVerificationResult` (AUD-05). Selecionar selos na lista preenche o intervalo (menor início,
 * maior fim); o resultado da verificação também colore o status dos selos da lista. A verificação é
 * um comando de leitura (`useMutation`): o 403 `MFA_REQUIRED` cai no interceptador global de
 * step-up e, ao concluir, o foco vai ao resultado.
 */
export function AuditSealsTab() {
  const t = useTranslations('audit.seals');
  const queryClient = useQueryClient();
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;

  const [selected, setSelected] = useState<ReadonlyMap<string, AuditSealDto>>(new Map());
  const [range, setRange] = useState<RangeInput>(EMPTY_RANGE);
  // Último resultado bem-sucedido: segue colorindo a lista enquanto uma nova verificação roda.
  const [verification, setVerification] = useState<AuditSealVerification | null>(null);
  const [completed, setCompleted] = useState(0);
  const lastBody = useRef<VerifyAuditSeals | null>(null);
  const resultHeading = useRef<HTMLHeadingElement | null>(null);
  const listHeading = useRef<HTMLHeadingElement | null>(null);

  const verify = useMutation({
    mutationFn: verifyAuditSeals,
    onSuccess: (data) => {
      setVerification(data);
    },
    onSettled: () => {
      setCompleted((current) => current + 1);
    },
  });

  // Foco no resultado quando a verificação conclui (acessibilidade de SCR-037).
  useEffect(() => {
    if (completed > 0) resultHeading.current?.focus();
  }, [completed]);

  const failure = verify.error === null ? null : classifyVerifyError(verify.error);
  const index = useMemo(() => verificationIndex(verification), [verification]);

  const run = (body: VerifyAuditSeals) => {
    lastBody.current = body;
    verify.mutate(body);
  };

  const toggle = (seal: AuditSealDto) => {
    const next = new Map(selected);
    if (next.has(seal.id)) next.delete(seal.id);
    else next.set(seal.id, seal);
    setSelected(next);
    const bounds = rangeOfSeals(next.values());
    if (bounds) {
      setRange({
        start: isoToLocalInput(bounds.start, timeZone),
        end: isoToLocalInput(bounds.end, timeZone),
      });
      if (verify.isError) verify.reset();
    }
  };

  const changeRange = (next: RangeInput) => {
    setRange(next);
    // O 422 é sobre o intervalo anterior: some assim que o usuário o altera.
    if (failure?.kind === 'validation') verify.reset();
  };

  const backToList = () => {
    verify.reset();
    void queryClient.invalidateQueries({ queryKey: auditKeys.seals(tenantId) });
    listHeading.current?.focus();
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('description')}</p>
      <SealList
        timeZone={timeZone}
        selected={selected}
        onToggle={toggle}
        onClearSelection={() => {
          setSelected(new Map());
        }}
        verification={index}
        headingRef={listHeading}
      />
      <SealVerificationPanel
        timeZone={timeZone}
        value={range}
        onChange={changeRange}
        onVerify={run}
        pending={verify.isPending}
        serverError={failure?.kind === 'validation' ? failure.message : null}
      />
      <SealVerificationResult
        timeZone={timeZone}
        pending={verify.isPending}
        verification={verification}
        failure={failure === null || failure.kind === 'validation' ? null : failure}
        onRetry={() => {
          const body = lastBody.current;
          if (body) run(body);
        }}
        onBackToList={backToList}
        returnTo="/auditoria"
        headingRef={resultHeading}
      />
    </div>
  );
}

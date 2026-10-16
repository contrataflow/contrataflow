# `process`

Processo, itens, participantes, etiquetas, runtime da tramitação e visibilidade (DEC-040).

## Painel situacional — ações e checklist (US-041)

- **Rotas:** PRC-08 `GET /processes/{id}/available-actions` e PRC-09 `GET /processes/{id}/checklist`
  (`ProcessActionsController`); `id` malformado → 400 `MALFORMED_REQUEST`; não visível → 404
  `NOT_FOUND` igual ao inexistente. Somente leitura (sem auditoria nem eventos).
- **Visibilidade (DEC-024):** `domain/process-visibility.ts` sobre `isProcessVisible`
  (`#shared/auth/process-access.js`) com o escopo de `PROCESS_VIEW` das permissões efetivas
  (US-097): `TENANT`, órgão do processo, unidades do escopo (subárvore/lotação) contra `ProcessAccess`
  de unidade ou concessão própria. Listagens (US-001+) usam `buildVisibilityPredicate`.
- **Quem consulta:** `ProcessViewerResolver` (permissões efetivas do contexto: escopo, lotações e
  chefias) alimenta a custódia (POL-01/04/05) do motor.
- **Autorização por processo (US-097):** `ProcessRuntimeAccessReader` registrado no
  `ProcessAccessRegistry` — `@RequirePermission(…, { scope: { processParam: 'id' } })` lê o órgão,
  as concessões e as participações (`runtime.access.participations`) do processo.
- **Runtime:** porta `PROCESS_RUNTIME_READER` (`application/ports.ts`) — processo, passagens,
  aprovações de etapa, documentos e concessões num ÚNICO snapshot. Em produção,
  `PendingProcessRuntimeReader` (404 sempre) até a US-001 criar o agregado e o leitor Prisma; testes e
  modo fake usam `InMemoryProcessRuntimeStore`.

# `process`

Processo, itens, participantes, etiquetas, runtime da tramitação e visibilidade (DEC-040).

## Painel situacional — ações e checklist (US-041)

- **Rotas:** PRC-08 `GET /processes/{id}/available-actions` e PRC-09 `GET /processes/{id}/checklist`
  (`ProcessActionsController`); `id` malformado → 400 `MALFORMED_REQUEST`; não visível → 404
  `NOT_FOUND` igual ao inexistente. Somente leitura (sem auditoria nem eventos).
- **Visibilidade (DEC-024):** `domain/process-visibility.ts` — ponte até as atribuições com escopo
  (US-096/097): `PROCESS_VIEW` de perfil `TENANT` vê tudo; os demais, pelas lotações
  (`IdentityFacade.departmentsOfUser`) contra `ProcessAccess` de unidade; concessão própria basta.
- **Quem consulta:** `ProcessViewerResolver` (perfis do contexto, lotações e chefias —
  `OrganizationFacade.departmentsHeadedBy`) alimenta a custódia (POL-01/04/05) do motor.
- **Runtime:** porta `PROCESS_RUNTIME_READER` (`application/ports.ts`) — processo, passagens,
  aprovações de etapa, documentos e concessões num ÚNICO snapshot. Em produção,
  `PendingProcessRuntimeReader` (404 sempre) até a US-001 criar o agregado e o leitor Prisma; testes e
  modo fake usam `InMemoryProcessRuntimeStore`.

# `risk`

Mapa de riscos e tratamentos (DEC-040 · DEC-021). Dono de `Risk` e `RiskTreatment`.

## US-033 — Registrar e avaliar riscos (RSK-01..05)

- `domain/risk.ts`: código `R01`… (maior já usado + 1, excluídos contam — RN-RISK-02), avaliação
  P × I com `assessRisk` de `@contrataflow/validation` (a mesma função da UI), `scaleSnapshot`
  (RN-RISK-04), reavaliação (`RiskAssessed` mesmo sem mudança de nível — FA-01), residual em par.
- `application/risk.support.ts`: `RiskGate` (POL-02 estendida pela `DocumentFacade` — trava o
  `RISK_MAP` no `tx`), `RiskScaleReader` (`risk.scale`/`risk.levelThresholds` sem cache — FA-02),
  `RiskReferences` (categoria `RISK_CATEGORY` ativa, usuário e unidade), `RiskPresenter`,
  `RiskChangeRecorder` (`risk.*` + `Risk*` → timeline `RISK_*` no mesmo `tx`).
- Numeração sob `pg_advisory_xact_lock('risk-code:<processId>')`; índice único como rede.
- `risk_treatments` nasce na migração da US-033 (cascata lógica da exclusão — RN-RISK-10).

## US-034 — Ações de tratamento (RSK-06..08)

- `domain/risk-treatment.ts`: `PLANNED` na criação, máquina de status de `@contrataflow/validation`
  (`canChangeTreatmentStatus` — a mesma do `TreatmentStatusSelect`), `completedAt` com o `DONE`
  (RN-RISK-12), `sortOrder` ao fim da lista; `domain/risk.ts#startTreatment` (RN-RISK-14).
- `application/risk-treatment.commands.ts`: a mesma `RiskGate` (RN-RISK-16 = RN-RISK-09) com as
  mensagens dos tratamentos (`writableRisk(…, 'treatments')`/`writableTreatment`); a transição do
  risco é um `UPDATE … WHERE status = 'OPEN'` (`markInTreatment`) no mesmo `tx` — sem 412 no POST.
- Leitura só pelos riscos (`Risk.treatments` completo em RSK-01/03); `RiskTreatmentChanged` sem
  timeline nem consumidor assíncrono; descrição e observações só com hash na auditoria.
- Fachada: `riskLabels` (fonte `RISK` da timeline).

## US-035 — Matriz e Mapa de Riscos (RSK-09/10)

- `domain/risk-map.ts`: matriz (`riskMatrixOf` = `buildRiskMatrix` de `@contrataflow/validation`,
  escala VIGENTE — RN-RISK-18), completude (`evaluateRiskMapCompleteness` — RN-RISK-21) e o
  snapshot da versão (`riskMapSnapshot` — RN-RISK-20: `risks`, `treatments`, `matrix`) sobre os
  DTOs do `RiskPresenter` (o que a tela mostra é o que a versão congela).
- `application/risk-map.validator.ts`: `RiskMapDocumentValidator` registrado no `document`
  (`onModuleInit`) — DOC-08/09/10/12 são os genéricos da US-065; pendência bloqueante = 422
  `DOCUMENT_INCOMPLETE` com os `violations[]` `RISK_*`.
- `application/risk-map.commands.ts`: RSK-10 por `createStructuredIn` (`allowCollaborators`, sem
  riscos → 422 `BUSINESS_RULE_VIOLATION` `RISK_LIST_EMPTY` depois da autorização).
- O bloqueio dos riscos após a conclusão (RN-RISK-23) já é o `RiskGate` da US-033.

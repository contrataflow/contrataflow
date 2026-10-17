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
- `risk_treatments` existe desde a US-033 só para a cascata lógica da exclusão (RN-RISK-10);
  o CRUD é da US-034.
- Fachada: `riskLabels` (fonte `RISK` da timeline).

# 3.18 Regras condicionais (`rules`) — MVP 2

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint) do MVP 2. Convenções, erros genéricos e de domínio: [api.md §1–§2](../api.md#1-convenções) (que herda o [api.md do MVP 1](../../mvp-01/api.md)). Épico(s): EP-031. Fonte de cada linha: a seção "API" da story citada — divergência entre este arquivo e a story é bug de especificação.

Biblioteca de regras reutilizáveis (`Rule`, `RuleVersion`) com versões, publicação e aposentadoria, uso nos workflows (referências com adoção de versão nova), cópia de modelos prontos, roteamento condicional, alçadas por valor sobre a política de decisão (EP-022), simulador e casos de teste. Tela: SCR-035 (Regras — evolui a ficha do MVP 1).

Legenda: **Idem.** = `Idempotency-Key`; **IM** = `If-Match` (com `ETag` na resposta); "—" = não se aplica. Escritas sem `If-Match` criam recurso novo ou são ações idempotentes por chave. Listas paginam com `page`/`pageSize` (≤ 100) e `sort`, salvo indicação na linha.

## Endpoints novos

| ID | Método | Rota | Permissão | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| APV-46 | GET | `/approvals/{id}/resolution` | `APPROVAL_VIEW` + POL-03 | — | — | US-198 |
| PRC-70 | GET | `/processes/{id}/routing` | `PROCESS_VIEW` | — | — | US-197 |
| PRC-71 | GET | `/processes/{id}/routing/preview` | `PROCESS_VIEW` | — | — | US-197, US-198 |
| RUL-01 | GET | `/rules` | `RULE_VIEW` | — | — | US-194, US-195, US-196, US-197, US-198 |
| RUL-02 | POST | `/rules` | `RULE_MANAGE` + POL-27 | Obrigatório | — | US-194 |
| RUL-03 | GET | `/rules/{id}` | `RULE_VIEW` | — | — | US-194, US-196 |
| RUL-04 | PATCH | `/rules/{id}` | `RULE_MANAGE` + POL-27 | — | Obrigatório | US-194 |
| RUL-05 | GET | `/rules/{id}/versions` | `RULE_VIEW` | — | — | US-194 |
| RUL-06 | POST | `/rules/{id}/versions` | `RULE_MANAGE` + POL-27 | Obrigatório | — | US-194 |
| RUL-07 | GET | `/rule-versions/{versionId}` | `RULE_VIEW` | — | — | US-194 |
| RUL-08 | PATCH | `/rule-versions/{versionId}` | `RULE_MANAGE` + POL-27 | — | Obrigatório | US-194 |
| RUL-09 | POST | `/rule-versions/{versionId}/publish` | `RULE_PUBLISH` + POL-27 | — | Obrigatório | US-194, US-200 |
| RUL-10 | POST | `/rule-versions/{versionId}/retire` | `RULE_PUBLISH` + POL-27 | — | Obrigatório | US-194 |
| RUL-11 | GET | `/rules/{id}/usages` | `RULE_VIEW` | — | — | US-195 |
| RUL-12 | POST | `/rules/{id}/copy` | `RULE_MANAGE` + POL-27 | Obrigatório | — | US-196 |
| RUL-13 | POST | `/rule-versions/{versionId}/simulate` | `RULE_MANAGE` + POL-27 | — | — | US-199 |
| RUL-14 | GET | `/rule-versions/{versionId}/test-cases` | `RULE_VIEW` | — | — | US-200 |
| RUL-15 | PUT | `/rule-versions/{versionId}/test-cases` | `RULE_MANAGE` | — | Obrigatório | US-200 |
| RUL-16 | POST | `/rule-versions/{versionId}/test-cases/run` | `RULE_MANAGE` | — | — | US-200 |
| WF-80 | GET | `/workflow-versions/{versionId}/rule-refs` | `WORKFLOW_VIEW` | — | — | US-195 |
| WF-81 | POST | `/workflow-versions/{versionId}/rule-refs/adopt` | `WORKFLOW_MANAGE` ou `RULE_VIEW` | — | Obrigatório | US-195 |
| WF-82 | PUT | `/workflow-stages/{stageId}/thresholds` | `WORKFLOW_MANAGE` ou `RULE_VIEW` | — | Obrigatório | US-198 |
| WF-83 | POST | `/workflow-stages/{stageId}/thresholds/preview` | `WORKFLOW_VIEW` ou `PROCESS_VIEW` ou `RULE_VIEW` | — | — | US-198 |

## Rotas do MVP 1 ampliadas

Mudanças **aditivas** (campos opcionais, enums ampliados, filtros novos) sobre contratos do MVP 1; o comportamento do MVP 1 vale sem os campos novos. O contrato original está no arquivo indicado da pasta `mvp-01/api/`.

| ID | Método | Rota (MVP 1) | Permissão (MVP 1) | Contrato original | Ampliado por |
|---|---|---|---|---|---|
| APV-02 | GET | `/approvals/{id}` | `APPROVAL_VIEW` ou designado | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-198 |
| PRC-01 | GET | `/processes` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-199 |
| PRC-08 | GET | `/processes/{id}/available-actions` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-197 |
| PRC-10 | GET | `/processes/{id}/stages` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-197 |
| PRC-19 | POST | `/processes/{id}/forward` | `PROCESS_FORWARD` + POL-01 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-197, US-198 |
| WF-11 | PATCH | `/workflow-stages/{stageId}` | `WORKFLOW_MANAGE` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-197 |
| WF-14 | PATCH | `/workflow-transitions/{transitionId}` | `WORKFLOW_MANAGE` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-197 |
| WF-16 | POST | `/workflow-versions/{versionId}/rules` | `WORKFLOW_MANAGE` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-195 |
| WF-17 | PATCH | `/workflow-rules/{ruleId}` | `WORKFLOW_MANAGE` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-195 |
| WF-19 | GET | `/rule-context/schema` | `WORKFLOW_VIEW` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-194, US-195, US-199, US-200 |
| WF-20 | POST | `/workflow-versions/{versionId}/validate` | `WORKFLOW_VIEW` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-195, US-197, US-198 |
| WF-21 | POST | `/workflow-versions/{versionId}/publish` | `WORKFLOW_PUBLISH` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-195, US-197, US-198 |

## Especificação por endpoint

### APV-46 — GET `/approvals/{id}/resolution`
**Permissão:** `APPROVAL_VIEW` + POL-03 · **Story:** US-198
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { hasThresholds, policy, policySource, policyRule?, lines: [{ sequence, resolvedSequence?, label, included, reason, rule? }], contextVersion, evaluatedAt } }` (sem valores)
- **Códigos:** 200, 403, 404

### PRC-70 — GET `/processes/{id}/routing`
**Permissão:** `PROCESS_VIEW` · **Story:** US-197
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { skippedStages: [{ processStageId, stageKey, stageName, skippedAt, rule: { ruleDefinitionId, key, label, versionNumber, ruleDefinitionVersionId, contextVersion }, reads, movementId }], conditionalTransitions: [{ transitionId, key, name, rule, currentResult }] } }`
- **Códigos:** 200, 403, 404

### PRC-71 — GET `/processes/{id}/routing/preview`
**Permissão:** `PROCESS_VIEW` · **Story:** US-197 (também citado por US-198)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** query `transitionId?`, `processStageId?`
- **Response:** `200 { data: { path: [{ stageKey, stageName, outcome: 'ACTIVE' | 'SKIPPED', ruleLabel? }], availableTransitions[] } }` (leitura pura)
- **Códigos:** 200, 403, 404, 422
- **Uso/ampliação em US-198:** request query `transitionId?`, `processStageId?` → response acrescenta `approvalResolution` (política e aprovadores) quando a próxima etapa tem alçada (campo aditivo da US-197) · códigos 200, 403, 404, 422

### RUL-01 — GET `/rules`
**Permissão:** `RULE_VIEW` · **Story:** US-194 (também citado por US-195, US-196, US-197, US-198)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** query `kind`, `tag`, `isActive`, `isSystem`, `hasPublishedVersion`, `q`, `page`, `pageSize`
- **Response:** `200 { data: RuleDefinition[], meta }` (resumo de versão vigente e rascunho)
- **Códigos:** 200, 401, 403
- **Uso/ampliação em US-195:** request filtros do seletor (US-194) → response lista de regras elegíveis · códigos 200, 403
- **Uso/ampliação em US-196:** request `isSystem = true` para a aba "Modelos" (demais filtros da US-194) → response lista de modelos · códigos 200, 403
- **Uso/ampliação em US-197:** request `kind = ROUTING`, `isActive = true`, `hasPublishedVersion = true`, `isSystem = false` → response regras elegíveis para o seletor · códigos 200, 403
- **Uso/ampliação em US-198:** request `kind = APPROVAL_THRESHOLD`, `isActive = true`, `hasPublishedVersion = true`, `isSystem = false` → response regras elegíveis para o seletor · códigos 200, 403

### RUL-02 — POST `/rules`
**Permissão:** `RULE_MANAGE` + POL-27 · **Story:** US-194
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ key, name, description?, kind, tags?, contextVersion?, expression?, severity?, message? }`; `Idempotency-Key`
- **Response:** `201 { data: RuleDefinition }` com `draftVersion` 1
- **Códigos:** 201, 403, 409, 422, 503

### RUL-03 — GET `/rules/{id}`
**Permissão:** `RULE_VIEW` · **Story:** US-194 (também citado por US-196)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: RuleDefinition }` + `ETag`
- **Códigos:** 200, 403, 404
- **Uso/ampliação em US-196:** request — → response modelo com `templateParameters`, `templateUsageHint` e `currentPublishedVersion` · códigos 200, 403, 404

### RUL-04 — PATCH `/rules/{id}`
**Permissão:** `RULE_MANAGE` + POL-27 · **Story:** US-194
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ name?, description?, tags?, isActive? }`; `If-Match`
- **Response:** `200 { data: RuleDefinition }` + `ETag` nova
- **Códigos:** 200, 403, 404, 409, 412, 422, 428

### RUL-05 — GET `/rules/{id}/versions`
**Permissão:** `RULE_VIEW` · **Story:** US-194
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** paginação
- **Response:** `200 { data: RuleDefinitionVersion[] }` por `versionNumber` decrescente, sem a expressão
- **Códigos:** 200, 403, 404

### RUL-06 — POST `/rules/{id}/versions`
**Permissão:** `RULE_MANAGE` + POL-27 · **Story:** US-194
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{}`; `Idempotency-Key`
- **Response:** `201 { data: RuleDefinitionVersion }` (rascunho copiado da vigente)
- **Códigos:** 201, 403, 404, 409, 503

### RUL-07 — GET `/rule-versions/{versionId}`
**Permissão:** `RULE_VIEW` · **Story:** US-194
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: RuleDefinitionVersion }` com `expression`, `testCases` e `validation`
- **Códigos:** 200, 403, 404

### RUL-08 — PATCH `/rule-versions/{versionId}`
**Permissão:** `RULE_MANAGE` + POL-27 · **Story:** US-194
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ contextVersion?, expression?, severity?, message?, changeNotes? }`; `If-Match`
- **Response:** `200 { data: RuleDefinitionVersion, validation: { errors[], warnings[] } }`
- **Códigos:** 200, 403, 404, 409, 412, 422, 428

### RUL-09 — POST `/rule-versions/{versionId}/publish`
**Permissão:** `RULE_PUBLISH` + POL-27 · **Story:** US-194 (também citado por US-200)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ changeNotes? }`; `If-Match`
- **Response:** `200 { data: RuleDefinitionVersion }` com `status = PUBLISHED`, `expressionHash`, `publishedAt`
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503
- **Uso/ampliação em US-200:** request `{ changeNotes? }`; `If-Match` → response `200 { data: RuleDefinitionVersion }`; recusas `422 RULE_TESTS_FAILING` (com `details.cases[]`) e `422 RULE_TESTS_REQUIRED` · códigos 200, 403, 404, 409, 412, 422, 428, 503

### RUL-10 — POST `/rule-versions/{versionId}/retire`
**Permissão:** `RULE_PUBLISH` + POL-27 · **Story:** US-194
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{}`; `If-Match`
- **Response:** `200 { data: RuleDefinitionVersion }` com `status = RETIRED`
- **Códigos:** 200, 403, 404, 409, 412, 428

### RUL-11 — GET `/rules/{id}/usages`
**Permissão:** `RULE_VIEW` · **Story:** US-195
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** query `versionId?`, `onlyCandidates?`, `page`, `pageSize`
- **Response:** `200 { data: [{ workflowId, workflowKey, workflowName, workflowVersionId, versionNumber, workflowVersionStatus, ruleDefinitionVersionId, ruleVersionNumber, useType, stageKey?, transitionKey?, adoptionCandidate }], meta, summary: { workflowsCount, byRuleVersion } }`
- **Códigos:** 200, 403, 404

### RUL-12 — POST `/rules/{id}/copy`
**Permissão:** `RULE_MANAGE` + POL-27 · **Story:** US-196
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ key, name, description?, tags?, parameters?: { limitValue?, severity? } }`; `Idempotency-Key`
- **Response:** `201 { data: RuleDefinition }` com `draftVersion` 1 e casos de teste
- **Códigos:** 201, 403, 404, 409, 422, 503

### RUL-13 — POST `/rule-versions/{versionId}/simulate`
**Permissão:** `RULE_MANAGE` + POL-27 · **Story:** US-199
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `{ source: 'HYPOTHETICAL' | 'PROCESS', processId?, context?, expression?, contextVersion?, trace? }`
- **Response:** `200 { data: { result, resultType, trace[], contextUsed, defaultedPaths[], warnings[], contextSource, contextVersion, versionStatus, versionEtag, usedOverride } }`
- **Códigos:** 200, 403, 404, 409, 422, 429, 503

### RUL-14 — GET `/rule-versions/{versionId}/test-cases`
**Permissão:** `RULE_VIEW` · **Story:** US-200
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { cases: RuleTestCase[], count, currentExpressionHash, testRunHash, lastRunGreen } }` + `ETag`
- **Códigos:** 200, 403, 404

### RUL-15 — PUT `/rule-versions/{versionId}/test-cases`
**Permissão:** `RULE_MANAGE` · **Story:** US-200
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ cases: [{ name, context, expected }] }`; `If-Match`
- **Response:** `200 { data: { cases, count, testRunHash: null } }` + `ETag` nova
- **Códigos:** 200, 403, 404, 409, 412, 422, 428

### RUL-16 — POST `/rule-versions/{versionId}/test-cases/run`
**Permissão:** `RULE_MANAGE` · **Story:** US-200
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `{}`
- **Response:** `200 { data: { results: [{ index, name, expected, obtained, passed, error? }], total, passed, failed, allPassed, currentExpressionHash, testRunHash } }`
- **Códigos:** 200, 403, 404, 503

### WF-80 — GET `/workflow-versions/{versionId}/rule-refs`
**Permissão:** `WORKFLOW_VIEW` · **Story:** US-195
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: [{ ruleDefinitionId, key, name, kind, ruleDefinitionVersionId, versionNumber, versionStatus, currentVersionId, currentVersionNumber, adoptable, usedIn[] }] }`
- **Códigos:** 200, 403, 404

### WF-81 — POST `/workflow-versions/{versionId}/rule-refs/adopt`
**Permissão:** `WORKFLOW_MANAGE` ou `RULE_VIEW` · **Story:** US-195
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ ruleDefinitionId, toRuleDefinitionVersionId? }`; `If-Match`
- **Response:** `200 { data: { changed, uses: [{ ruleId, from, to }], validation } }`
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503

### WF-82 — PUT `/workflow-stages/{stageId}/thresholds`
**Permissão:** `WORKFLOW_MANAGE` ou `RULE_VIEW` · **Story:** US-198
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ decisionPolicyRules: [{ when: RuleRef, policy, label? }], approverRules: [{ sequence, applicabilityRule: RuleRef | null }] }`; `If-Match`
- **Response:** `200 { data: { stageId, decisionPolicy, decisionPolicyRules, approverRules, validation } }` + `ETag`
- **Códigos:** 200, 403, 404, 409, 412, 422, 428

### WF-83 — POST `/workflow-stages/{stageId}/thresholds/preview`
**Permissão:** `WORKFLOW_VIEW` ou `PROCESS_VIEW` ou `RULE_VIEW` · **Story:** US-198
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `{ processId }` **ou** `{ context }`
- **Response:** `200 { data: { policy, policySource, policyRule?, lines: [{ sequence, label, approverType, included, reason, rule? }], warnings[], contextSource, defaultedPaths[] } }`
- **Códigos:** 200, 403, 404, 422

### APV-02 — GET `/approvals/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-198:** request — → response acrescenta `thresholdResolution` resumido (aditivo) · códigos 200, 403, 404

### PRC-01 — GET `/processes` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-199:** request `q` (≥ 2 caracteres) para a busca de processo → response processos visíveis ao usuário · códigos 200, 403

### PRC-08 — GET `/processes/{id}/available-actions` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-197:** request — → response ações sem as transições de condição falsa · códigos 200, 403, 404

### PRC-10 — GET `/processes/{id}/stages` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-197:** request — → response passagens incluindo `status = SKIPPED` e `skipRuleResult` resumido e mascarado · códigos 200, 403, 404

### PRC-19 — POST `/processes/{id}/forward` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-197:** request como no MVP 1; `Idempotency-Key` → response `200` com `skippedStages: [{ processStageId, stageKey, stageName, ruleLabel }]` (aditivo) · códigos 200, 403, 404, 409, 412, 422, 503
- **US-198:** request como no MVP 1 e US-133; `Idempotency-Key` → response aprovação criada com `decisionPolicy`, linhas e `thresholdResolution` (aditivo) · códigos 200, 403, 404, 409, 412, 422, 503

### WF-11 — PATCH `/workflow-stages/{stageId}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-197:** request como no MVP 1 + `applicabilityRule?: RuleRef (LIBRARY) | null`; `If-Match` → response `200 { data: WorkflowStage }` com `applicabilityRule` e `isLegallyRequired` · códigos 200, 403, 409, 412, 422, 428

### WF-14 — PATCH `/workflow-transitions/{transitionId}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-197:** request como no MVP 1 + `condition?: RuleRef (LIBRARY) | null`; `If-Match` → response `200 { data: WorkflowTransition }` · códigos 200, 403, 409, 412, 422, 428

### WF-16 — POST `/workflow-versions/{versionId}/rules` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-195:** request como no MVP 1 + `ruleDefinitionVersionId?` (com `type = CONDITION`, sem `config`/`severity`/`message`) → response `201 { data: WorkflowRule }` com `ruleSource` e `contextVersion` · códigos 201, 403, 404, 409, 422, 503

### WF-17 — PATCH `/workflow-rules/{ruleId}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-195:** request como no MVP 1 + troca de `ruleDefinitionVersionId`; `If-Match` → response `200 { data: WorkflowRule }` · códigos 200, 403, 409, 412, 422, 428

### WF-19 — GET `/rule-context/schema` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-194:** request query `version` (1 ou 2, padrão 1) → response `200 { data: { version, fields: [{ path, label, type, confidential, default }] } }` (aditivo; `RULE_VIEW` também autoriza) · códigos 200, 403
- **US-195:** request query `version` (1 ou 2) → response campos do contexto da versão pedida (ver US-194) · códigos 200, 403
- **US-199:** request query `version` (1 ou 2) → response campos com `path`, `label`, `type`, `default`, `options?`, `confidential` (aditivo) · códigos 200, 403
- **US-200:** request query `version` → response campos para montar o contexto do caso (US-199) · códigos 200, 403

### WF-20 — POST `/workflow-versions/{versionId}/validate` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-195:** request — → response `errors[]`/`warnings[]` com `WF_RULE_REF_INVALID` e `WF_RULE_REF_INACTIVE` (campo `details.reason`) · códigos 200, 404
- **US-197:** request — → response `errors[]`/`warnings[]` com os códigos de roteamento (RN-RULE-66) · códigos 200, 404
- **US-198:** request — → response `errors[]`/`warnings[]` com `WF_APPROVERS_INVALID` e `WF_RULE_REF_INVALID` · códigos 200, 404

### WF-21 — POST `/workflow-versions/{versionId}/publish` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-195:** request `{ changeNotes? }`; `If-Match` → response `200 { data: WorkflowVersion }` com `ruleRefs` · códigos 200, 403, 404, 409, 412, 422, 428, 503
- **US-197:** request `{ changeNotes? }`; `If-Match` → response `200 { data: WorkflowVersion }` · códigos 200, 403, 404, 409, 412, 422, 428, 503
- **US-198:** request `{ changeNotes? }`; `If-Match` → response `200 { data: WorkflowVersion }` com `ruleRefs` · códigos 200, 403, 404, 409, 412, 422, 428, 503

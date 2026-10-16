# Riscos (`risk`)

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| RSK-01 | GET | `/processes/{id}/risks` | `PROCESS_VIEW` | US-033 |
| RSK-02 | POST | `/processes/{id}/risks` | `RISK_MANAGE` + POL-02 | US-033 |
| RSK-03 | GET | `/risks/{id}` | `PROCESS_VIEW` | US-033 |
| RSK-04 | PATCH | `/risks/{id}` | `RISK_MANAGE` + POL-02 | US-033 |
| RSK-05 | DELETE | `/risks/{id}` | `RISK_MANAGE` + POL-02 | US-033 |
| RSK-06 | POST | `/risks/{id}/treatments` | `RISK_MANAGE` + POL-02 | US-034 |
| RSK-07 | PATCH | `/risk-treatments/{treatmentId}` | `RISK_MANAGE` + POL-02 | US-034 |
| RSK-08 | DELETE | `/risk-treatments/{treatmentId}` | `RISK_MANAGE` + POL-02 | US-034 |
| RSK-09 | GET | `/processes/{id}/risk-matrix` | `PROCESS_VIEW` | US-035 |
| RSK-10 | POST | `/processes/{id}/risk-map` | `RISK_MANAGE` + POL-02 | US-035 |
| RSK-11 | POST | `/processes/{id}/risks/ai-apply` | `RISK_MANAGE` + POL-02 (solicitante da geração) | US-119 |
| RSK-12 | POST | `/processes/{id}/risks/ai-review` | `RISK_MANAGE` + POL-02 | US-119 |

Edição de riscos e tratamentos (POL-02) considera o documento `RISK_MAP`: se existir e estiver em `FINALIZED`/`APPROVED`/`IN_REVIEW`, ficam bloqueados até reabertura (RN-RISK-09/16); sem documento, são editáveis sob custódia. Submissão/finalização/reabertura do Mapa de Riscos usam os endpoints genéricos de documento (`DOC-08`/`DOC-09`/`DOC-10`/`DOC-12`, fora deste arquivo).

---

### RSK-01 — Listar riscos do processo
`GET /api/v1/processes/{id}/risks` · **Permissão:** `PROCESS_VIEW` · **Story:** US-033

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório); query: filtros `phase`, `categoryId`, `status` (api.md §1.2) — sem campo de ordenação documentado
- **Request:** —
- **Response:** `200 { data: Risk[] }`
```ts
Risk {
  id: string; code: string; title: string; description?: string; categoryId: string;
  phase: string; cause: string; consequence: string; probability: number; impact: number;
  ownerId?: string; ownerDepartmentId?: string; residualProbability?: number; residualImpact?: number;
  score: number; level: string; scaleSnapshot: object; status: string; version: number;
}
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Processo inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** —

### RSK-02 — Registrar risco
`POST /api/v1/processes/{id}/risks` · **Permissão:** `RISK_MANAGE` + POL-02 · **Story:** US-033

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — processo
- **Request:**
```ts
{
  title: string;              // 3–200
  description?: string;       // ≤2000
  categoryId: string;         // catálogo RISK_CATEGORY, ativo (RN-RISK-05)
  phase: string;               // RiskPhase; padrão PLANNING
  cause: string;                // 10–1000
  consequence: string;          // 10–1000
  probability: number;          // 1..risk.scale.max (RN-RISK-03)
  impact: number;                // 1..risk.scale.max (RN-RISK-03)
  ownerId?: string;              // RN-RISK-06
  ownerDepartmentId?: string;    // ativa; RN-RISK-06
}
```
- **Response:** `201 { data: Risk }` com `code`, `score`, `level`, `version`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Escopo de `RISK_MANAGE` não cobre o processo |
| 409 | `INVALID_PROCESS_STATUS` | Processo fora de `DRAFT`/`IN_PROGRESS`/`RETURNED` |
| 422 | `VALIDATION_ERROR` | Campo obrigatório ausente; limites de tamanho; `probability`/`impact` fora de `[1, max]` (`OUT_OF_RANGE`); `categoryId`/`ownerId`/`ownerDepartmentId` inválido (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave, corpo diferente |

- **Efeitos:** Eventos: `RiskCreated` (`risk.created`) — `riskId`, `code`, `level`, `phase`, `categoryCode`. Auditoria: `risk.create` (`DATA_CHANGE`) — `changes`: categoria, fase, probabilidade, impacto; `metadata`: `code`, `level`. Timeline: entrada correspondente ao evento.
- **Notas:** bloqueado (`DOCUMENT_NOT_EDITABLE`) se o documento `RISK_MAP` existir e estiver em `FINALIZED`/`APPROVED`/`IN_REVIEW` (RN-RISK-09).

### RSK-03 — Obter risco
`GET /api/v1/risks/{id}` · **Permissão:** `PROCESS_VIEW` · **Story:** US-033

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: Risk }` (inclui tratamentos — US-034)
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** —

### RSK-04 — Atualizar/avaliar risco
`PATCH /api/v1/risks/{id}` · **Permissão:** `RISK_MANAGE` + POL-02 · **Story:** US-033

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** campos parciais de RSK-02, mais:
```ts
{
  residualProbability?: number; // RN-RISK-08
  residualImpact?: number;      // RN-RISK-08
}
```
- **Response:** `200 { data: Risk }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão/escopo |
| 409 | `DOCUMENT_NOT_EDITABLE` | Mapa de Riscos bloqueou edição |
| 409 | `INVALID_PROCESS_STATUS` | Processo fora de status editável |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | Ver RSK-02 |

- **Efeitos:** Eventos: `RiskAssessed` (`risk.assessed`), quando `probability` e/ou `impact` mudam — `riskId`, `fromLevel`, `toLevel`, `score` (mesmo sem mudança de nível). Auditoria: `risk.assess` (`DATA_CHANGE`) quando altera probabilidade/impacto (`changes`: `fromScore`/`toScore`, `fromLevel`/`toLevel`) ou `risk.update` nos demais casos.
- **Notas:** —

### RSK-05 — Excluir risco
`DELETE /api/v1/risks/{id}` · **Permissão:** `RISK_MANAGE` + POL-02 · **Story:** US-033

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `204` sem corpo
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão/escopo |
| 409 | `DOCUMENT_NOT_EDITABLE` | Mapa de Riscos bloqueou edição |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `RiskDeleted` (`risk.deleted`) — `riskId`, `code`. Auditoria: `risk.delete` (`DATA_CHANGE`) — `metadata`: `code`, quantidade de tratamentos removidos.
- **Notas:** exclusão remove também os tratamentos vinculados (RSK-06/07/08).

### RSK-06 — Criar ação de tratamento
`POST /api/v1/risks/{id}/treatments` · **Permissão:** `RISK_MANAGE` + POL-02 · **Story:** US-034

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — risco
- **Request:**
```ts
{
  type: "PREVENTIVE" | "CONTINGENCY"; // TreatmentType
  description: string;                 // 10–1000
  responsibleId?: string;               // RN-RISK-13
  responsibleDepartmentId?: string;     // ativa; RN-RISK-13
  dueDate?: string;                     // sem restrição de passado (FA-03)
  notes?: string;                       // ≤1000
}
```
- **Response:** `201 { data: RiskTreatment }` com `status` padrão `PLANNED`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Escopo de `RISK_MANAGE` não cobre o processo |
| 422 | `VALIDATION_ERROR` | Campo obrigatório ausente; limites de tamanho; `responsibleId`/`responsibleDepartmentId` inválido (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |

- **Efeitos:** Eventos: `RiskTreatmentChanged` (`risk.treatment_changed`), `change = CREATED` — `riskId`, `treatmentId`, `status`. Auditoria: `risk.treatment_create` (`DATA_CHANGE`) — `metadata`: `riskId`, `type`.
- **Notas:** bloqueado (`DOCUMENT_NOT_EDITABLE`) quando o Mapa de Riscos foi concluído (RN-RISK-16); evento sem projeção automática em timeline/notificação (consumo interno do módulo `risk`).

### RSK-07 — Atualizar ação de tratamento
`PATCH /api/v1/risk-treatments/{treatmentId}` · **Permissão:** `RISK_MANAGE` + POL-02 · **Story:** US-034

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `treatmentId` (path, uuid, obrigatório)
- **Request:** campos parciais de RSK-06, mais `status?: string` (`TreatmentStatus`; RN-RISK-15)
- **Response:** `200 { data: RiskTreatment }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão/escopo |
| 409 | `INVALID_STATE` | Transição de status não permitida (RN-RISK-15) |
| 409 | `DOCUMENT_NOT_EDITABLE` | Tratamento bloqueado (RN-RISK-16) |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | Ver RSK-06 |

- **Efeitos:** Eventos: `RiskTreatmentChanged` (`risk.treatment_changed`), `change = UPDATED`/`STATUS_CHANGED`. Auditoria: `risk.treatment_update` (`DATA_CHANGE`) — `changes`: campos alterados, `fromStatus`/`toStatus` quando aplicável.
- **Notas:** `completedAt` é gerado pelo sistema ao concluir (RN-RISK-12).

### RSK-08 — Excluir ação de tratamento
`DELETE /api/v1/risk-treatments/{treatmentId}` · **Permissão:** `RISK_MANAGE` + POL-02 · **Story:** US-034

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `treatmentId` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `204` sem corpo
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão/escopo |
| 409 | `DOCUMENT_NOT_EDITABLE` | Tratamento bloqueado |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `RiskTreatmentChanged` (`risk.treatment_changed`), `change = DELETED`. Auditoria: `risk.treatment_delete` (`DATA_CHANGE`) — `metadata.riskId`.
- **Notas:** —

### RSK-09 — Obter matriz de riscos
`GET /api/v1/processes/{id}/risk-matrix` · **Permissão:** `PROCESS_VIEW` · **Story:** US-035

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório); query: `phase`, `categoryId`, `status` (filtros não persistidos, api.md §1.2)
- **Request:** —
- **Response:** `200 { data: { scale: object, levelThresholds: object, cells: Array<{ probability: number, impact: number, score: number, level: string, risks: Array<{ id: string, code: string, title: string }> }> } }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Processo inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** —

### RSK-10 — Emitir Mapa de Riscos
`POST /api/v1/processes/{id}/risk-map` · **Permissão:** `RISK_MANAGE` + POL-02 · **Story:** US-035

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** `{}` (sem campos; usa os riscos vigentes)
- **Response:** `201 { data: Document }` com `title` padrão "Mapa de Riscos", `status` inicial `DRAFT`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Falta `RISK_MAP_SUBMIT`/`RISK_MANAGE` |
| 409 | `DOCUMENT_ALREADY_EXISTS` | Já existe `RISK_MAP` ativo no processo |
| 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | Tipo não permitido na etapa atual |
| 422 | `BUSINESS_RULE_VIOLATION` (`RISK_LIST_EMPTY`) | Nenhum risco registrado |
| 422 | `BUSINESS_RULE_VIOLATION` (`RISK_TREATMENT_REQUIRED_FOR_LEVEL`) | Risco Alto/Extremo sem tratamento ativo |

- **Efeitos:** Eventos: `DocumentCreated` (`document.created.risk_map`) — `documentId`, `documentTypeCode = RISK_MAP`, `kind = STRUCTURED`. Auditoria: `document.create` (`DATA_CHANGE`) — `metadata.documentTypeCode = RISK_MAP`. Timeline: `DOCUMENT_CREATED`.
- **Notas:** submissão/finalização/reabertura usam `DOC-08`/`DOC-09`/`DOC-10`/`DOC-12` (fora deste arquivo), que emitem `DocumentVersionCreated`, `DocumentSubmitted`, `DocumentFinalized`, `DocumentReopened`, todos com projeção na timeline.

### RSK-11 — Aplicar riscos propostos pela IA
`POST /api/v1/processes/{id}/risks/ai-apply` · **Permissão:** `RISK_MANAGE` + POL-02 · só o solicitante da geração (RN-AI-13) · **Story:** US-119

- **Cabeçalhos:** `Idempotency-Key` obrigatório
- **Parâmetros:** `id` (path, uuid) — processo
- **Request:**
```ts
{
  generationId: string;                                  // AiGeneration RISK_MAP SUCCEEDED deste processo
  risks: Array<{ proposalKey: string; treatments: string[] /* proposalKeys dos tratamentos escolhidos */ }>;  // ≥ 1
}
```
- **Response:** `201 { data: { risks: Risk[] /* com treatments */ } }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | Sem `RISK_MANAGE` / POL-02 |
| 403 | `AI_GENERATION_NOT_OWNED` | Usuário não é o solicitante |
| 404 | `NOT_FOUND` / `AI_GENERATION_NOT_FOUND` | Processo ou geração inexistente/de outro tenant |
| 409 | `DOCUMENT_NOT_EDITABLE` | `RISK_MAP` em `FINALIZED`/`APPROVED`/`IN_REVIEW` (riscos bloqueados até reabertura) |
| 409 | `AI_GENERATION_NOT_APPLICABLE` | Geração não `SUCCEEDED`, expirada ou de outro processo/alvo |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | Requisição idêntica em processamento |
| 422 | `VALIDATION_ERROR` | `risks` vazio; `proposalKey` inexistente na proposta (`NOT_ALLOWED`); categoria inativa (`REFERENCE_INACTIVE`) |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave, corpo diferente |

- **Efeitos:** numa transação:
  - cria cada `Risk` com código sequencial, `score`/`level` pelas faixas vigentes, `scaleSnapshot` e `aiGenerationId`;
  - cria os `RiskTreatment` escolhidos com `aiGenerationId`, `status = PLANNED` e `dueDate`/responsáveis nulos;
  - a geração vira `APPLIED` (`appliedTargets.riskIds`);
  - auditoria `risk.create` por risco, `risk.treatment_create` por tratamento e `ai.content_apply`;
  - eventos `RiskCreated` por risco (timeline `RISK_ADDED`), `RiskTreatmentChanged` (`CREATED`) por tratamento e `AiContentApplied` (`document.ai_content_applied.risk_map`) → timeline `AI_CONTENT_APPLIED`.
- **Notas:** a proposta do `RISK_MAP` tem duas partes, riscos (este endpoint) e seções narrativas (DOC-26). Cada parte é aplicada uma única vez; a geração vai a `APPLIED` na primeira aplicação e aceita a outra parte enquanto não expirar (`appliedTargets` acumula). Riscos criados ficam "gerado por IA" até RSK-12 (RN-AI-42); seus textos podem conter o marcador literal "[a confirmar: …]".

### RSK-12 — Marcar riscos gerados por IA como revisados
`POST /api/v1/processes/{id}/risks/ai-review` · **Permissão:** `RISK_MANAGE` + POL-02 · **Story:** US-119

- **Cabeçalhos:** — (concorrência por risco, no corpo)
- **Parâmetros:** `id` (path, uuid) — processo
- **Request:** `{ riskIds: string[] /* ≥ 1 */, expectedVersions: Record<string, number> }`
- **Response:** `200 { data: { risks: Risk[], reviewedRiskIds: string[] } }`. Riscos sem `aiGenerationId` ou já revisados são ignorados (idempotente).
- **Erros:** 403 `PERMISSION_DENIED`/`NOT_PROCESS_CUSTODIAN` · 404 `NOT_FOUND` · 409 `DOCUMENT_NOT_EDITABLE` (mapa bloqueado) · 412 `VERSION_CONFLICT` (versão divergente; `meta.current`) · 422 `VALIDATION_ERROR` (lista vazia; risco de outro processo — `REFERENCE_NOT_FOUND`)
- **Efeitos:** `aiReviewedAt`/`aiReviewedById` e `version + 1` em cada risco; auditoria `ai.content_review`; evento `AiContentReviewed` (`document.ai_content_reviewed.risk_map`) → timeline `AI_CONTENT_REVIEWED`.
- **Notas:** a validação do `RISK_MAP` (DOC-08) acrescenta `RISK_AI_REVIEW_PENDING` e `RISK_PLACEHOLDER_PENDING` (texto com "[a confirmar"), bloqueantes (RN-AI-42).

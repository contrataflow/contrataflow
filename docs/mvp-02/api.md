# MVP 2 — API REST (`/api/v1`)

> **Documento canônico** do contrato da API do MVP 2 "Governança e Controle". Estende, sem quebrar, o [api.md do MVP 1](../mvp-01/api.md): mesma base `/api/v1`, mesmas convenções e erros genéricos. Base: [DEC-192 a DEC-210](../architecture/decisions.md), [permissions.md](permissions.md), [events.md](events.md), [entities.md](entities.md) e a seção "API" de cada story (US-123 a US-200).
> As seções 1–3 são normativas. A seção 4 aponta para o detalhe por módulo em [`api/`](api/); a seção 5 consolida as mudanças em contratos do MVP 1. O OpenAPI 3.1 gerado dos schemas Zod deve refletir este documento — divergências são bugs. Versão 1, revisável depois do UAT do MVP 1 (DEC-192).

Sumário: [1. Convenções](#1-convenções) · [2. Erros](#2-erros) · [3. Catálogo de endpoints](#3-catálogo-de-endpoints) · [4. Especificação por endpoint](#4-especificação-por-endpoint) · [5. Mudanças em contratos do MVP 1](#5-mudanças-em-contratos-do-mvp-1) · [6. Rotas fora da API pública](#6-rotas-fora-da-api-pública) · [7. Verificação](#7-verificação)

---

## 1. Convenções

Valem integralmente as convenções do [MVP 1 §1](../mvp-01/api.md#1-convenções) (base, formato, cabeçalhos, paginação, ordenação, filtros, busca, `ETag`/`If-Match`, `Idempotency-Key`, valores sigilosos, `meta.allowedActions`, limites). O MVP 2 acrescenta:

1. **Sem nova versão de API.** Todas as rotas novas entram em `/api/v1`; toda mudança em rota do MVP 1 é aditiva (§5). Uma quebra exigiria `/api/v2` e uma DEC própria — nenhuma story do MVP 2 pede isso.
2. **Códigos de operação.** Cada endpoint tem um código `PREFIXO-NN`. Prefixos novos: `PCA` (PCA), `BUD` (dotação), `LGL` (jurídico), `ICT` (Controle Interno), `TND` (edital), `ANL` (relatórios), `SLA` (políticas de SLA), `NTR` (regras de notificação), `RUL` (biblioteca de regras), `GOV` (gov.br) e `SPA` (acesso de suporte visto pelo órgão). Rotas novas de módulos do MVP 1 **continuam** a numeração do prefixo existente (`WF-24+`, `PRC-39+`, `APV-06+`, `PLT-09+`, `TPL-14+`, `ROL-13`). Lacunas na numeração são intencionais (faixas reservadas por story).
3. **Escopo de tenant.** Rotas `/platform/*` têm `x-tenant-scope = PLATFORM`: só operador da plataforma com MFA, sem `X-Tenant-Id`, sem dado de processo ou documento na resposta (DEC-208). Rotas `/internal/*` (resolução do gov.br pelo Authentik) usam credencial de serviço em rede privada e ficam fora do OpenAPI público (§6). Todas as demais são `TENANT`, como no MVP 1.
4. **Concorrência.** `If-Match` obrigatório nas escritas sobre recurso versionado (`412 VERSION_CONFLICT`, `428 PRECONDITION_REQUIRED`). Na aprovação múltipla, a decisão confere a versão da **linha** do aprovador (`ApprovalApprover`), não só a da aprovação, para que decisões em paralelo de linhas diferentes não gerem `412` indevido (US-134). Ações de estado com efeito único (concluir parecer, executar migração, confirmar dotação, publicar regra) exigem `If-Match` **e** `Idempotency-Key`.
5. **Trabalho assíncrono.** Importação do PCA, simulação e execução de migração, exportações (PCA, relatórios, itens de migração) e gerações de IA respondem `202 Accepted` com o recurso do pedido (`status` `PENDING`/`PROCESSING`/`READY`/`FAILED`) e `Location`; o cliente consulta o pedido. Arquivos gerados são `Attachment` com expiração (24 h nas exportações de relatório) e download auditado.
6. **Read model.** As rotas `ANL-*` leem só o read model de indicadores (DEC-206, [ADR-014](../adr/adr-014-indicators-read-model.md)), nunca `ProcessStage`/`ProcessMovement`; toda resposta traz `meta.dataAsOf` (instante da última projeção) e respeita POL-28 (escopo e sigilo).
7. **IA.** `AI-01` aceita `targetModule` `LEGAL_OPINION` e `TENDER` (geradores `draft.legal_opinion` e `draft.tender`, DEC-202); princípios do EP-020 inalterados (nada inventado, `[a confirmar]`, revisão humana, limites por órgão — DEC-203).
8. **Valores sigilosos.** POL-09 vale para dotação (`BUD-*`), itens do PCA vinculados a processo sigiloso, edital e relatórios (somas sem os processos sigilosos para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — POL-28).
9. **Auditoria de acesso negado.** Como no MVP 1: `403` grava `access.denied`; recurso invisível ou de outro tenant responde `404` sem revelar existência. Nas rotas `PLATFORM`, a auditoria é a de plataforma.

## 2. Erros

O formato `application/problem+json`, os códigos genéricos (§2.1), os códigos por campo (§2.1.1), as violações (§2.1.2) e os códigos de domínio do MVP 1 (§2.2) continuam valendo — ver [MVP 1 §2](../mvp-01/api.md#2-erros). Abaixo, só os **códigos de domínio novos** do MVP 2, extraídos das seções "Casos de erro" e "API" das stories (a mensagem pt-BR e o comportamento da UI estão na story citada). `VALIDATION_ERROR` com `errors[].code` novo (ex.: `CLASSIFICATION_MISMATCH`) não aparece aqui: segue o §2.1.1 do MVP 1.

### 2.1 Workflow v2 (EP-021)
| Código | HTTP | Quando | Story |
|---|---|---|---|
| `BRANCH_CANCELLATION_NOT_CONFIRMED` | 422 | Cancelamento de ramos não confirmado | US-124 |
| `MIGRATION_ALREADY_RUNNING` | 409 | Outra migração em execução | US-128 |
| `MIGRATION_COMPLETED_NOT_ALLOWED` | 422 | `COMPLETED` fora da continuação | US-126 |
| `MIGRATION_CONTINUATION_ALREADY_OPEN` | 409 | Plano de continuação já aberto | US-131 |
| `MIGRATION_CONTINUATION_TARGET_INVALID` | 422 | Destino sem `DOTACAO` ou não publicado | US-131 |
| `MIGRATION_DECISIONS_PENDING` | 422 | Decisões pendentes | US-128 |
| `MIGRATION_DISCARD_NOT_CONFIRMED` | 422 | Descarte da simulação não confirmado | US-126, US-127 |
| `MIGRATION_FILTER_INVALID` | 422 | Filtro inválido | US-126 |
| `MIGRATION_ITEM_BLOCKED` | 422 | Item bloqueado | US-127 |
| `MIGRATION_MAPPING_INVALID` | 422 | Mapa inválido | US-126 |
| `MIGRATION_NOTHING_TO_MIGRATE` | 422 | Nada a migrar | US-128 |
| `MIGRATION_NOT_CANCELABLE` | 409 | Plano não cancelável | US-126, US-128 |
| `MIGRATION_NOT_EDITABLE` | 409 | Plano não editável | US-126, US-127, US-128, US-131 |
| `MIGRATION_NOT_SIMULATED` | 409 | Decisão sem simulação | US-127, US-128 |
| `MIGRATION_NO_ELIGIBLE_PROCESSES` | 422 | Sem processos elegíveis | US-131 |
| `MIGRATION_NO_PROCESSES` | 422 | Filtro sem processos | US-127 |
| `MIGRATION_SIMULATION_STALE` | 409 | Simulação mudou | US-128 |
| `MIGRATION_TARGET_INVALID` | 422 | Destino inválido/em ramo | US-127 |
| `MIGRATION_TARGET_IN_BRANCH` | 422 | Destino dentro de ramo | US-126 |
| `MIGRATION_TARGET_NOT_PUBLISHED` | 409 | Destino não publicado | US-128 |
| `MIGRATION_TOO_MANY_PROCESSES` | 422 | Processos demais | US-127 |
| `MIGRATION_VERSIONS_INVALID` | 422 | Versões inválidas | US-126 |
| `PROCESS_STAGE_INVALID` | 422 | Etapa informada inválida | US-124 |
| `PROCESS_STAGE_REQUIRED` | 422 | Ramo não informado com várias etapas ativas | US-124, US-197 |
| `SEED_OFFER_NOT_AVAILABLE` | 409 | Sem oferta para adotar/dispensar | US-130 |

### 2.2 Aprovação múltipla (EP-022)
| Código | HTTP | Quando | Story |
|---|---|---|---|
| `APPROVAL_LINE_NOT_PENDING` | 409 | Linha já decidida, pulada ou cancelada | US-134, US-135 |
| `APPROVAL_LINE_REQUIRED` | 422 | APV-05 em aprovação com várias linhas | US-135 |
| `APPROVER_ALREADY_VOTED` | 409 | Pessoa já votou nesta aprovação | US-134 |
| `APPROVER_DUPLICATED` | 422 | Mesma pessoa em duas linhas | US-133, US-135 |
| `DOCUMENT_APPROVAL_POLICY_INVALID` | 422 | Política do tipo de documento inválida | US-132 |

### 2.3 PCA (EP-023)
| Código | HTTP | Quando | Story |
|---|---|---|---|
| `PCA_ALREADY_EXISTS` | 409 | Plano do exercício já existe | US-138 |
| `PCA_APPROVED_PLAN_EXISTS` | 409 | Já existe plano aprovado do exercício | US-140 |
| `PCA_ENTRY_ALREADY_RESOLVED` | 409 | Pendência já tratada | US-143 |
| `PCA_EXPORT_IN_PROGRESS` | 409 | Exportação já em andamento | US-145 |
| `PCA_EXPORT_NOT_READY` | 409 | Arquivo ainda não pronto | US-145 |
| `PCA_IMPORT_IN_PROGRESS` | 409 | Importação ativa no plano | US-139 |
| `PCA_INCOMPLETE` | 422 | Plano incompleto | US-140 |
| `PCA_ITEM_BALANCE_EXCEEDED` | 422 | Saldo excedido (`BLOCKING`) | US-142 |
| `PCA_ITEM_CODE_DUPLICATED` | 409 | Código de item repetido | US-138 |
| `PCA_ITEM_IN_USE` | 409 | Item em uso | US-138, US-141, US-144 |
| `PCA_ITEM_NOT_ELIGIBLE` | 422 | Plano não aprovado, substituído, item cancelado, exercício fora | US-142, US-143 |
| `PCA_NOT_APPROVED` | 409 | Plano não aprovado | US-143 |
| `PCA_NOT_EDITABLE` | 409 | Plano fora de `DRAFT` | US-138, US-139, US-140, US-141, US-144 |
| `PCA_RECONCILIATION_ENTRY_NOT_FOUND` | 404 | Pendência inexistente, de outro tenant ou invisível | US-143 |
| `PCA_RECONCILIATION_IN_PROGRESS` | 409 | Execução em andamento | US-143 |
| `PCA_REVISION_ALREADY_OPEN` | 409 | Revisão já aberta | US-141 |
| `PCA_REVISION_LINKED_ITEMS` | 422 | Revisão deixa vínculo ativo sem destino | US-141 |
| `PCA_SELF_APPROVAL_FORBIDDEN` | 403 | Quem enviou tenta decidir | US-140, US-141 |
| `PCA_TARGET_CHANGED` | 409 | Alvo mudou | US-143 |

### 2.4 Dotação orçamentária (EP-024)
| Código | HTTP | Quando | Story |
|---|---|---|---|
| `BUDGET_ALLOCATION_DUPLICATED` | 409 | Classificação duplicada no processo | US-146 |
| `BUDGET_ALLOCATION_NOT_EDITABLE` | 409 | Dotação não está em rascunho | US-146, US-147 |
| `BUDGET_EVIDENCE_REQUIRED` | 422 | Número, data ou evidência ausente | US-147 |
| `BUDGET_RESERVATION_DUPLICATED` | 409 | Reserva duplicada no exercício | US-147 |

### 2.5 Jurídico (EP-025)
| Código | HTTP | Quando | Story |
|---|---|---|---|
| `CONCLUSION_SUMMARY_CONFIDENTIAL` | 422 | Ementa com valor sigiloso | US-155 |
| `DOCUMENT_DRAFT_RESTRICTED` | 403 | Rascunho restrito | US-154, US-161 |
| `LEGAL_DILIGENCE_ALREADY_ANSWERED` | 409 | Diligência já retomada | US-153 |
| `LEGAL_DILIGENCE_NOT_FOUND` | 404 | Diligência inexistente ou de outro tenant | US-153 |
| `LEGAL_OPINION_NOT_FINALIZED` | 422 | Parecer não finalizado | US-155 |
| `LEGAL_RESERVATION_DUPLICATE` | 409 | Ressalva duplicada | US-154 |
| `LEGAL_RESERVATION_INCONSISTENT` | 422 | Ressalva aberta com favorável | US-155 |
| `LEGAL_RESERVATION_NOT_FOUND` | 404 | Ressalva inexistente ou de outro tenant | US-154 |
| `LEGAL_RESERVATION_NOT_OPEN` | 409 | Ressalva já resolvida | US-154 |
| `LEGAL_RESERVATION_REQUIRED` | 422 | Ressalva obrigatória ausente | US-155 |
| `LEGAL_REVIEW_ASSIGNEE_SEGREGATED` | 422 | Procurador em conflito de segregação | US-150 |
| `LEGAL_REVIEW_INVALID_STATE` | 409 | Análise fora de `PENDING`/`IN_REVIEW`, ou remoção em `IN_REVIEW` | US-150, US-152, US-153, US-154, US-156, US-157 |
| `LEGAL_REVIEW_NOTHING_TO_ANALYZE` | 422 | Nada para analisar | US-152 |
| `LEGAL_REVIEW_NOT_FOUND` | 404 | Análise inexistente, de outro tenant ou de processo invisível | US-149, US-150, US-152, US-153, US-154, US-156 |
| `LEGAL_REVIEW_SEGREGATION` | 403 | Segregação | US-152, US-153, US-154, US-155, US-156, US-157 |
| `LEGAL_TEXT_CONFIDENTIAL` | 422 | Texto com valor sigiloso | US-153, US-154, US-156 |
| `LEGAL_WAIVER_HYPOTHESIS_ACTIVE` | 409 | Condições de hipótese ativa | US-151 |
| `LEGAL_WAIVER_HYPOTHESIS_IN_USE` | 409 | Condições de hipótese já usada | US-151 |
| `LEGAL_WAIVER_HYPOTHESIS_NOT_FOUND` | 404 | Hipótese inexistente ou de outro tenant | US-151 |
| `LEGAL_WAIVER_NOT_APPLICABLE` | 422 | Hipótese não aplicável | US-156 |
| `NOT_LEGAL_REVIEW_ASSIGNEE` | 403 | Não é o designado | US-152, US-153, US-154, US-155, US-156 |

### 2.6 Controle Interno (EP-026)
| Código | HTTP | Quando | Story |
|---|---|---|---|
| `FINDING_NOT_OPEN` | 409 | Achado já resolvido | US-160, US-162 |
| `INTERNAL_CONTROL_ANSWERS_PENDING` | 422 | Respostas obrigatórias pendentes | US-161 |
| `INTERNAL_CONTROL_CHECKLIST_DEFAULT_CONFLICT` | 409 | Conflito de padrão | US-158 |
| `INTERNAL_CONTROL_CHECKLIST_DRAFT_EXISTS` | 409 | Rascunho já existente | US-158 |
| `INTERNAL_CONTROL_CHECKLIST_INVALID` | 422 | Publicação inválida | US-158 |
| `INTERNAL_CONTROL_CHECKLIST_IS_DEFAULT` | 409 | Aposentar o padrão | US-158 |
| `INTERNAL_CONTROL_CHECKLIST_KEY_TAKEN` | 409 | Chave de modelo já usada | US-158 |
| `INTERNAL_CONTROL_CHECKLIST_NOT_AVAILABLE` | 409 | Sem checklist publicado ao entrar na etapa | US-159 |
| `INTERNAL_CONTROL_CHECKLIST_NOT_DRAFT` | 409 | Versão não está em rascunho | US-158 |
| `INTERNAL_CONTROL_CHECKLIST_NOT_FOUND` | 404 | Checklist inexistente, de outro tenant ou rascunho sem permissão | US-158 |
| `INTERNAL_CONTROL_FINDING_REQUIRED` | 422 | Item não conforme sem achado | US-161 |
| `INTERNAL_CONTROL_ITEM_NOT_FOUND` | 404 | Item inexistente no checklist | US-160 |
| `INTERNAL_CONTROL_OUTCOME_NOT_SUPPORTED` | 422 | Situação sem respaldo | US-161 |
| `INTERNAL_CONTROL_REPORT_NOT_FINALIZED` | 422 | Manifestação em rascunho | US-161 |
| `INTERNAL_CONTROL_REVIEW_NOT_FOUND` | 404 | Análise inexistente ou de outro tenant | US-159, US-160, US-161, US-162 |
| `INTERNAL_CONTROL_SEGREGATION` | 403 | Conflito de independência | US-159, US-160, US-161 |
| `NOT_INTERNAL_CONTROL_ASSIGNEE` | 403 | Análise designada a outra pessoa | US-159, US-160 |
| `OUTDATED_DOCUMENTS_NOT_ACKNOWLEDGED` | 422 | Documentos alterados sem reconhecimento | US-161 |

### 2.7 Edital (EP-027)
| Código | HTTP | Quando | Story |
|---|---|---|---|
| `DOCUMENT_TYPE_MANAGED_BY_MODULE` | 422 | Tipo gerido pelo módulo | US-167 |
| `RULE_CONTEXT_UNAVAILABLE` | 503 | Provedor de regras indisponível (no encaminhamento) | US-168 |
| `TENDER_CONCLUSION_REQUIRED` | 409 | Finalização pelo documento | US-168 |
| `TENDER_CONTRACT_DRAFT_EXISTS` | 409 | Já existe minuta ativa | US-167 |
| `TENDER_NOT_FOUND` | 404 | Minuta inexistente, de outro tenant ou de processo invisível | US-163, US-164, US-165, US-166 |
| `TENDER_TEXT_CONFIDENTIAL` | 422 | Texto com valor sigiloso | US-166 |
| `TERM_REQUIRED_FOR_IMPORT` | 422 | Sem TR ou TR não concluído | US-164, US-167 |

### 2.8 Indicadores e gargalos (EP-028)
| Código | HTTP | Quando | Story |
|---|---|---|---|
| `ANALYTICS_NOT_READY` | 409 | Indicadores ainda não preparados | US-172, US-173 |
| `ANALYTICS_REBUILD_IN_PROGRESS` | 409 | Reconstrução em andamento | US-171 |
| `ANALYTICS_RUN_NOT_FOUND` | 404 | Execução inexistente ou de outro tenant | US-171 |
| `PERIODS_NOT_COMPARABLE` | 422 | Períodos não comparáveis | US-177 |
| `REPORT_EXPORT_EXPIRED` | 410 | Arquivo expirado | US-174 |
| `REPORT_EXPORT_IN_PROGRESS` | 409 | Pedido igual em andamento | US-174 |
| `REPORT_EXPORT_NOT_READY` | 409 | Arquivo ainda não pronto | US-174 |
| `REPORT_NOT_EXPORTABLE` | 422 | Relatório não exportável | US-174 |
| `REPORT_NOT_FOUND` | 404 | Relatório inexistente ou fora do catálogo | US-172, US-173 |

### 2.9 Plataforma e backoffice (EP-029)
| Código | HTTP | Quando | Story |
|---|---|---|---|
| `GOVBR_ACCOUNT_CONFLICT` | 409 | Conta gov.br de outro usuário | US-183 |
| `GOVBR_ALREADY_LINKED` | 409 | Já vinculado | US-183 |
| `GOVBR_CPF_MISMATCH` | 422 | CPF diferente do cadastrado | US-183 |
| `GOVBR_LINK_TICKET_INVALID` | 422 | Ticket inválido ou expirado | US-183 |
| `GOVBR_NOT_ENABLED` | 403 | Órgão sem gov.br habilitado | US-183 |
| `LIBRARY_UPDATE_NOT_AVAILABLE` | 409 | Sem atualização para o modelo | US-187 |
| `LIBRARY_UPDATE_STALE` | 409 | Biblioteca mudou | US-187 |
| `SUPPORT_ACCESS_ALREADY_ACTIVE` | 409 | Acesso já ativo do operador | US-180 |
| `SUPPORT_ACCESS_NOT_FOUND` | 404 | Acesso de outro tenant ou inexistente | US-180 |

### 2.10 SLA (EP-030)
| Código | HTTP | Quando | Story |
|---|---|---|---|
| `NOTIFICATION_RULE_NAME_ALREADY_EXISTS` | 409 | Nome já existente | US-193 |
| `NOTIFICATION_RULE_NOT_FOUND` | 404 | Regra inexistente ou de outro tenant | US-193 |
| `RULE_REF_INVALID` | 422 | Regra da biblioteca inválida ou aposentada | US-189, US-193 |
| `SLA_POLICY_KEY_ALREADY_EXISTS` | 409 | Chave já existente | US-189 |
| `SLA_POLICY_NOT_FOUND` | 404 | Política inexistente ou de outro tenant | US-189 |

### 2.11 Regras condicionais (EP-031)
| Código | HTTP | Quando | Story |
|---|---|---|---|
| `APPROVAL_NO_APPLICABLE_APPROVER` | 422 | Nenhuma linha aplicável (execução) | US-198 |
| `RULE_DRAFT_EXISTS` | 409 | Rascunho já existe | US-194 |
| `RULE_EVALUATION_FAILED` | 422 | Erro ao avaliar a regra (execução) | US-198 |
| `RULE_INACTIVE` | 422 | Regra inativa ou modelo | US-195 |
| `RULE_INVALID` | 422 | Expressão inválida (operador, caminho, tamanho, resultado, constante) | US-194, US-199 |
| `RULE_KIND_MISMATCH` | 422 | Tipo incompatível | US-195 |
| `RULE_NOT_ALLOWED_ON_LEGAL_STAGE` | 422 | Etapa legalmente obrigatória | US-197 |
| `RULE_SYSTEM_READONLY` | 409 | Modelo do sistema | US-194, US-196, US-200 |
| `RULE_TESTS_FAILING` | 422 | Casos de teste vermelhos (gate da US-200) | US-194, US-200 |
| `RULE_TESTS_REQUIRED` | 422 | Faltam casos de teste | US-200 |
| `RULE_VERSION_NOT_DRAFT` | 409 | Versão não é rascunho | US-194, US-199, US-200 |
| `RULE_VERSION_NOT_PUBLISHED` | 422 | Versão não publicada | US-195, US-197, US-198 |

## 3. Catálogo de endpoints

Legenda: **Perm.** = permissão (+ política) — derivada da seção "Permissões" da story; quando a story distingue leitura e escrita, vale a regra da story. **Idem.** = `Idempotency-Key`; **IM** = `If-Match`. Detalhe de request, response e códigos de cada linha em §4.

### 3.11 PCA (`pca`)
Épico(s): EP-023 · detalhe: [api/11-pca.md](api/11-pca.md)

| # | Método | Rota | Perm. | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| PCA-01 | GET | `/pcas` | `PCA_VIEW` | — | — | US-138 |
| PCA-02 | POST | `/pcas` | `PCA_MANAGE` | Obrigatório | — | US-138 |
| PCA-03 | GET | `/pcas/{pcaId}` | `PCA_VIEW` | — | — | US-138 |
| PCA-04 | PATCH | `/pcas/{pcaId}` | `PCA_MANAGE` | — | Obrigatório | US-138 |
| PCA-05 | DELETE | `/pcas/{pcaId}` | `PCA_MANAGE` | — | Obrigatório | US-138 |
| PCA-06 | GET | `/pcas/{pcaId}/items` | `PCA_VIEW` | — | — | US-138 |
| PCA-07 | POST | `/pcas/{pcaId}/items` | `PCA_MANAGE` | Obrigatório | — | US-138 |
| PCA-08 | PATCH | `/pca-items/{itemId}` | `PCA_MANAGE` | — | Obrigatório | US-138 |
| PCA-09 | DELETE | `/pca-items/{itemId}` | `PCA_MANAGE` | — | Obrigatório | US-138 |
| PCA-10 | GET | `/pcas/{pcaId}/import-template` | `PCA_MANAGE` | — | — | US-139 |
| PCA-11 | POST | `/pcas/{pcaId}/imports` | `PCA_MANAGE` | Obrigatório | — | US-139 |
| PCA-12 | GET | `/pcas/{pcaId}/imports/{importId}` | `PCA_MANAGE` | — | — | US-139 |
| PCA-13 | POST | `/pcas/{pcaId}/imports/{importId}/confirm` | `PCA_MANAGE` | Obrigatório | Obrigatório | US-139 |
| PCA-14 | GET | `/pcas/{pcaId}/imports/{importId}/report` | `PCA_MANAGE` | — | — | US-139 |
| PCA-15 | POST | `/pcas/{pcaId}/submit` | `PCA_SUBMIT` | Obrigatório | Obrigatório | US-140 |
| PCA-16 | POST | `/pcas/{pcaId}/withdraw` | `PCA_SUBMIT` | Obrigatório | Obrigatório | US-140 |
| PCA-17 | GET | `/pcas/{pcaId}/approvals` | `PCA_VIEW` | — | — | US-140 |
| PCA-18 | GET | `/pcas/{pcaId}/submission-check` | `PCA_SUBMIT` | — | — | US-140 |
| PCA-20 | POST | `/pcas/{pcaId}/revisions` | `PCA_MANAGE` | Obrigatório | Obrigatório | US-141 |
| PCA-21 | GET | `/pcas/{pcaId}/versions` | `PCA_VIEW` | — | — | US-141 |
| PCA-22 | GET | `/pcas/{pcaId}/versions/compare` | `PCA_VIEW` | — | — | US-141 |
| PCA-23 | GET | `/pcas/{pcaId}/revision-impact` | `PCA_VIEW` | — | — | US-141 |
| PCA-24 | POST | `/pcas/{pcaId}/discard` | `PCA_MANAGE` | — | Obrigatório | US-141 |
| PCA-25 | GET | `/pcas/{pcaId}/execution` | `PCA_VIEW` | — | — | US-144 |
| PCA-26 | GET | `/pca-items/{itemId}/processes` | `PCA_VIEW` | — | — | US-144 |
| PCA-27 | PATCH | `/pca-items/{itemId}/status` | `PCA_MANAGE` | Obrigatório | Obrigatório | US-144 |
| PCA-28 | POST | `/pcas/{pcaId}/execution/recount` | `PCA_MANAGE` | — | — | US-144 |
| PCA-32 | POST | `/pcas/{pcaId}/exports` | `PCA_EXPORT` | Obrigatório | — | US-145 |
| PCA-33 | GET | `/pcas/{pcaId}/exports/{exportId}` | `PCA_EXPORT` | — | — | US-145 |
| PCA-34 | GET | `/pcas/{pcaId}/exports/{exportId}/download` | `PCA_EXPORT` | — | — | US-145 |
| PCA-35 | GET | `/pcas/{pcaId}/exports` | `PCA_EXPORT` | — | — | US-145 |
| PCA-36 | GET | `/pcas/{pcaId}/disclosure-preview` | `PCA_EXPORT` | — | — | US-145 |
| PCA-40 | GET | `/pca-items/lookup` | `PCA_VIEW` | — | — | US-142 |
| PCA-41 | POST | `/pca-items/check-link` | `PCA_VIEW` | — | — | US-142 |
| PCA-42 | GET | `/processes/{id}/pca-link` | `PCA_VIEW` | — | — | US-142 |
| PCA-43 | GET | `/dfds/{id}/pca-link` | `PCA_VIEW` | — | — | US-142 |
| PCA-48 | POST | `/pcas/{pcaId}/reconciliations` | `PCA_RECONCILE` | Obrigatório | — | US-143 |
| PCA-49 | GET | `/pcas/{pcaId}/reconciliations` | `PCA_VIEW` ou `PCA_RECONCILE` | — | — | US-143 |
| PCA-50 | GET | `/pcas/{pcaId}/reconciliations/{runId}` | `PCA_VIEW` ou `PCA_RECONCILE` | — | — | US-143 |
| PCA-51 | GET | `/pcas/{pcaId}/reconciliations/{runId}/entries` | `PCA_VIEW` ou `PCA_RECONCILE` | — | — | US-143 |
| PCA-52 | GET | `/pcas/{pcaId}/reconciliation-pending` | `PCA_VIEW` ou `PCA_RECONCILE` | — | — | US-143 |
| PCA-53 | GET | `/pcas/{pcaId}/reconciliation-pending/export` | `PCA_EXPORT` ou `PCA_VIEW` | — | — | US-143 |
| PCA-54 | GET | `/pca-reconciliation-entries/{entryId}` | `PCA_VIEW` ou `PCA_RECONCILE` | — | — | US-143 |
| PCA-55 | GET | `/pca-reconciliation-entries/{entryId}/candidates` | `PCA_VIEW` ou `PCA_RECONCILE` | — | — | US-143 |
| PCA-56 | POST | `/pca-reconciliation-entries/{entryId}/conciliate` | `PCA_RECONCILE` + POL-22 | Obrigatório | — | US-143 |
| PCA-57 | POST | `/pcas/{pcaId}/reconciliation-pending/conciliate` | `PCA_RECONCILE` + POL-22 | Obrigatório | — | US-143 |

### 3.12 Dotação orçamentária (`budget`)
Épico(s): EP-024 · detalhe: [api/12-budget.md](api/12-budget.md)

| # | Método | Rota | Perm. | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| BUD-01 | GET | `/processes/{id}/budget-allocations` | `PROCESS_VIEW` | — | — | US-146, US-148 |
| BUD-02 | POST | `/processes/{id}/budget-allocations` | `BUDGET_ALLOCATION_MANAGE` + POL-09 | Obrigatório | — | US-146 |
| BUD-03 | GET | `/processes/{id}/budget-allocations/{allocationId}` | `PROCESS_VIEW` | — | — | US-146 |
| BUD-04 | PATCH | `/processes/{id}/budget-allocations/{allocationId}` | `BUDGET_ALLOCATION_MANAGE` + POL-09 | — | Obrigatório | US-146 |
| BUD-05 | DELETE | `/processes/{id}/budget-allocations/{allocationId}` | `BUDGET_ALLOCATION_MANAGE` + POL-09 | — | Obrigatório | US-146 |
| BUD-10 | POST | `/processes/{id}/budget-allocations/{allocationId}/confirm` | `BUDGET_ALLOCATION_CONFIRM` + POL-25 | Obrigatório | Obrigatório | US-147 |
| BUD-11 | POST | `/processes/{id}/budget-allocations/{allocationId}/cancel` | `BUDGET_ALLOCATION_MANAGE` + POL-25 | Obrigatório | Obrigatório | US-147 |
| BUD-12 | POST | `/processes/{id}/budget-allocations/declaration` | `BUDGET_ALLOCATION_MANAGE` + POL-25 | Obrigatório | — | US-147 |
| BUD-20 | GET | `/processes/{id}/budget-allocations/coverage` | `PROCESS_VIEW` | — | — | US-148 |

### 3.13 Análise jurídica (`legal-review`)
Épico(s): EP-025 · detalhe: [api/13-legal-review.md](api/13-legal-review.md)

| # | Método | Rota | Perm. | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| LGL-01 | GET | `/legal-reviews` | `LEGAL_REVIEW_VIEW` | — | — | US-149 |
| LGL-02 | GET | `/legal-reviews/{id}` | `LEGAL_REVIEW_VIEW` | — | — | US-149, US-150, US-152, US-153, US-154, US-155, US-156, US-157 |
| LGL-03 | POST | `/legal-reviews/{id}/assign` | `PROCESS_ASSIGN` + POL-05 | Obrigatório | Obrigatório | US-150 |
| LGL-04 | POST | `/legal-reviews/bulk-assign` | `PROCESS_ASSIGN` + POL-05 | Obrigatório | — | US-150 |
| LGL-05 | GET | `/legal-review-settings` | `ADMIN_ORGAO` | — | — | US-151 |
| LGL-06 | PUT | `/legal-review-settings/queue-criteria` | `LEGAL_REVIEW_CONFIGURE` | — | Obrigatório | US-151 |
| LGL-07 | POST | `/legal-review-settings/waiver-hypotheses` | `LEGAL_REVIEW_CONFIGURE` | Obrigatório | — | US-151 |
| LGL-08 | PATCH | `/legal-review-settings/waiver-hypotheses/{id}` | `LEGAL_REVIEW_CONFIGURE` | — | Obrigatório | US-151 |
| LGL-09 | GET | `/legal-reviews/summary` | `LEGAL_REVIEW_VIEW` | — | — | US-149, US-150 |
| LGL-10 | POST | `/legal-reviews/{id}/start` | `LEGAL_REVIEW_MANAGE` + POL-19 | Obrigatório | Obrigatório | US-152 |
| LGL-11 | GET | `/legal-reviews/{id}/documents` | `LEGAL_REVIEW_VIEW` | — | — | US-152, US-153 |
| LGL-12 | GET | `/legal-reviews/{id}/documents/compare` | `LEGAL_REVIEW_VIEW` | — | — | US-152, US-153 |
| LGL-13 | POST | `/legal-reviews/{id}/diligences` | `LEGAL_REVIEW_MANAGE` + POL-01 | Obrigatório | Obrigatório | US-153 |
| LGL-14 | POST | `/legal-review-diligences/{diligenceId}/answer` | `LEGAL_REVIEW_MANAGE` + POL-01 | Obrigatório | Obrigatório | US-153 |
| LGL-15 | GET | `/legal-reviews/{id}/diligences` | `PROCESS_VIEW` | — | — | US-153 |
| LGL-16 | GET | `/legal-reviews/{id}/reservations` | `LEGAL_REVIEW_VIEW` | — | — | US-154, US-155 |
| LGL-17 | POST | `/legal-reviews/{id}/reservations` | `LEGAL_REVIEW_MANAGE` + POL-01 | Obrigatório | Obrigatório | US-154 |
| LGL-18 | PATCH | `/legal-review-reservations/{reservationId}` | `LEGAL_REVIEW_MANAGE` + POL-01 | — | Obrigatório | US-154 |
| LGL-19 | POST | `/legal-reviews/{id}/conclude` | `LEGAL_REVIEW_CONCLUDE` + POL-19 | Obrigatório | Obrigatório | US-155 |
| LGL-20 | POST | `/legal-reviews/{id}/opinion` | `LEGAL_REVIEW_MANAGE` + POL-01 | Obrigatório | Obrigatório | US-154 |
| LGL-21 | POST | `/legal-reviews/{id}/waive` | `LEGAL_REVIEW_WAIVE` + POL-26 | Obrigatório | Obrigatório | US-156 |
| LGL-24 | GET | `/processes/{id}/legal-review` | `LEGAL_REVIEW_VIEW` | — | — | US-155 |

### 3.14 Controle Interno (`internal-control`)
Épico(s): EP-026 · detalhe: [api/14-internal-control.md](api/14-internal-control.md)

| # | Método | Rota | Perm. | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| ICT-01 | GET | `/internal-control/checklists` | `INTERNAL_CONTROL_CHECKLIST_MANAGE` | — | — | US-158 |
| ICT-02 | POST | `/internal-control/checklists` | `INTERNAL_CONTROL_CHECKLIST_MANAGE` | Obrigatório | — | US-158 |
| ICT-03 | GET | `/internal-control/checklists/{id}` | `INTERNAL_CONTROL_CHECKLIST_MANAGE` | — | — | US-158 |
| ICT-04 | PATCH | `/internal-control/checklists/{id}` | `INTERNAL_CONTROL_CHECKLIST_MANAGE` | — | Obrigatório | US-158 |
| ICT-05 | POST | `/internal-control/checklists/{id}/publish` | `INTERNAL_CONTROL_CHECKLIST_MANAGE` | Obrigatório | Obrigatório | US-158 |
| ICT-06 | POST | `/internal-control/checklists/{id}/retire` | `INTERNAL_CONTROL_CHECKLIST_MANAGE` | — | Obrigatório | US-158 |
| ICT-07 | POST | `/internal-control/checklists/{id}/preview` | `INTERNAL_CONTROL_CHECKLIST_MANAGE` | — | — | US-158 |
| ICT-08 | GET | `/internal-control/reviews` | `INTERNAL_CONTROL_REVIEW_VIEW` | — | — | US-159 |
| ICT-09 | GET | `/internal-control/reviews/{id}` | `INTERNAL_CONTROL_REVIEW_VIEW` | — | — | US-159, US-160, US-161, US-162 |
| ICT-10 | POST | `/internal-control/reviews/{id}/start` | `INTERNAL_CONTROL_REVIEW_MANAGE` | Obrigatório | Obrigatório | US-159 |
| ICT-11 | GET | `/processes/{id}/internal-control` | `PROCESS_VIEW` | — | — | US-159, US-162 |
| ICT-12 | PUT | `/internal-control/reviews/{id}/answers/{itemKey}` | `INTERNAL_CONTROL_REVIEW_MANAGE` | Obrigatório | Obrigatório | US-160 |
| ICT-13 | POST | `/internal-control/reviews/{id}/findings` | `INTERNAL_CONTROL_REVIEW_MANAGE` | Obrigatório | — | US-160 |
| ICT-14 | PATCH | `/internal-control/reviews/{id}/findings/{findingId}` | `INTERNAL_CONTROL_REVIEW_MANAGE` | Obrigatório | Obrigatório | US-160 |
| ICT-15 | GET | `/internal-control/reviews/{id}/findings` | `INTERNAL_CONTROL_REVIEW_VIEW` | — | — | US-160 |
| ICT-16 | POST | `/internal-control/reviews/{id}/manifestation` | `INTERNAL_CONTROL_REVIEW_MANAGE` | Obrigatório | — | US-161 |
| ICT-17 | POST | `/internal-control/reviews/{id}/conclude` | `INTERNAL_CONTROL_REVIEW_CONCLUDE` | Obrigatório | Obrigatório | US-161 |
| ICT-18 | POST | `/internal-control/reviews/{id}/findings/{findingId}/respond` | `PROCESS_VIEW` | Obrigatório | Obrigatório | US-162 |
| ICT-19 | GET | `/internal-control/findings` | `INTERNAL_CONTROL_REVIEW_VIEW` ou `PROCESS_VIEW` | — | — | US-162 |

### 3.15 Edital (`tender`)
Épico(s): EP-027 · detalhe: [api/15-tender.md](api/15-tender.md)

| # | Método | Rota | Perm. | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| TND-01 | POST | `/processes/{id}/tender` | `TENDER_CREATE` + POL-01 | Obrigatório | — | US-163 |
| TND-02 | GET | `/processes/{id}/tender` | `PROCESS_VIEW` | — | — | US-163 |
| TND-03 | GET | `/tenders/{id}` | `PROCESS_VIEW` | — | — | US-163, US-164, US-165, US-166 |
| TND-04 | PATCH | `/tenders/{id}` | `TENDER_CREATE` + POL-01 | — | Obrigatório | US-163 |
| TND-05 | POST | `/tenders/{id}/import-term/preview` | `TENDER_UPDATE` + POL-02 | — | — | US-164 |
| TND-06 | POST | `/tenders/{id}/import-term` | `TENDER_UPDATE` + POL-02 | Obrigatório | Obrigatório | US-164 |
| TND-07 | GET | `/tenders/{id}/lots` | `PROCESS_VIEW` | — | — | US-165 |
| TND-08 | PUT | `/tenders/{id}/lots` | `TENDER_UPDATE` | — | Obrigatório | US-165 |
| TND-09 | GET | `/tenders/{id}/risk-allocations` | `PROCESS_VIEW` | — | — | US-166 |
| TND-10 | PUT | `/tenders/{id}/risk-allocations` | `TENDER_UPDATE` | — | Obrigatório | US-166 |
| TND-11 | POST | `/tenders/{id}/contract-draft` | `TENDER_CREATE` | Obrigatório | — | US-167 |
| TND-12 | POST | `/tenders/{id}/contract-draft/import-term` | `TENDER_UPDATE` | Obrigatório | Obrigatório | US-167 |
| TND-13 | GET | `/tenders/{id}/completeness` | `PROCESS_VIEW` | — | — | US-168 |
| TND-14 | POST | `/tenders/{id}/conclude` | `TENDER_SUBMIT` | Obrigatório | Obrigatório | US-168 |

### 3.16 Indicadores, gargalos e relatórios (`analytics`)
Épico(s): EP-028 · detalhe: [api/16-analytics.md](api/16-analytics.md)

| # | Método | Rota | Perm. | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| ANL-01 | GET | `/analytics/status` | `REPORT_VIEW` ou `SETTINGS_MANAGE` | — | — | US-170 |
| ANL-02 | POST | `/analytics/rebuilds` | `SETTINGS_MANAGE` | Obrigatório | — | US-171 |
| ANL-03 | GET | `/analytics/rebuilds/{id}` | `SETTINGS_MANAGE` | — | — | US-171 |
| ANL-04 | GET | `/analytics/reconciliation-runs` | `SETTINGS_MANAGE` | — | — | US-171 |
| ANL-05 | GET | `/reports` | `REPORT_VIEW` | — | — | US-172 |
| ANL-06 | GET | `/reports/{report}` | `REPORT_VIEW` | — | — | US-172 |
| ANL-07 | GET | `/reports/saved-views` | `REPORT_VIEW` | — | — | US-172 |
| ANL-08 | POST | `/reports/saved-views` | `REPORT_VIEW` | Obrigatório | — | US-172 |
| ANL-09 | GET | `/reports/{report}/processes` | `REPORT_VIEW` | — | — | US-173 |
| ANL-10 | GET | `/reports/detail/{processId}` | `REPORT_VIEW` | — | — | US-173 |
| ANL-11 | POST | `/reports/{report}/exports` | `REPORT_EXPORT` ou `REPORT_VIEW` | Obrigatório | — | US-174 |
| ANL-12 | GET | `/reports/exports/{id}` | `REPORT_EXPORT` ou `REPORT_VIEW` | — | — | US-174 |
| ANL-13 | GET | `/reports/exports/{id}/download` | `REPORT_EXPORT` ou `REPORT_VIEW` | — | — | US-174 |
| ANL-14 | GET | `/reports/pca-execution` | `REPORT_VIEW` ou `OWN_DEPARTMENTS` | — | — | US-175 |
| ANL-15 | GET | `/bottlenecks` | `REPORT_VIEW` | — | — | US-176 |
| ANL-16 | GET | `/bottlenecks/{dimension}/{key}/processes` | `REPORT_VIEW` | — | — | US-176 |
| ANL-17 | GET | `/bottlenecks/queues` | `REPORT_VIEW` | — | — | US-177 |
| ANL-18 | GET | `/bottlenecks/comparison` | `REPORT_VIEW` | — | — | US-177 |
| ANL-19 | GET | `/reports/exports` | `REPORT_EXPORT` ou `REPORT_VIEW` | — | — | US-174 |

### 3.17 SLA e regras de notificação (`sla`, `notification`)
Épico(s): EP-030 · detalhe: [api/17-sla.md](api/17-sla.md)

| # | Método | Rota | Perm. | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| NTR-01 | GET | `/notification-rules` | `NOTIFICATION_RULE_MANAGE` | — | — | US-193 |
| NTR-02 | POST | `/notification-rules` | `NOTIFICATION_RULE_MANAGE` | Obrigatório | — | US-193 |
| NTR-03 | GET | `/notification-rules/{id}` | `NOTIFICATION_RULE_MANAGE` | — | — | US-193 |
| NTR-04 | PATCH | `/notification-rules/{id}` | `NOTIFICATION_RULE_MANAGE` | — | Obrigatório | US-193 |
| NTR-05 | POST | `/notification-rules/{id}/activate` | `NOTIFICATION_RULE_MANAGE` | — | Obrigatório | US-193 |
| NTR-06 | POST | `/notification-rules/{id}/deactivate` | `NOTIFICATION_RULE_MANAGE` | — | Obrigatório | US-193 |
| NTR-07 | GET | `/notification-rules/{id}/executions` | `NOTIFICATION_RULE_MANAGE` | — | — | US-193 |
| NTR-08 | POST | `/notification-rules/{id}/preview` | `NOTIFICATION_RULE_MANAGE` | Obrigatório | — | US-193 |
| NTR-09 | GET | `/notification-rules/event-types` | `NOTIFICATION_RULE_MANAGE` | — | — | US-193 |
| SLA-01 | GET | `/sla-policies` | `SLA_POLICY_MANAGE` | — | — | US-189 |
| SLA-02 | POST | `/sla-policies` | `SLA_POLICY_MANAGE` | Obrigatório | — | US-189 |
| SLA-03 | GET | `/sla-policies/{id}` | `SLA_POLICY_MANAGE` | — | — | US-189 |
| SLA-04 | PATCH | `/sla-policies/{id}` | `SLA_POLICY_MANAGE` | — | Obrigatório | US-189 |
| SLA-05 | POST | `/sla-policies/{id}/activate` | `SLA_POLICY_MANAGE` | — | Obrigatório | US-189 |
| SLA-06 | POST | `/sla-policies/{id}/deactivate` | `SLA_POLICY_MANAGE` | — | Obrigatório | US-189 |
| SLA-07 | GET | `/sla-policies/stage-catalog` | `SLA_POLICY_MANAGE` | — | — | US-189 |
| SLA-11 | POST | `/sla-policies/preview` | `SLA_POLICY_MANAGE` ou `PROCESS_VIEW` | Obrigatório | — | US-190 |
| SLA-12 | GET | `/processes/{id}/sla` | `PROCESS_VIEW` | — | — | US-190, US-191, US-192 |

### 3.18 Regras condicionais (`rules`)
Épico(s): EP-031 · detalhe: [api/18-rules.md](api/18-rules.md)

| # | Método | Rota | Perm. | Idem. | IM | Story |
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

### 3.19 Plataforma, backoffice e gov.br (`tenancy`, `identity`, `access`, `audit`)
Épico(s): EP-029 · detalhe: [api/19-platform-backoffice.md](api/19-platform-backoffice.md)

| # | Método | Rota | Perm. | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| GOV-01 | GET | `/internal/auth-options` | credencial de serviço do Authentik (rede privada) | — | — | US-182 |
| GOV-02 | POST | `/internal/govbr/resolve` | credencial de serviço do Authentik (rede privada) | — | — | US-182, US-183 |
| GOV-03 | GET | `/me`, `/me/memberships` (extensão de `ME-01` e `ME-04`) | impl. (sessão autenticada) | — | — | US-182 |
| GOV-04 | GET | `/me/external-identities` | `PLATFORM_TENANT_MANAGE` | — | — | US-183 |
| GOV-05 | POST | `/me/external-identities/govbr/link-intents` | `PLATFORM_TENANT_MANAGE` | — | — | US-183 |
| GOV-06 | POST | `/me/external-identities/govbr/link` | `PLATFORM_TENANT_MANAGE` | — | — | US-183 |
| GOV-07 | DELETE | `/me/external-identities/govbr` | `PLATFORM_TENANT_MANAGE` | — | — | US-183 |
| GOV-08 | POST | `/platform/govbr/unlink` | `PLATFORM_TENANT_MANAGE` | — | — | US-183 |
| GOV-09 | GET | `/settings/govbr-status` | `SETTINGS_MANAGE` | — | — | US-184 |
| PLT-09 | GET | `/platform/me` | `PLATFORM_TENANT_MANAGE` | — | — | US-178 |
| PLT-10 | GET | `/platform/tenants/slug-availability` | `PLATFORM_TENANT_MANAGE` | — | — | US-178 |
| PLT-11 | GET | `/platform/tenants/{id}/provisioning` | `PLATFORM_TENANT_MANAGE` | — | — | US-178 |
| PLT-12 | POST | `/platform/tenants/{id}/resend-invitation` | `PLATFORM_TENANT_MANAGE` | — | — | US-178 |
| PLT-13 | GET | `/platform/tenants/{id}/status-history` | `PLATFORM_TENANT_MANAGE` | — | — | US-179 |
| PLT-14 | GET | `/platform/tenants/{id}/lifecycle` | `PLATFORM_TENANT_MANAGE` | — | — | US-179 |
| PLT-15 | POST | `/platform/tenants/{tenantId}/support-access` | `PLATFORM_SUPPORT_ACCESS` | Obrigatório | — | US-180 |
| PLT-16 | POST | `/platform/support-access/{grantId}/end` | `PLATFORM_SUPPORT_ACCESS` | — | — | US-180 |
| PLT-17 | GET | `/platform/tenants/{tenantId}/support-access` | `PLATFORM_SUPPORT_ACCESS` | — | — | US-180 |
| PLT-18 | GET | `/platform/tenants/{tenantId}/support-access/eligible-roles` | `PLATFORM_SUPPORT_ACCESS` | — | — | US-180 |
| PLT-19 | GET | `/platform/support-access` | `PLATFORM_SUPPORT_ACCESS` | — | — | US-180 |
| PLT-20 | GET | `/platform/health/tenants` | `PLATFORM_HEALTH_VIEW` | — | — | US-181 |
| PLT-21 | GET | `/platform/tenants/{tenantId}/health` | `PLATFORM_HEALTH_VIEW` | — | — | US-181 |
| PLT-22 | GET | `/platform/health/summary` | `PLATFORM_HEALTH_VIEW` | — | — | US-181 |
| PLT-23 | GET | `/platform/health/queues` | `PLATFORM_HEALTH_VIEW` | — | — | US-181 |
| PLT-24 | GET | `/platform/tenants/{tenantId}/health/ai` | `PLATFORM_HEALTH_VIEW` | — | — | US-181 |
| ROL-13 | POST | `/roles/{id}/reactivate` | `ROLE_MANAGE` | — | Obrigatório | US-185 |
| SPA-01 | GET | `/support-access` | `AUDIT_VIEW` | — | — | US-180 |
| SPA-02 | GET | `/support-access/{grantId}` | `AUDIT_VIEW` | — | — | US-180 |
| SPA-03 | POST | `/support-access/{grantId}/end` | `USER_MANAGE` | — | — | US-180 |
| TPL-14 | GET | `/templates/{id}/library-update` | `TEMPLATE_VIEW` | — | — | US-187 |
| TPL-15 | POST | `/templates/{id}/library-update/adopt` | `TEMPLATE_MANAGE` ou `TEMPLATE_PUBLISH` | Obrigatório | Obrigatório | US-187 |
| TPL-16 | GET | `/templates/library-updates` | `TEMPLATE_VIEW` | — | — | US-187 |
| TPL-17 | POST | `/templates/{id}/library-update/dismiss` | `TEMPLATE_PUBLISH` | — | Obrigatório | US-187 |

### 3.20 Workflow v2, aprovação múltipla e migração de versão (`workflow`, `process`, `approval`)
Épico(s): EP-021, EP-022 · detalhe: [api/20-workflow-v2.md](api/20-workflow-v2.md)

| # | Método | Rota | Perm. | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| APV-06 | POST | `/approvals/{id}/approvers/{approverId}/reassign` | `APPROVAL_REASSIGN` + POL-17 | Obrigatório | Obrigatório | US-135 |
| APV-31 | GET | `/approvals/{id}/approvers` | `APPROVAL_VIEW` | — | — | US-136 |
| PRC-39 | GET | `/processes/{id}/branches` | `PROCESS_VIEW` | — | — | US-124 |
| PRC-50 | GET | `/workflows/{id}/completed-continuation` | `WORKFLOW_MIGRATE` | — | — | US-131 |
| PRC-51 | POST | `/workflows/{id}/completed-continuation/migrations` | `WORKFLOW_MIGRATE` | Obrigatório | — | US-131 |
| PRC-52 | POST | `/workflow-migrations/{migrationId}/items/bulk-decision` | `WORKFLOW_MIGRATE` | Obrigatório | — | US-131 |
| WF-24 | GET | `/workflow-versions/{versionId}/branches` | `WORKFLOW_VIEW` | — | — | US-123 |
| WF-25 | POST | `/workflows/{id}/migrations` | `WORKFLOW_MIGRATE` | Obrigatório | — | US-126 |
| WF-26 | GET | `/workflows/{id}/migrations` | `WORKFLOW_VIEW` | — | — | US-126 |
| WF-27 | GET | `/workflows/{id}/migrations/{migrationId}` | `WORKFLOW_VIEW` | — | — | US-126, US-128 |
| WF-28 | PATCH | `/workflows/{id}/migrations/{migrationId}` | `WORKFLOW_MIGRATE` | — | Obrigatório | US-126 |
| WF-29 | GET | `/workflows/{id}/migrations/{migrationId}/filter-preview` | `WORKFLOW_VIEW` | — | — | US-126 |
| WF-30 | POST | `/workflows/{id}/migrations/{migrationId}/cancel` | `WORKFLOW_MIGRATE` | Opcional | Opcional | US-126 |
| WF-31 | POST | `/workflows/{id}/migrations/{migrationId}/simulate` | `WORKFLOW_MIGRATE` | Obrigatório | Obrigatório | US-127 |
| WF-32 | GET | `/workflows/{id}/migrations/{migrationId}/items` | `WORKFLOW_VIEW` | — | — | US-127, US-128 |
| WF-33 | GET | `/workflows/{id}/migrations/{migrationId}/items/{itemId}` | `WORKFLOW_VIEW` | — | — | US-127 |
| WF-34 | PUT | `/workflows/{id}/migrations/{migrationId}/items/{itemId}/decision` | `WORKFLOW_MIGRATE` | — | Obrigatório | US-127 |
| WF-35 | POST | `/workflows/{id}/migrations/{migrationId}/execute` | `WORKFLOW_MIGRATE` | Obrigatório | Obrigatório | US-128 |
| WF-36 | GET | `/workflows/{id}/migrations/{migrationId}/items/export` | `WORKFLOW_VIEW` | — | — | US-128 |
| WF-60 | POST | `/rules/context-preview` | `WORKFLOW_MANAGE` ou `PROCESS_VIEW` | — | — | US-129, US-148 |
| WF-62 | GET | `/workflows/{id}/seed-offer` | `WORKFLOW_VIEW` | — | — | US-130 |
| WF-63 | POST | `/workflows/{id}/seed-offer/adopt` | `WORKFLOW_MANAGE` ou `WORKFLOW_PUBLISH` | Obrigatório | Obrigatório | US-130 |
| WF-64 | POST | `/workflows/{id}/seed-offer/dismiss` | `WORKFLOW_PUBLISH` | Obrigatório | Obrigatório | US-130 |
| WF-65 | PUT | `/workflow-stages/{stageId}/approvers` | `WORKFLOW_MANAGE` | — | Obrigatório | US-132 |

**Total MVP 2:** 227 operações novas catalogadas — 225 na API pública `/api/v1` e 2 internas (GOV-01, GOV-02, §6) — e 89 operações do MVP 1 ampliadas (§5). Com o MVP 1 (279), a API pública passa a 504 operações (as rotas do BFF não entram na contagem).

## 4. Especificação por endpoint

O detalhe de cada operação nova (cabeçalhos, request, response, códigos e usos por outras stories) e as ampliações de rotas do MVP 1 feitas pelo épico ficam em um arquivo por módulo, na pasta [`api/`](api/). Os nomes seguem a reserva do [roadmap §4.2](../product/roadmap.md#42-escopo-e-épicos); a numeração 11–20 é da pasta do MVP 2 e não se confunde com a do MVP 1.

| Arquivo | Seção | Épico(s) | Prefixos novos | Operações novas | Rotas do MVP 1 ampliadas |
|---|---|---|---|---|---|
| [11-pca.md](api/11-pca.md) | 3.11 PCA | EP-023 | PCA | 46 | 19 |
| [12-budget.md](api/12-budget.md) | 3.12 Dotação orçamentária | EP-024 | BUD | 9 | 18 |
| [13-legal-review.md](api/13-legal-review.md) | 3.13 Análise jurídica | EP-025 | LGL | 22 | 16 |
| [14-internal-control.md](api/14-internal-control.md) | 3.14 Controle Interno | EP-026 | ICT | 19 | 7 |
| [15-tender.md](api/15-tender.md) | 3.15 Edital | EP-027 | TND | 14 | 18 |
| [16-analytics.md](api/16-analytics.md) | 3.16 Indicadores, gargalos e relatórios | EP-028 | ANL | 19 | 0 |
| [17-sla.md](api/17-sla.md) | 3.17 SLA e regras de notificação | EP-030 | NTR, SLA | 18 | 10 |
| [18-rules.md](api/18-rules.md) | 3.18 Regras condicionais | EP-031 | APV, PRC, RUL, WF | 23 | 12 |
| [19-platform-backoffice.md](api/19-platform-backoffice.md) | 3.19 Plataforma, backoffice e gov.br | EP-029 | GOV, PLT, ROL, SPA, TPL | 33 | 16 |
| [20-workflow-v2.md](api/20-workflow-v2.md) | 3.20 Workflow v2, aprovação múltipla e migração de versão | EP-021, EP-022 | APV, PRC, WF | 24 | 40 |
| **Total** | | | | **227** | |

Itens marcados "a definir na implementação" ou listados como lacunas nas stories (seção "Dependências" ou "Impacto técnico") são detalhes que as fontes não fixam; decidir no refinamento e atualizar a story e o arquivo do módulo.

## 5. Mudanças em contratos do MVP 1

**Garantia de compatibilidade.** Nenhuma rota, campo, código de erro ou semântica do MVP 1 é removido ou alterado de forma incompatível. As mudanças do MVP 2 são só:

- **Campos novos opcionais na resposta** (ex.: `pcaItemId`, `pcaLinkStatus` em `PRC-04`/`PRC-07`; `decisionPolicy`, `progress`, `myLine` em `APV-01`/`APV-02`; `branchKey`, `branchLabel`, `siblings[]` nas linhas de `TSK-01` e `APV-01`; `budget { … }` na linha da etapa `DOTACAO` de `TSK-01`). Clientes do MVP 1 os ignoram.
- **Campos novos opcionais no request**, com padrão que reproduz o comportamento do MVP 1 (ex.: `decisionPolicy` ausente = `ANY`; `pcaItemId` ausente = sem vínculo; `branchKey` ausente = processo sem ramos).
- **Filtros e ordenações novos** em listas existentes (ex.: `TSK-01` por ramo — `branchKey`; `APV-01` por `decisionPolicy`, `myLineStatus` e prazo — `overdue`, `dueFrom`, `dueTo`).
- **Enums ampliados** ([entities.md §2](entities.md#2-enums-novos-e-ampliados)): `StageType` (+`PARALLEL_SPLIT`, `PARALLEL_JOIN`), `ProcessStageStatus` (+`MIGRATED`, `SKIPPED`), `MovementAction` (+`MIGRATE`, `SKIP`), `AssignmentType` (+`MIGRATION`), `ApprovalSubjectType` (+`PCA`), `SystemDocumentModule` (+`LEGAL_OPINION`, `TENDER`, `INTERNAL_CONTROL_REPORT`), `CatalogType` (+6), `AttachmentTargetType` (+`PCA`, `BUDGET_ALLOCATION`, `INTERNAL_CONTROL_REVIEW`, `REPORT_EXPORT`), registros `NotificationType` e `TimelineEntryType`. O frontend do MVP 1 trata valor desconhecido de enum com o rótulo genérico (regra do MVP 1); o OpenAPI marca os enums como extensíveis.
- **Códigos de erro novos** em rotas existentes só para situações que o MVP 1 não tinha (ex.: `APPROVAL_LINE_NOT_PENDING` na decisão por linha); os códigos antigos continuam nas mesmas situações.
- **Chaves novas de configuração** em `SET-01`/`SET-02` (`legalReview.*`, `pca.*`, `auth.govbrEnabled`, `inbox.bulkMaxItems`…), cada uma com padrão que mantém o comportamento do MVP 1.

O diff de contrato do CI (`pnpm ci:contract`, `api.v1.json`) só pode mostrar **adições** nessas rotas; qualquer remoção ou mudança de tipo é bloqueio de release.

| ID | Método | Rota | Contrato original (MVP 1) | Ampliado por | Detalhe no MVP 2 |
|---|---|---|---|---|---|
| AI-01 | POST | `/processes/{id}/ai-generations` | [mvp-01/api/16-ai.md](../mvp-01/api/16-ai.md) | US-157, US-169 | [13-legal-review.md](api/13-legal-review.md), [15-tender.md](api/15-tender.md) |
| AI-02 | GET | `/ai-generations/{generationId}` | [mvp-01/api/16-ai.md](../mvp-01/api/16-ai.md) | US-157, US-169 | [13-legal-review.md](api/13-legal-review.md), [15-tender.md](api/15-tender.md) |
| AI-04 | POST | `/ai-generations/{generationId}/discard` | [mvp-01/api/16-ai.md](../mvp-01/api/16-ai.md) | US-157, US-169 | [13-legal-review.md](api/13-legal-review.md), [15-tender.md](api/15-tender.md) |
| AI-05 | GET | `/ai/availability` | [mvp-01/api/16-ai.md](../mvp-01/api/16-ai.md) | US-157, US-169 | [13-legal-review.md](api/13-legal-review.md), [15-tender.md](api/15-tender.md) |
| AI-06 | GET | `/ai/usage` | [mvp-01/api/16-ai.md](../mvp-01/api/16-ai.md) | US-157, US-169 | [13-legal-review.md](api/13-legal-review.md), [15-tender.md](api/15-tender.md) |
| APV-01 | GET | `/approvals` | [mvp-01/api/11-approvals-inbox.md](../mvp-01/api/11-approvals-inbox.md) | US-125, US-136, US-137, US-140 | [11-pca.md](api/11-pca.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| APV-02 | GET | `/approvals/{id}` | [mvp-01/api/11-approvals-inbox.md](../mvp-01/api/11-approvals-inbox.md) | US-125, US-133, US-134, US-136, US-137, US-140, US-141, US-198 | [11-pca.md](api/11-pca.md), [18-rules.md](api/18-rules.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| APV-03 | POST | `/approvals/{id}/decide` | [mvp-01/api/11-approvals-inbox.md](../mvp-01/api/11-approvals-inbox.md) | US-134, US-140, US-141, US-190 | [11-pca.md](api/11-pca.md), [17-sla.md](api/17-sla.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| APV-04 | POST | `/approvals/{id}/withdraw` | [mvp-01/api/11-approvals-inbox.md](../mvp-01/api/11-approvals-inbox.md) | US-135 | [20-workflow-v2.md](api/20-workflow-v2.md) |
| APV-05 | POST | `/approvals/{id}/reassign` | [mvp-01/api/11-approvals-inbox.md](../mvp-01/api/11-approvals-inbox.md) | US-135 | [20-workflow-v2.md](api/20-workflow-v2.md) |
| ATT-01 | GET | `/processes/{id}/attachments` | [mvp-01/api/12-comments-attachments.md](../mvp-01/api/12-comments-attachments.md) | US-147 | [12-budget.md](api/12-budget.md) |
| ATT-02 | POST | `/attachments` | [mvp-01/api/12-comments-attachments.md](../mvp-01/api/12-comments-attachments.md) | US-139, US-147, US-160 | [11-pca.md](api/11-pca.md), [12-budget.md](api/12-budget.md), [14-internal-control.md](api/14-internal-control.md) |
| ATT-03 | POST | `/attachments/{id}/confirm` | [mvp-01/api/12-comments-attachments.md](../mvp-01/api/12-comments-attachments.md) | US-139, US-147, US-160 | [11-pca.md](api/11-pca.md), [12-budget.md](api/12-budget.md), [14-internal-control.md](api/14-internal-control.md) |
| ATT-04 | GET | `/attachments/{id}` | [mvp-01/api/12-comments-attachments.md](../mvp-01/api/12-comments-attachments.md) | US-139, US-147 | [11-pca.md](api/11-pca.md), [12-budget.md](api/12-budget.md) |
| ATT-05 | GET | `/attachments/{id}/download` | [mvp-01/api/12-comments-attachments.md](../mvp-01/api/12-comments-attachments.md) | US-147 | [12-budget.md](api/12-budget.md) |
| AUD-05 | POST | `/audit/seals/verify` | [mvp-01/api/13-dashboard-notifications-audit.md](../mvp-01/api/13-dashboard-notifications-audit.md) | US-186 | [19-platform-backoffice.md](api/19-platform-backoffice.md) |
| CAL-06 | POST | `/calendar/add-business-days` | [mvp-01/api/14-tenant-administration.md](../mvp-01/api/14-tenant-administration.md) | US-137, US-190 | [17-sla.md](api/17-sla.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| CAT-01 | GET | `/catalogs/{catalogType}/items` | [mvp-01/api/14-tenant-administration.md](../mvp-01/api/14-tenant-administration.md) | US-138, US-146, US-151 | [11-pca.md](api/11-pca.md), [12-budget.md](api/12-budget.md), [13-legal-review.md](api/13-legal-review.md) |
| DEP-02 | GET | `/departments/lookup` | [mvp-01/api/14-tenant-administration.md](../mvp-01/api/14-tenant-administration.md) | US-138 | [11-pca.md](api/11-pca.md) |
| DFD-02 | POST | `/processes/{id}/dfds` | [mvp-01/api/05-dfd.md](../mvp-01/api/05-dfd.md) | US-142 | [11-pca.md](api/11-pca.md) |
| DFD-03 | GET | `/dfds/{id}` | [mvp-01/api/05-dfd.md](../mvp-01/api/05-dfd.md) | US-142 | [11-pca.md](api/11-pca.md) |
| DFD-04 | PATCH | `/dfds/{id}` | [mvp-01/api/05-dfd.md](../mvp-01/api/05-dfd.md) | US-142 | [11-pca.md](api/11-pca.md) |
| DOC-03 | GET | `/documents/{id}` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-167 | [15-tender.md](api/15-tender.md) |
| DOC-04 | PATCH | `/documents/{id}` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-167 | [15-tender.md](api/15-tender.md) |
| DOC-05 | PUT | `/documents/{id}/sections/{sectionKey}` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-154, US-161, US-163, US-167 | [13-legal-review.md](api/13-legal-review.md), [14-internal-control.md](api/14-internal-control.md), [15-tender.md](api/15-tender.md) |
| DOC-08 | GET | `/documents/{id}/validation` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-142, US-154, US-168, US-169 | [11-pca.md](api/11-pca.md), [13-legal-review.md](api/13-legal-review.md), [15-tender.md](api/15-tender.md) |
| DOC-09 | POST | `/documents/{id}/submit` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-133, US-137 | [20-workflow-v2.md](api/20-workflow-v2.md) |
| DOC-10 | POST | `/documents/{id}/finalize` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-154, US-155, US-161 | [13-legal-review.md](api/13-legal-review.md), [14-internal-control.md](api/14-internal-control.md) |
| DOC-12 | POST | `/documents/{id}/reopen` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-154 | [13-legal-review.md](api/13-legal-review.md) |
| DOC-13 | POST | `/documents/{id}/cancel` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-167 | [15-tender.md](api/15-tender.md) |
| DOC-17 | GET | `/document-versions/{versionId}` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-152, US-159, US-160, US-164 | [13-legal-review.md](api/13-legal-review.md), [14-internal-control.md](api/14-internal-control.md), [15-tender.md](api/15-tender.md) |
| DOC-18 | GET | `/documents/{id}/versions/compare?from=&to=` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-152, US-164 | [13-legal-review.md](api/13-legal-review.md), [15-tender.md](api/15-tender.md) |
| DOC-20 | POST | `/documents/{id}/preview` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-167 | [15-tender.md](api/15-tender.md) |
| DOC-21 | POST | `/document-versions/{versionId}/renditions` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-147, US-161, US-168 | [12-budget.md](api/12-budget.md), [14-internal-control.md](api/14-internal-control.md), [15-tender.md](api/15-tender.md) |
| DOC-22 | GET | `/document-renditions/{renditionId}` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-147, US-168 | [12-budget.md](api/12-budget.md), [15-tender.md](api/15-tender.md) |
| DOC-23 | GET | `/document-renditions/{renditionId}/download` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-147 | [12-budget.md](api/12-budget.md) |
| DOC-26 | POST | `/documents/{id}/ai-apply` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-157, US-169 | [13-legal-review.md](api/13-legal-review.md), [15-tender.md](api/15-tender.md) |
| DOC-27 | POST | `/documents/{id}/ai-review` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-157, US-169 | [13-legal-review.md](api/13-legal-review.md), [15-tender.md](api/15-tender.md) |
| DTY-01 | GET | `/document-types` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-137 | [20-workflow-v2.md](api/20-workflow-v2.md) |
| DTY-02 | POST | `/document-types` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-132 | [20-workflow-v2.md](api/20-workflow-v2.md) |
| DTY-03 | PATCH | `/document-types/{id}` | [mvp-01/api/03-documents.md](../mvp-01/api/03-documents.md) | US-132, US-137 | [20-workflow-v2.md](api/20-workflow-v2.md) |
| NTF-01 | GET | `/notifications` | [mvp-01/api/13-dashboard-notifications-audit.md](../mvp-01/api/13-dashboard-notifications-audit.md) | US-186, US-192 | [17-sla.md](api/17-sla.md), [19-platform-backoffice.md](api/19-platform-backoffice.md) |
| PLT-01 | POST | `/platform/tenants` | [mvp-01/api/15-platform-health.md](../mvp-01/api/15-platform-health.md) | US-178 | [19-platform-backoffice.md](api/19-platform-backoffice.md) |
| PLT-02 | GET | `/platform/tenants` | [mvp-01/api/15-platform-health.md](../mvp-01/api/15-platform-health.md) | US-178, US-179 | [19-platform-backoffice.md](api/19-platform-backoffice.md) |
| PLT-03 | GET | `/platform/tenants/{id}` | [mvp-01/api/15-platform-health.md](../mvp-01/api/15-platform-health.md) | US-178, US-179 | [19-platform-backoffice.md](api/19-platform-backoffice.md) |
| PLT-04 | POST | `/platform/tenants/{id}/activate` | [mvp-01/api/15-platform-health.md](../mvp-01/api/15-platform-health.md) | US-179 | [19-platform-backoffice.md](api/19-platform-backoffice.md) |
| PLT-05 | POST | `/platform/tenants/{id}/suspend` | [mvp-01/api/15-platform-health.md](../mvp-01/api/15-platform-health.md) | US-179 | [19-platform-backoffice.md](api/19-platform-backoffice.md) |
| PLT-06 | POST | `/platform/tenants/{id}/offboard` | [mvp-01/api/15-platform-health.md](../mvp-01/api/15-platform-health.md) | US-179 | [19-platform-backoffice.md](api/19-platform-backoffice.md) |
| PLT-07 | POST | `/platform/tenants/{id}/deactivate` | [mvp-01/api/15-platform-health.md](../mvp-01/api/15-platform-health.md) | US-179 | [19-platform-backoffice.md](api/19-platform-backoffice.md) |
| PRC-01 | GET | `/processes` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-125, US-199 | [18-rules.md](api/18-rules.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| PRC-02 | POST | `/processes` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-142 | [11-pca.md](api/11-pca.md) |
| PRC-04 | GET | `/processes/{id}` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-124, US-142 | [11-pca.md](api/11-pca.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| PRC-05 | PATCH | `/processes/{id}` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-142 | [11-pca.md](api/11-pca.md) |
| PRC-07 | GET | `/processes/{id}/summary` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-125, US-142 | [11-pca.md](api/11-pca.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| PRC-08 | GET | `/processes/{id}/available-actions` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-124, US-148, US-197 | [12-budget.md](api/12-budget.md), [18-rules.md](api/18-rules.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| PRC-09 | GET | `/processes/{id}/checklist` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-124, US-148 | [12-budget.md](api/12-budget.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| PRC-10 | GET | `/processes/{id}/stages` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-124, US-197 | [18-rules.md](api/18-rules.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| PRC-11 | GET | `/processes/{id}/movements` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-124 | [20-workflow-v2.md](api/20-workflow-v2.md) |
| PRC-12 | GET | `/processes/{id}/timeline` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-191, US-192 | [17-sla.md](api/17-sla.md) |
| PRC-19 | POST | `/processes/{id}/forward` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-124, US-133, US-148, US-190, US-197, US-198 | [12-budget.md](api/12-budget.md), [17-sla.md](api/17-sla.md), [18-rules.md](api/18-rules.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| PRC-20 | POST | `/processes/{id}/return` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-124, US-148, US-153, US-190 | [12-budget.md](api/12-budget.md), [13-legal-review.md](api/13-legal-review.md), [17-sla.md](api/17-sla.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| PRC-21 | POST | `/processes/{id}/claim` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-124 | [20-workflow-v2.md](api/20-workflow-v2.md) |
| PRC-22 | POST | `/processes/{id}/assign` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-124, US-150 | [13-legal-review.md](api/13-legal-review.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| PRC-23 | POST | `/processes/{id}/suspend` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-124, US-191 | [17-sla.md](api/17-sla.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| PRC-24 | POST | `/processes/{id}/resume` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-124, US-191 | [17-sla.md](api/17-sla.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| PRC-25 | POST | `/processes/{id}/cancel` | [mvp-01/api/02-processes.md](../mvp-01/api/02-processes.md) | US-124 | [20-workflow-v2.md](api/20-workflow-v2.md) |
| ROL-02 | GET | `/roles` | [mvp-01/api/14-tenant-administration.md](../mvp-01/api/14-tenant-administration.md) | US-185 | [19-platform-backoffice.md](api/19-platform-backoffice.md) |
| ROL-04 | GET | `/roles/{id}` | [mvp-01/api/14-tenant-administration.md](../mvp-01/api/14-tenant-administration.md) | US-185 | [19-platform-backoffice.md](api/19-platform-backoffice.md) |
| RSK-09 | GET | `/processes/{id}/risk-matrix` | [mvp-01/api/08-risks.md](../mvp-01/api/08-risks.md) | US-159, US-166 | [14-internal-control.md](api/14-internal-control.md), [15-tender.md](api/15-tender.md) |
| SET-01 | GET | `/settings` | [mvp-01/api/14-tenant-administration.md](../mvp-01/api/14-tenant-administration.md) | US-148, US-184, US-188, US-192 | [12-budget.md](api/12-budget.md), [17-sla.md](api/17-sla.md), [19-platform-backoffice.md](api/19-platform-backoffice.md) |
| SET-02 | PATCH | `/settings` | [mvp-01/api/14-tenant-administration.md](../mvp-01/api/14-tenant-administration.md) | US-138, US-142, US-148, US-184, US-188, US-192 | [11-pca.md](api/11-pca.md), [12-budget.md](api/12-budget.md), [17-sla.md](api/17-sla.md), [19-platform-backoffice.md](api/19-platform-backoffice.md) |
| SET-03 | GET | `/settings/public` | [mvp-01/api/14-tenant-administration.md](../mvp-01/api/14-tenant-administration.md) | US-188 | [19-platform-backoffice.md](api/19-platform-backoffice.md) |
| TSK-01 | GET | `/tasks` | [mvp-01/api/11-approvals-inbox.md](../mvp-01/api/11-approvals-inbox.md) | US-125, US-136, US-137, US-140, US-146, US-148 | [11-pca.md](api/11-pca.md), [12-budget.md](api/12-budget.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| TSK-02 | GET | `/tasks/counters` | [mvp-01/api/11-approvals-inbox.md](../mvp-01/api/11-approvals-inbox.md) | US-125, US-136 | [20-workflow-v2.md](api/20-workflow-v2.md) |
| TSK-03 | POST | `/tasks/bulk-claim` | [mvp-01/api/11-approvals-inbox.md](../mvp-01/api/11-approvals-inbox.md) | US-125, US-188 | [19-platform-backoffice.md](api/19-platform-backoffice.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| TSK-04 | POST | `/tasks/bulk-assign` | [mvp-01/api/11-approvals-inbox.md](../mvp-01/api/11-approvals-inbox.md) | US-125, US-188 | [19-platform-backoffice.md](api/19-platform-backoffice.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| USR-02 | GET | `/users/lookup` | [mvp-01/api/14-tenant-administration.md](../mvp-01/api/14-tenant-administration.md) | US-138 | [11-pca.md](api/11-pca.md) |
| WF-08 | POST | `/workflows/{id}/versions` | [mvp-01/api/10-workflow.md](../mvp-01/api/10-workflow.md) | US-132 | [20-workflow-v2.md](api/20-workflow-v2.md) |
| WF-09 | GET | `/workflow-versions/{versionId}` | [mvp-01/api/10-workflow.md](../mvp-01/api/10-workflow.md) | US-123, US-132 | [20-workflow-v2.md](api/20-workflow-v2.md) |
| WF-10 | POST | `/workflow-versions/{versionId}/stages` | [mvp-01/api/10-workflow.md](../mvp-01/api/10-workflow.md) | US-123 | [20-workflow-v2.md](api/20-workflow-v2.md) |
| WF-11 | PATCH | `/workflow-stages/{stageId}` | [mvp-01/api/10-workflow.md](../mvp-01/api/10-workflow.md) | US-123, US-132, US-197 | [18-rules.md](api/18-rules.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| WF-13 | POST | `/workflow-versions/{versionId}/transitions` | [mvp-01/api/10-workflow.md](../mvp-01/api/10-workflow.md) | US-123 | [20-workflow-v2.md](api/20-workflow-v2.md) |
| WF-14 | PATCH | `/workflow-transitions/{transitionId}` | [mvp-01/api/10-workflow.md](../mvp-01/api/10-workflow.md) | US-123, US-197 | [18-rules.md](api/18-rules.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| WF-16 | POST | `/workflow-versions/{versionId}/rules` | [mvp-01/api/10-workflow.md](../mvp-01/api/10-workflow.md) | US-129, US-195 | [18-rules.md](api/18-rules.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| WF-17 | PATCH | `/workflow-rules/{ruleId}` | [mvp-01/api/10-workflow.md](../mvp-01/api/10-workflow.md) | US-129, US-195 | [18-rules.md](api/18-rules.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| WF-19 | GET | `/rule-context/schema` | [mvp-01/api/10-workflow.md](../mvp-01/api/10-workflow.md) | US-129, US-148, US-194, US-195, US-199, US-200 | [12-budget.md](api/12-budget.md), [18-rules.md](api/18-rules.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| WF-20 | POST | `/workflow-versions/{versionId}/validate` | [mvp-01/api/10-workflow.md](../mvp-01/api/10-workflow.md) | US-123, US-129, US-132, US-195, US-197, US-198 | [18-rules.md](api/18-rules.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| WF-21 | POST | `/workflow-versions/{versionId}/publish` | [mvp-01/api/10-workflow.md](../mvp-01/api/10-workflow.md) | US-123, US-195, US-197, US-198 | [18-rules.md](api/18-rules.md), [20-workflow-v2.md](api/20-workflow-v2.md) |
| WF-23 | POST | `/workflow-versions/{versionId}/rules/test` | [mvp-01/api/10-workflow.md](../mvp-01/api/10-workflow.md) | US-129, US-148 | [12-budget.md](api/12-budget.md), [20-workflow-v2.md](api/20-workflow-v2.md) |

## 6. Rotas fora da API pública

- **BFF (Next.js):** `GET /api/auth/govbr/start`, `GET /api/auth/govbr/refused`, extensão de `GET /api/auth/callback` (US-182) e `POST /api/auth/govbr/link/start` (US-183), somando-se às rotas do BFF do MVP 1 ([authentication.md](../architecture/authentication.md)).
- **Internas (`/internal/*`):** `GOV-01` (`GET /internal/auth-options`), `GOV-02` (`POST /internal/govbr/resolve`) e a extensão de `POST /internal/session-events` — chamadas pelo Authentik com credencial própria, em rede privada; têm código para rastreabilidade nas stories e aparecem no catálogo do §3.19, mas não entram no OpenAPI público nem na contagem da API pública.
- Detalhe em [api/19-platform-backoffice.md](api/19-platform-backoffice.md#rotas-do-bff-e-rotas-internas).

## 7. Verificação

`pnpm docs:check` confere que todo código em `endpoints:` de uma story do MVP 2 existe em `mvp-01/api/*.md` ou `mvp-02/api/*.md`, que todo endpoint novo destes arquivos é citado por ao menos uma story e que toda tela em `screens:` existe em `mvp-01/screens.md` ou `mvp-02/screens.md`.

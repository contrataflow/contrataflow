---
id: US-053
title: "Retirar ou redirecionar aprovação pendente"
epic: EP-008
feature: FT-034
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-052]
modules: [approval, process, document, timeline, audit, platform]
screens: [SCR-015]
endpoints: [APV-04, APV-05, DOC-11]
permissions: [PROCESS_FORWARD, APPROVAL_REASSIGN]
events: [ApprovalCanceled, ApprovalReassigned, ProcessStageChanged]
---

# US-053 — Retirar ou redirecionar aprovação pendente

## Título
Retirar ou redirecionar aprovação pendente

## Descrição
**Como** servidor que encaminhou o processo (ou submeteu o documento) para aprovação, **quero** retirar a solicitação antes de ela ser decidida, **e como** gestor do fluxo, **quero** redirecionar uma aprovação pendente para outro aprovador, **para** corrigir um encaminhamento equivocado ou tratar ausência/impedimento do aprovador original sem perder o trabalho já realizado nem esperar a decisão original.

A retirada (`POST /approvals/{id}/withdraw` para etapas de workflow — `APV-04` —, ou `POST /documents/{id}/withdraw` para submissões avulsas — `DOC-11`) cancela a `Approval` pendente e desfaz o encaminhamento: na etapa de workflow, gera um movimento de devolução (`RETURN` com `metadata.withdrawn`); na submissão avulsa, o documento volta a `DRAFT`. O redirecionamento (`POST /approvals/{id}/reassign` — `APV-05`) troca o aprovador designado sem tocar na etapa, no prazo ou nos documentos cobertos.

## Contexto
- Continua US-052: ambas as ações só existem enquanto a `Approval` está `PENDING`. A retirada de uma aprovação de etapa reaproveita a mecânica de devolução de US-048 (mesma estrutura de `ProcessMovement`), diferenciada por `metadata.withdrawn = true`.
- Motivação de produto: autoridades e aprovadores por perfil (`ROLE`) frequentemente estão de férias, licença ou com conflito de interesse após a solicitação; sem redirecionamento, o processo ficaria parado até a volta do aprovador. Sem retirada, um encaminhamento feito por erro (ex.: etapa errada, documento incompleto enviado antes da hora) só poderia ser corrigido pelo próprio aprovador devolvendo — o que exige a participação de um terceiro para desfazer um erro próprio.
- Baseia-se em DEC-018 (ciclo de vida do documento — retirada da submissão cancela a `Approval` e volta a `DRAFT`), DEC-022 (aprovação genérica — resolução, substituto, segregação), DEC-013/DEC-014 (status macro e transições do workflow) e DEC-055/DEC-104 (concorrência otimista).

## Objetivo
Permitir que encaminhamentos equivocados para aprovação sejam desfeitos e que aprovações pendentes sejam redirecionadas em menos de 1 minuto, sem perda de dados (documentos, prazo original, histórico), reduzindo o tempo médio de bloqueio de processos por indisponibilidade do aprovador.

## Persona
- **Principal (retirada):** quem encaminhou o processo para a etapa de aprovação ou submeteu o documento avulsamente (`requestedById` da `Approval`), com `PROCESS_FORWARD` ou a permissão de submissão do tipo de documento.
- **Principal (redirecionamento):** Gestor de contratações (`GESTOR_CONTRATACOES`) ou titular/substituto da unidade atual, com `APPROVAL_REASSIGN`.
- **Secundárias:** novo aprovador designado (recebe a `Approval` redirecionada).

## Pré-condições
- Existe `Approval` com `status = PENDING` visível ao usuário.
- Para retirada de etapa (`APV-04`): o usuário detém a custódia anterior à entrada na aprovação (ver RN-TRAM-64) e possui `PROCESS_FORWARD` no escopo da unidade de origem.
- Para retirada avulsa (`DOC-11`): o usuário possui a permissão de submissão do tipo do documento (a mesma exigida para `DOC-09`, definida na story do tipo — ex.: `DFD_SUBMIT`).
- Para redirecionamento (`APV-05`): o usuário possui `APPROVAL_REASSIGN` no escopo do processo.
- Processo não está `SUSPENDED` nem em status final.

## Fluxo principal
1. O usuário vê a aprovação pendente que ele mesmo solicitou (em SCR-015 ou no painel do processo SCR-006) e aciona **"Retirar aprovação"**.
2. O sistema exibe a confirmação explicando o efeito: "O processo voltará para a etapa anterior, sob sua responsabilidade. A aprovação pendente será cancelada." (ou, para submissão avulsa: "O documento voltará para rascunho.").
3. O usuário informa, opcionalmente, o **Motivo da retirada** e confirma. O front envia `POST /api/v1/approvals/{id}/withdraw` (`APV-04`) com `If-Match` e `Idempotency-Key`.
4. A API, em uma transação com `app.tenant_id`:
   1. carrega a `Approval` com lock, valida `If-Match` e `status = PENDING` (409 `APPROVAL_NOT_PENDING` caso contrário);
   2. autoriza: o usuário é `requestedById` (ou está na unidade/era o usuário de origem do movimento que criou a entrada na etapa de aprovação — RN-TRAM-64) e possui `PROCESS_FORWARD` no escopo correspondente;
   3. cancela a `Approval` (`status = CANCELED`, `cancellationReason = reason`, `canceledById`, `canceledAt`);
   4. para cada `ApprovalDocument`, limpa `pendingApprovalId`; documentos que estavam `IN_REVIEW` voltam a `DRAFT` (DEC-018); documentos `FINALIZED`/`APPROVED` não mudam de status;
   5. encerra o `ProcessStage` atual (etapa `APPROVAL`) e cria um novo `ProcessStage` na etapa de origem do movimento que gerou a entrada em aprovação;
   6. grava `ProcessMovement` (`action = RETURN`, `metadata.withdrawn = true`, `comment` = motivo informado);
   7. atualiza `ProcessStatus` para `RETURNED` (DEC-013) e o `ProcessAssignment` da nova etapa conforme `assignmentPolicy` do destino;
   8. grava `AuditLog` `approval.withdraw`, o evento `ApprovalCanceled` (`reason = WITHDRAWN`) e `ProcessStageChanged` (`cause = RETURN`), e a entrada na timeline;
   9. confirma a transação.
5. A API responde **200** com a `Approval` cancelada e um resumo da etapa atual do processo. O front invalida as consultas do processo e da caixa de tarefas e exibe "Aprovação retirada. O processo voltou para você.".

## Fluxos alternativos
- **FA-01 — Retirada de submissão avulsa (`DOC-11`):** para `Approval.subjectType = DOCUMENT`, o front envia `POST /api/v1/documents/{id}/withdraw`; não há `ProcessStage`/`ProcessMovement` envolvidos — apenas a `Approval` é cancelada (`WITHDRAWN`) e o documento volta de `IN_REVIEW` para `DRAFT` (DEC-018); gera `DocumentWithdrawn` e `ApprovalCanceled`.
- **FA-02 — Redirecionar para outro aprovador (`APV-05`):** em vez de retirar, o usuário com `APPROVAL_REASSIGN` abre "Redirecionar aprovação", escolhe o novo aprovador (`USER` específico, outro detentor do `ROLE` configurado, ou outra unidade para `DEPARTMENT_HEAD`) e informa o **motivo** (≥ 10 caracteres — ex.: "Titular em licença médica"). O sistema valida a elegibilidade do novo aprovador pelas mesmas regras de US-051/DEC-022, atualiza `approverType`/`approverUserId`/`approverRoleId`/`approverDepartmentId` mantendo `title`, `dueAt` e os documentos cobertos, revoga o `ProcessAccess` `APPROVER` do aprovador anterior e concede ao novo, e gera `ApprovalReassigned`.
- **FA-03 — Redirecionamento para o próprio substituto:** quando o titular está impedido e `allowDeputy = true`, o substituto já pode decidir sem redirecionamento (US-052); o redirecionamento explícito é usado quando se deseja trocar o aprovador de forma duradoura (ex.: o titular ficará afastado por mais tempo que a vigência da aprovação).
- **FA-04 — Tentativa sobre aprovação já decidida:** tanto a retirada quanto o redirecionamento são bloqueados com `APPROVAL_NOT_PENDING` (409) se a decisão já ocorreu.
- **FA-05 — Novo redirecionamento em sequência:** se o novo aprovador também precisar ser trocado, o fluxo se repete normalmente (sem limite de redirecionamentos no MVP 1).

## Regras de negócio
- **RN-TRAM-64** — Retirada de aprovação de etapa (`APV-04`) é permitida a quem é `requestedById` da `Approval` **ou** pertence à unidade de origem do movimento que criou a etapa `APPROVAL` atual (custódia anterior), com `PROCESS_FORWARD` no escopo dessa unidade. Retirada de submissão avulsa (`DOC-11`) exige a permissão de submissão do tipo do documento.
- **RN-TRAM-65** — Retirada e redirecionamento só são permitidos enquanto `Approval.status = PENDING`; caso contrário, `APPROVAL_NOT_PENDING` (409).
- **RN-TRAM-66** — Retirada cancela a `Approval` (`status = CANCELED`, `cancellationReason`, `canceledById`, `canceledAt`) e limpa `pendingApprovalId` de todos os documentos cobertos.
- **RN-TRAM-67** — Efeito em documentos na retirada (DEC-018): status `IN_REVIEW` volta a `DRAFT`; status `FINALIZED`/`APPROVED` permanece inalterado (só deixa de estar "em aprovação").
- **RN-TRAM-68** — Retirada de aprovação de etapa gera `ProcessMovement` (`action = RETURN`, `metadata.withdrawn = true`) para a etapa de origem, `ProcessStatus = RETURNED` e novo `ProcessAssignment` conforme `assignmentPolicy` do destino — mesma mecânica de US-048, sem exigir participação do aprovador.
- **RN-TRAM-69** — Redirecionamento (`APV-05`) exige `APPROVAL_REASSIGN` e que o novo aprovador satisfaça a mesma elegibilidade de POL-03/DEC-022 (vínculo ativo; `ROLE` com atribuição sobre a unidade solicitante; ou titular/substituto da unidade para `DEPARTMENT_HEAD`); o novo aprovador não pode ser igual ao atual nem violar `approval.preventSelfApproval`.
- **RN-TRAM-70** — Redirecionamento preserva `title`, `dueAt`, `requestedById`, `requestedAt` e os `ApprovalDocument` originais; atualiza somente os campos do aprovador e as concessões `ProcessAccess` (`APPROVER`): revoga do anterior, concede ao novo.
- **RN-TRAM-71** — Concorrência: ambas as ações exigem `If-Match` da `Approval`; versão divergente → `VERSION_CONFLICT` (412); `status` não mais `PENDING` na checagem final → `APPROVAL_NOT_PENDING` (409).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Motivo da retirada | `reason` | texto longo | Não | até 2.000 caracteres | — |
| Novo aprovador | `targetApproverUserId` \| `targetApproverRoleId` \| `targetApproverDepartmentId` | seleção | Sim (um dos três, conforme `approverType` escolhido) | RN-TRAM-69 | — |
| Motivo do redirecionamento | `reason` | texto longo | Sim | ≥ 10 e ≤ 2.000 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Motivo do redirecionamento ausente/curto | Front + API | "Informe o motivo do redirecionamento (mín. 10 caracteres)." | `VALIDATION_ERROR` (`TOO_SHORT`) |
| V-02 | Novo aprovador igual ao atual ou inelegível | API | "Selecione um aprovador diferente e elegível para este processo." | `APPROVER_NOT_ELIGIBLE` |
| V-03 | `Approval` não está `PENDING` | API | "Esta aprovação já foi decidida ou retirada." | `APPROVAL_NOT_PENDING` |
| V-04 | Usuário sem custódia anterior tenta retirar | API | "Você não pode retirar esta aprovação." | `PERMISSION_DENIED` |
| V-05 | Novo aprovador violaria segregação de funções | API | "Este usuário não pode aprovar por ser autor de um dos documentos." | `SELF_APPROVAL_FORBIDDEN` |

## Permissões
- **Permissão (retirada de etapa):** `PROCESS_FORWARD`, com a regra de custódia anterior (RN-TRAM-64, POL-17).
- **Permissão (retirada avulsa):** permissão de submissão do tipo do documento (ex.: `DFD_SUBMIT`), reaproveitada de `DOC-09`.
- **Permissão (redirecionamento):** `APPROVAL_REASSIGN`.
- **Políticas:** POL-17 (retirada — custódia anterior); POL-03/DEC-022 (elegibilidade do novo aprovador).
- **MFA:** não exigido por padrão (`PROCESS_FORWARD` e `APPROVAL_REASSIGN` são risco M), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** botões "Retirar"/"Redirecionar" ocultos; API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ApprovalCanceled` | `approval.canceled` | Retirada (`APV-04` ou `DOC-11`) | `reason = WITHDRAWN` |
| `ApprovalReassigned` | `approval.reassigned` | Redirecionamento (`APV-05`) | `fromApproverUserId?`, `toApproverUserId?`, `toApproverRoleId?` |
| `ProcessStageChanged` | `process.stage_changed.return` | Retirada de aprovação de etapa | `cause = RETURN`, `approvalId` preenchido |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `APPROVAL_REASSIGNED` | Novo aprovador e aprovador anterior | in-app + e-mail | Redirecionamento |
| `PROCESS_RETURNED` | Responsável de destino (ou `PREVIOUS_ASSIGNEE`); senão, membros da unidade | in-app + e-mail | Retirada de aprovação de etapa |
| — | — | — | Retirada de submissão avulsa (`DOC-11`) não tem tipo de notificação dedicado no registro |

## Critérios de aceite em Gherkin
```gherkin
Feature: Retirar ou redirecionar aprovação pendente

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" está na etapa "Aprovação da autoridade competente" com status "AWAITING_APPROVAL"
    And "Ana" encaminhou o processo para esta aprovação
    And "Carla" é a aprovadora designada

  Scenario: [Sucesso] Retirar aprovação de etapa devolve o processo a quem encaminhou
    When "Ana" retirar a aprovação pendente
    Then a aprovação deve ficar com status "CANCELED" e motivo "WITHDRAWN"
    And o processo deve voltar para a etapa anterior com status "RETURNED"
    And "Ana" deve ser a responsável pela etapa atual
    And deve gerar o evento "ApprovalCanceled" e o registro de auditoria "approval.withdraw"

  Scenario: [Sucesso] Redirecionar aprovação para outro aprovador elegível
    Given que "Diego" também possui o perfil "AUTORIDADE_COMPETENTE" com atribuição sobre a secretaria solicitante
    When um gestor redirecionar a aprovação de "Carla" para "Diego" com o motivo "Carla está de licença médica"
    Then a aprovação deve permanecer "PENDING" com "approverUserId" igual a "Diego"
    And "Carla" deve perder o acesso de aprovador e "Diego" deve ganhá-lo
    And deve gerar o evento "ApprovalReassigned"

  Scenario: [Validação] Redirecionar sem motivo
    When um gestor tentar redirecionar a aprovação sem informar o motivo
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "reason"

  Scenario: [Permissão] Usuário sem custódia anterior tenta retirar
    Given que "Bruno" não encaminhou o processo e não pertence à unidade de origem
    When "Bruno" tentar retirar a aprovação
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Aprovação de outro tenant
    Given que a aprovação "AP-9" pertence ao tenant "Prefeitura B"
    When um usuário do tenant "Prefeitura de São José" tentar retirá-la ou redirecioná-la
    Then a API deve responder 404 com código "APPROVAL_NOT_FOUND"

  Scenario: [Duplicidade] Reenvio da retirada com a mesma chave de idempotência
    Given que "Ana" retirou a aprovação com a chave "K2" e recebeu 200
    When a mesma requisição for reenviada com a chave "K2"
    Then a API deve responder 200 com o cabeçalho "Idempotent-Replayed: true"
    And a aprovação não deve ser retirada duas vezes

  Scenario: [Concorrência] Retirada após decisão já registrada
    Given que "Carla" decidiu "APPROVE" um instante antes
    When "Ana" tentar retirar a mesma aprovação com a "ETag" antiga
    Then a API deve responder 412 com código "VERSION_CONFLICT" ou 409 com código "APPROVAL_NOT_PENDING"
    And nenhum movimento de devolução deve ser criado

  Scenario: [Falha de banco] Banco indisponível durante o redirecionamento
    Given que o banco de dados fica indisponível durante a transação
    When um gestor confirmar o redirecionamento
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a aprovação deve permanecer com o aprovador original

  Scenario: [Falha de integração] Fila de notificação indisponível ao redirecionar
    Given que a fila "email" está indisponível
    When um gestor redirecionar a aprovação para "Diego"
    Then o redirecionamento deve ser aplicado e a API deve responder 200
    And o evento "ApprovalReassigned" deve permanecer "PENDING" no outbox até a fila voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Motivo ausente/curto | 422 | `VALIDATION_ERROR` | "Informe o motivo (mín. 10 caracteres)." | Marca campo |
| Novo aprovador inelegível/igual ao atual | 422 | `APPROVER_NOT_ELIGIBLE` | "Selecione um aprovador diferente e elegível." | Recarrega lista de aprovadores possíveis |
| Segregação de funções violada | 403 | `SELF_APPROVAL_FORBIDDEN` | "Este usuário não pode aprovar por ser autor de um documento coberto." | Mantém seleção anterior |
| Sem custódia anterior / sem permissão | 403 | `PERMISSION_DENIED` | "Você não pode retirar ou redirecionar esta aprovação." | Oculta ação |
| Aprovação já decidida | 409 | `APPROVAL_NOT_PENDING` | "Esta aprovação já foi decidida ou retirada." | Recarrega estado atual |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Esta aprovação foi atualizada por outra pessoa. Recarregue." | Recarrega dados |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta solicitação já foi enviada com outros dados." | Gera nova chave |
| Indisponibilidade crítica | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente." | Mantém formulário |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-052 (decisão — conceitos e estado compartilhados de `Approval`); US-051 (resolução original do aprovador, reaproveitada na elegibilidade do novo); US-048 (mecânica de devolução reaproveitada na retirada de etapa); US-065 (submissão avulsa, `DOC-09`, espelhada por `DOC-11`).
- **Decisões/ADRs:** DEC-013, DEC-014, DEC-018, DEC-022, DEC-055, DEC-104, DEC-105; ADR-005, ADR-006.
- **Configurações:** `approval.preventSelfApproval`.
- **Lacunas nas fontes canônicas:** nenhuma (custódia anterior formalizada em POL-17; novo aprovador inelegível → `APPROVER_NOT_ELIGIBLE`, api.md §2.2).

## Impacto técnico
- Reaproveita integralmente a infraestrutura de devolução de US-048 (`ProcessMovement` action `RETURN`) para a retirada de etapa, reduzindo a superfície de código novo a: cancelamento da `Approval`, cálculo da custódia anterior e a flag `metadata.withdrawn`.
- O redirecionamento é uma operação apenas sobre a `Approval` e `ProcessAccess` — não toca `ProcessStage`/`ProcessMovement`, minimizando risco de regressão no motor de workflow.
- Ambas as ações competem com `APV-03` (decidir) pelo mesmo lock otimista da `Approval`; a ordem de chegada define o resultado (DEC-055).

## Backend
- **Módulo(s):** `approval` (dono); usa `process` (`ProcessLifecycleService` para a devolução), `document` (`DocumentLifecycleService` para `IN_REVIEW → DRAFT`), `access` (`ProcessAccessService` para revogar/conceder `APPROVER`), `platform` (`OutboxWriter`, `IdempotencyService`), `audit`.
- **Casos de uso:** `WithdrawApprovalCommand` → `WithdrawApprovalHandler` (etapa, via `APV-04`); `WithdrawDocumentSubmissionCommand` → reaproveita o mesmo serviço de cancelamento para `DOC-11`; `ReassignApprovalCommand` → `ReassignApprovalHandler` (`APV-05`).
- **Domínio:** `Approval.cancel(reason)`, `Approval.reassign(newApprover)`; `ProcessStage.exit(movementId)` / `enter(...)` (reaproveitado de US-048).
- **Transação:** passos 4.1–4.9 do fluxo principal (retirada) ou equivalente mais simples para redirecionamento (sem tocar `ProcessStage`).

## Frontend
- **Tela(s):** SCR-015 (`/aprovacoes/{id}`) e painel lateral de SCR-006.
- **Componentes:** `WithdrawApprovalDialog` (confirmação + motivo opcional), `ReassignApprovalDialog` (seletor de novo aprovador filtrado por elegibilidade + motivo obrigatório), `ApprovalAuditTrail` (mostra retiradas/redirecionamentos na timeline da aprovação).
- **Dados:** `useMutation(withdrawApproval)` / `useMutation(reassignApproval)` com `If-Match`; invalidam `['t', tenantId, 'approvals', id]`, `['t', tenantId, 'processes', processId]`, `['t', tenantId, 'tasks']`.
- **Estados:** botão desabilitado durante o envio; mensagem clara quando a aprovação já foi decidida (recarrega); busca assíncrona de aprovadores elegíveis no redirecionamento (debounce).
- **Acessibilidade e responsividade:** diálogos com foco inicial no campo de motivo; anúncio `aria-live` do resultado; layout de coluna única abaixo de 768 px.

## Banco de dados
- **Tabelas:** `approvals` (update), `approval_documents` (leitura), `documents` (update condicional), `process_stages`, `process_assignments`, `process_movements`, `process_access` (grant/revoke `APPROVER`), `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** mesmos de `approvals` (unique `PENDING` por `process_stage_id`/`document_id`); `process_access` unique por `(tenant_id, process_id, principal_type, principal_id, reason) WHERE revoked_at IS NULL` garante a troca limpa de `APPROVER`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| APV-04 | POST | `/api/v1/approvals/{id}/withdraw` | `{ reason? }` + `If-Match` + `Idempotency-Key` | `200 { data: Approval }` com `processStage` atual, `ETag` nova | 200, 401, 403, 404, 409, 412, 422, 428, 503 |
| APV-05 | POST | `/api/v1/approvals/{id}/reassign` | `{ approverType, targetApproverUserId?, targetApproverRoleId?, targetApproverDepartmentId?, reason }` + `If-Match` + `Idempotency-Key` | `200 { data: Approval }` com `ETag` nova | 200, 401, 403, 404, 409, 412, 422, 428, 503 |
| DOC-11 | POST | `/api/v1/documents/{id}/withdraw` | `{ reason? }` + `If-Match` + `Idempotency-Key` | `200 { data: Document }` com `status = DRAFT`, `ETag` nova | 200, 401, 403, 404, 409, 412, 422, 428, 503 |

## Logs
- `info` `approval.withdrawn` — `approvalId`, `processId`/`documentId`, `subjectType`, `correlationId`.
- `info` `approval.reassigned` — `approvalId`, `fromApproverId`, `toApproverId`, `correlationId`.
- `warn` `access.revoke_failed` — falha ao revogar `ProcessAccess` do aprovador anterior (reconciliação).
- `error` `approval.withdraw_failed` / `approval.reassign_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** `reason` (texto livre pode conter dados pessoais sensíveis, ex. licença médica).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `approval.withdraw` | `WORKFLOW` | Commit da retirada | `metadata`: `processCode`/`documentCode`, `subjectType`, `hasReason` |
| `approval.reassign` | `WORKFLOW` | Commit do redirecionamento | `changes`: `approverUserId`/`approverRoleId`/`approverDepartmentId`; `metadata`: `hasReason` |
| `access.denied` | `ACCESS` | Tentativa sem custódia anterior ou sem `APPROVAL_REASSIGN` | `reasonCode`, `approvalId` |

## Testes necessários
- **Unitários:** cálculo da custódia anterior (RN-TRAM-64); `Approval.cancel`/`reassign`; elegibilidade do novo aprovador (reaproveita regras de US-051).
- **Integração (Testcontainers):** retirada de etapa devolve `ProcessStage` corretamente; retirada avulsa volta documento a `DRAFT`; redirecionamento troca `ProcessAccess` atomically.
- **Concorrência:** retirada/redirecionamento simultâneos a uma decisão (`APV-03`) → exatamente uma ação vence.
- **API/contrato:** respostas e erros conforme api.md; cabeçalhos `ETag`/`If-Match`.
- **RBAC e multi-tenant:** usuário sem custódia anterior; usuário sem `APPROVAL_REASSIGN`; aprovação de outro tenant → 404.
- **E2E (Playwright):** retirar e reencaminhar; redirecionar e decidir pelo novo aprovador.
- **Acessibilidade/performance:** axe nos diálogos de retirada/redirecionamento.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando no CI
- [ ] `PROCESS_FORWARD`/`APPROVAL_REASSIGN` e regra de custódia anterior aplicados na API; UI oculta ações sem permissão
- [ ] Auditoria (`approval.withdraw`, `approval.reassign`) e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de APV-04/APV-05/DOC-11 compatível com api.md
- [ ] Logs sem dados sensíveis (`reason` nunca logado)
- [ ] Acessibilidade (axe) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reaproveita majoritariamente a mecânica de devolução (US-048) e de resolução de aprovador (US-051); escopo novo limitado ao cancelamento, ao cálculo de custódia anterior e à troca de aprovador.

## Prioridade
**P1** — importante para não bloquear processos por indisponibilidade do aprovador ou erro de encaminhamento, mas o fluxo principal (US-051/US-052) já funciona sem esta story.

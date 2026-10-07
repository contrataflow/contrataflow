---
id: US-052
title: "Decidir aprovação (aprovar, devolver, indeferir)"
epic: EP-008
feature: FT-034
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-051]
modules: [approval, process, workflow, document, timeline, audit, platform]
screens: [SCR-015]
endpoints: [APV-02, APV-03]
permissions: [APPROVAL_DECIDE]
events: [ApprovalCompleted, ApprovalReturned, ApprovalRejected, ProcessStageChanged, ProcessStatusChanged, ApprovalRequested]
---

# US-052 — Decidir aprovação (aprovar, devolver, indeferir)

## Título
Decidir aprovação (aprovar, devolver, indeferir)

## Descrição
**Como** aprovador designado (titular, substituto ou detentor do perfil competente), **quero** decidir uma aprovação pendente — aprovando, devolvendo para ajuste ou indeferindo —, **para** que o processo e os documentos sob análise avancem, retornem ao custodiante anterior ou sejam oficialmente indeferidos, com todos os efeitos aplicados de forma atômica e rastreável.

A decisão é tomada em `/aprovacoes/{id}` (SCR-015) e enviada por `POST /api/v1/approvals/{id}/decide`. Em uma única transação o sistema: aplica a decisão à `Approval`; atualiza o status de cada documento coberto (DEC-018); quando um documento passa a `APPROVED`, enfileira a renderização `APPROVAL_STAMPED`; resolve a `WorkflowTransition` correspondente à decisão e move o `ProcessStage`/`ProcessStatus`; se a nova etapa também for `APPROVAL`, solicita automaticamente a próxima aprovação (reaproveitando US-051); grava auditoria, timeline e evento.

## Contexto
- Decorre da segregação de funções da Lei 14.133/2021 (art. 7º, § 1º): quem elabora não aprova (`approval.preventSelfApproval`, DEC-022). A decisão formaliza o controle interno/autoridade competente previsto no art. 18 (fase preparatória).
- Continua diretamente a US-051 (solicitar aprovação e resolver o aprovador): esta story consome a `Approval` já criada, com aprovador resolvido e `ApprovalDocument` já gravados.
- Fundamenta-se em DEC-013 (status macro × etapa), DEC-014/DEC-015 (motor de workflow, transições `APPROVE`/`RETURN`/`REJECT`), DEC-016 (regras `WorkflowRule` com avisos reconhecíveis), DEC-018 (ciclo de vida único do documento), DEC-022 (aprovação genérica, substituto, segregação), DEC-055/DEC-104 (concorrência otimista) e DEC-105 (idempotência).
- SCR-015 é usada tanto no desktop quanto em dispositivos móveis — decisão rápida é um requisito de produto (autoridades decidem frequentemente fora do escritório).

## Objetivo
Permitir que 100% das aprovações pendentes sejam decididas em uma única ação atômica — sem estados intermediários inconsistentes entre `Approval`, documentos, etapa e status do processo — com tempo de resposta p95 < 1,5 s para decisões sem encadeamento de nova aprovação.

## Persona
- **Principal:** Autoridade competente / aprovador designado (`USER`, `ROLE` com atribuição sobre a unidade solicitante, ou `DEPARTMENT_HEAD` — DEC-022), perfis como `AUTORIDADE_COMPETENTE`, `DEPARTMENT_HEAD` de secretaria.
- **Secundárias:** Substituto (`deputyUserId`) quando `allowDeputy = true`; Controle Interno (consulta, sem decidir).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`.
- Existe `Approval` com `status = PENDING` visível ao usuário (`APPROVAL_VIEW` ou designação).
- Usuário possui `APPROVAL_DECIDE` e satisfaz POL-03 (designação + segregação).
- Processo não está `SUSPENDED` nem em status final (`CANCELED`, `COMPLETED`, `PUBLISHED`).
- Cliente possui a `ETag` (`version`) atual da `Approval` (de `GET /approvals/{id}`).

## Fluxo principal
1. O usuário abre a aprovação pendente (lista de aprovações ou link de notificação) e o sistema carrega `GET /api/v1/approvals/{id}` (`APV-02`), exibindo SCR-015: título, solicitante, prazo, documentos cobertos (com link para a versão exata analisada) e, quando `allowDeputy`, indicação de que o substituto também pode decidir.
2. O usuário revisa os documentos e escolhe uma das três decisões: **"Aprovar"**, **"Devolver para ajuste"** ou **"Indeferir"**.
3. Para **"Devolver"** ou **"Indeferir"**, o campo **Comentário** (mín. 10 caracteres) é obrigatório; para **"Aprovar"**, é opcional.
4. Se a transição de workflow correspondente tiver `WorkflowRule` de severidade `WARNING` não satisfeita, o sistema exibe os avisos e exige confirmação explícita (`acknowledgedWarnings[]`) antes de habilitar o botão de confirmação.
5. O usuário confirma. O front envia `POST /api/v1/approvals/{id}/decide` com `If-Match: "<version>"` e `Idempotency-Key`, desabilitando o botão.
6. A API, em uma transação com `app.tenant_id`:
   1. carrega a `Approval` com lock, valida `If-Match` (412 se divergente) e `status = PENDING` (409 `APPROVAL_NOT_PENDING` se já decidida);
   2. autoriza POL-03 (designação — titular, substituto ou perfil com escopo sobre a unidade solicitante — e segregação `SELF_APPROVAL_FORBIDDEN`);
   3. avalia as `WorkflowRule` (`scope = TRANSITION`) da transição correspondente; `BLOCKING` não satisfeita → `TRANSITION_BLOCKED`; `WARNING` sem reconhecimento → `WARNINGS_NOT_ACKNOWLEDGED`;
   4. grava `decision`, `decidedById`, `decidedAt`, `decisionComment`, `decidedAsDeputy` e `status` (`APPROVED`/`RETURNED`/`REJECTED`) na `Approval`;
   5. para cada `ApprovalDocument`, atualiza o `Document` conforme DEC-018 (RN-TRAM-57) e limpa `pendingApprovalId`;
   6. resolve a `WorkflowTransition` com `fromStageId = etapa atual` e `action` correspondente à decisão (`APPROVE`/`RETURN`/`REJECT`); encerra o `ProcessStage` atual (`exitedAt`, `exitedViaMovementId`) e cria o novo (`enteredViaMovementId`), recalculando `dueAt` (US-055) e o responsável conforme `assignmentPolicy` do destino (ex.: `PREVIOUS_ASSIGNEE`);
   7. grava `ProcessMovement` (`action = APPROVE|RETURN|REJECT`, `approvalId`, `comment`, `documents` snapshot, IP, `correlationId`);
   8. atualiza `ProcessStatus`: `APPROVE` → `IN_PROGRESS` (destino `TASK`), `AWAITING_APPROVAL` (destino `APPROVAL`, nova aprovação solicitada) ou `COMPLETED` (destino `END`); `RETURN`/`REJECT` → `RETURNED`;
   9. se o destino for `APPROVAL`, solicita a próxima aprovação (regras de US-051: resolução do aprovador, `ApprovalDocument`, `ProcessAccess` `APPROVER`); `APPROVER_UNRESOLVED` desfaz a transição (mantém a etapa anterior) e retorna erro;
   10. para documentos que passaram a `APPROVED`, enfileira `DocumentRendition` (`kind = APPROVAL_STAMPED`, `status = PENDING`) na fila `document-render` e dispara o gancho interno `onDocumentApproved`;
   11. grava `AuditLog` `approval.decide`, o evento de domínio (`ApprovalCompleted`/`ApprovalReturned`/`ApprovalRejected`), `ProcessStageChanged`, `ProcessStatusChanged` (se mudou) e a entrada correspondente na timeline;
   12. confirma a transação.
7. A API responde **200** com a `Approval` atualizada (`ETag` nova) e um resumo da nova etapa/status do processo.
8. O front invalida as consultas da aprovação, do processo e da caixa de tarefas; exibe o toast "Aprovação decidida: {decisão}." e navega para `/processos/{id}`.

## Fluxos alternativos
- **FA-01 — Decisão de submissão avulsa (`subjectType = DOCUMENT`):** quando a `Approval` vem de `DOC-09` (fora de uma etapa `APPROVAL`), a decisão não envolve `ProcessStage`/`ProcessStatus`/transição: só o documento muda de status (DEC-018) e não há `ProcessStageChanged` nem nova `Approval` encadeada.
- **FA-02 — Decisão pelo substituto:** com `allowDeputy = true` e o titular ausente, o substituto decide; `decidedAsDeputy = true` é gravado e exibido na timeline e na auditoria.
- **FA-03 — Avisos pendentes de reconhecimento:** a transição tem `WorkflowRule` `WARNING` (ex.: "o mapa de riscos não foi atualizado desde a última versão"); o usuário deve marcar "Estou ciente e desejo continuar" antes de confirmar; os avisos reconhecidos são gravados em `ProcessMovement.metadata.warningsAcknowledged` e `AuditLog.metadata`.
- **FA-04 — Indeferimento de documento já aprovado em etapa anterior:** ao indeferir, um documento `APPROVED`/`FINALIZED` passa a `REJECTED` (estado final); só retorna a `DRAFT` por reabertura (`DOCUMENT_REOPEN`, fora desta story).
- **FA-05 — Aprovador resolvido por perfil (`ROLE`) decide via painel de equipe:** qualquer detentor do perfil com atribuição sobre a unidade solicitante pode decidir; o primeiro a confirmar "vence" (os demais recebem `APPROVAL_NOT_PENDING` ao tentar).
- **FA-06 — Decisão em dispositivo móvel:** SCR-015 em layout compacto (ações em botões grandes, comentário por voz-para-texto quando suportado pelo dispositivo); mesmo contrato de API.

## Regras de negócio
- **RN-TRAM-54** — Decisões possíveis: `APPROVE` → `ApprovalStatus.APPROVED`; `RETURN` → `RETURNED`; `REJECT` → `REJECTED`. Somente sobre `Approval.status = PENDING`.
- **RN-TRAM-55** — `decisionComment` obrigatório (≥ 10 caracteres) para `RETURN` e `REJECT`; opcional para `APPROVE`.
- **RN-TRAM-56** — A etapa de destino é dada pela `WorkflowTransition` com `fromStageId` igual à etapa `APPROVAL` atual e `action` igual à decisão (`APPROVE`/`RETURN`/`REJECT`); `RETURN`/`REJECT` só podem apontar para etapas já percorridas pelo processo (DEC-015).
- **RN-TRAM-57** — Efeito em cada documento coberto (`ApprovalDocument`), conforme DEC-018: `IN_REVIEW` → `APPROVED`/`RETURNED`/`REJECTED`; `FINALIZED` ou `APPROVED` → `APPROVED`/`RETURNED`/`REJECTED` conforme a decisão; documento já `APPROVED` reaprovado por nova etapa permanece `APPROVED` (a nova `Approval` é apenas registrada). `pendingApprovalId` é sempre limpo ao final.
- **RN-TRAM-58** — Documento que passa a `APPROVED` tem uma `DocumentRendition` (`kind = APPROVAL_STAMPED`) enfileirada; falha ou atraso na renderização não bloqueia a decisão (RN-TRAM-62 de resiliência).
- **RN-TRAM-59** — Status do processo (DEC-013): `APPROVE` leva a `IN_PROGRESS` (destino `TASK`/`START`), permanece/retorna a `AWAITING_APPROVAL` (destino `APPROVAL`) ou vai a `COMPLETED` (destino `END`); `RETURN` e `REJECT` levam a `RETURNED`, independentemente do tipo da etapa de destino.
- **RN-TRAM-60** — Se a etapa de destino for `APPROVAL`, uma nova `Approval` é solicitada automaticamente (regras de US-051); se o aprovador não puder ser resolvido (`APPROVER_UNRESOLVED`), toda a transição é desfeita e a `Approval` original permanece `PENDING`.
- **RN-TRAM-61** — O `ProcessAssignment` da nova etapa segue `assignmentPolicy` do `WorkflowStage` de destino (ex.: `PREVIOUS_ASSIGNEE` — responsável individual mais recente na mesma etapa; sem histórico, fila da unidade).
- **RN-TRAM-62** — Segregação de funções (POL-03/DEC-022): se `approval.preventSelfApproval`, o decisor não pode ser autor de nenhuma versão coberta; violação → `SELF_APPROVAL_FORBIDDEN` (403).
- **RN-TRAM-63** — Concorrência: a decisão exige `If-Match` com a `version` da `Approval`; divergência → `VERSION_CONFLICT` (412); se a versão coincidir mas `status` não for mais `PENDING` (corrida dentro da janela de leitura) → `APPROVAL_NOT_PENDING` (409).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Decisão | `decision` | seleção (`ApprovalDecision`) | Sim | `APPROVE`\|`RETURN`\|`REJECT` | — |
| Comentário | `comment` | texto longo | Condicional (RN-TRAM-55) | ≥ 10 e ≤ 5.000 caracteres | — |
| Avisos reconhecidos | `acknowledgedWarnings` | lista de ids (técnico) | Condicional (FA-03) | só enviado após confirmação explícita na UI | `[]` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `decision` ausente ou fora do enum | Front + API (Zod) | "Selecione uma decisão." | `VALIDATION_ERROR` (`REQUIRED`/`INVALID_ENUM`) |
| V-02 | `comment` ausente/curto em `RETURN`/`REJECT` | Front + API | "Informe o motivo (mín. 10 caracteres)." | `VALIDATION_ERROR` (`TOO_SHORT`) |
| V-03 | Avisos `WARNING` não reconhecidos | API | "Confirme que está ciente dos avisos para continuar." | `WARNINGS_NOT_ACKNOWLEDGED` |
| V-04 | Regra `BLOCKING` não satisfeita na transição | API | "Não é possível concluir esta decisão agora: {mensagem da regra}." | `TRANSITION_BLOCKED` |
| V-05 | `Approval` não está `PENDING` | API | "Esta aprovação já foi decidida." | `APPROVAL_NOT_PENDING` |
| V-06 | Aprovador da próxima etapa não resolvido | API | "Não foi possível determinar quem deve aprovar a próxima etapa. Contate o administrador." | `APPROVER_UNRESOLVED` |

## Permissões
- **Permissão:** `APPROVAL_DECIDE` (risco H).
- **Políticas:** POL-03 — designação (`USER`, `ROLE` com atribuição sobre a unidade solicitante, ou titular/substituto de `DEPARTMENT_HEAD`), `Approval.status = PENDING`, processo não `SUSPENDED`, segregação de funções.
- **MFA:** exigido por padrão (ação de risco H — POL-14), salvo política do tenant que a dispense explicitamente.
- **Sem permissão:** botões "Aprovar/Devolver/Indeferir" ocultos em SCR-015 para quem só tem `APPROVAL_VIEW`; API responde 403 `NOT_DESIGNATED_APPROVER` (ou `SELF_APPROVAL_FORBIDDEN`) e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ApprovalCompleted` | `approval.completed` | Decisão `APPROVE` | `documentVersionIds[]`, `decidedAsDeputy` |
| `ApprovalReturned` | `approval.returned` | Decisão `RETURN` | idem + `hasComment: true` |
| `ApprovalRejected` | `approval.rejected` | Decisão `REJECT` | idem |
| `ProcessStageChanged` | `process.stage_changed.<cause>` | Sempre que a decisão move a etapa | `cause` ∈ `APPROVAL_APPROVED`\|`APPROVAL_RETURNED`\|`APPROVAL_REJECTED` |
| `ProcessStatusChanged` | `process.status_changed.<status>` | Quando o status macro muda | `fromStatus`, `toStatus`, `cause` |
| `ApprovalRequested` | `approval.requested` | Destino também é `APPROVAL` (encadeamento, RN-TRAM-60) | reaproveita payload de US-051 |

Projeção síncrona: entrada na timeline (`PROCESS_STAGE_CHANGED`/equivalente) e, quando aplicável, `ProcessAccess` `APPROVER` para a nova aprovação.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `APPROVAL_DECIDED` | Solicitante e `responsibleId` dos documentos cobertos | in-app + e-mail | Toda decisão |
| `PROCESS_RETURNED` | Responsável de destino (ou `PREVIOUS_ASSIGNEE`); senão, membros da unidade | in-app + e-mail | Decisão `RETURN`/`REJECT` |
| `APPROVAL_REQUESTED` | Novo aprovador (e substituto, se `allowDeputy`) | in-app (obrigatória) + e-mail | Encadeamento (RN-TRAM-60) |
| `PROCESS_STATUS_CHANGED` | Criador, responsável atual, participantes com `notify` | in-app | Status final `COMPLETED` |

## Critérios de aceite em Gherkin
```gherkin
Feature: Decidir aprovação

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" está na etapa "Aprovação da autoridade competente" com status "AWAITING_APPROVAL"
    And existe uma aprovação pendente cobrindo o "ETP" e o "Termo de Referência" na versão atual
    And "Carla" é a autoridade competente designada para a aprovação

  Scenario: [Sucesso] Aprovar leva o processo para a próxima etapa
    When "Carla" decidir "APPROVE" sem ressalvas
    Then a aprovação deve ficar com status "APPROVED" e "decidedById" igual a "Carla"
    And os documentos cobertos devem passar para o status "APPROVED"
    And uma renderização "APPROVAL_STAMPED" deve ser enfileirada para cada documento aprovado
    And o processo deve avançar para a etapa "Planejamento da contratação concluído" com status "COMPLETED"
    And deve gerar o evento "ApprovalCompleted" e o registro de auditoria "approval.decide"

  Scenario: [Validação] Devolver sem comentário
    When "Carla" tentar decidir "RETURN" sem informar o comentário
    Then o sistema deve exibir "Informe o motivo (mín. 10 caracteres)."
    And a API deve responder 422 com código "VALIDATION_ERROR" no campo "comment"
    And a aprovação deve permanecer "PENDING"

  Scenario: [Permissão] Usuário não designado tenta decidir
    Given que "Bruno" não é aprovador designado nem substituto
    When "Bruno" enviar a decisão "APPROVE"
    Then a API deve responder 403 com código "NOT_DESIGNATED_APPROVER"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Permissão] Autor do documento tenta aprovar o próprio trabalho
    Given que "Carla" é autora da versão atual do "Termo de Referência"
    And "approval.preventSelfApproval" está habilitado
    When "Carla" tentar decidir "APPROVE"
    Then a API deve responder 403 com código "SELF_APPROVAL_FORBIDDEN"

  Scenario: [Tenant incorreto] Aprovação de outro tenant
    Given que a aprovação "AP-9" pertence ao tenant "Prefeitura B"
    When um usuário do tenant "Prefeitura de São José" requisitar "AP-9"
    Then a API deve responder 404 com código "APPROVAL_NOT_FOUND"

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Carla" decidiu "APPROVE" com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o cabeçalho "Idempotent-Replayed: true"
    And a aprovação não deve ser decidida duas vezes

  Scenario: [Concorrência] Duas decisões simultâneas sobre a mesma aprovação
    Given que "Carla" e seu substituto "Diego" abriram a mesma aprovação pendente
    When ambos enviarem "APPROVE" quase simultaneamente
    Then apenas uma requisição deve ser aplicada com sucesso (200)
    And a outra deve receber 412 "VERSION_CONFLICT" ou 409 "APPROVAL_NOT_PENDING"

  Scenario: [Falha de banco] Banco indisponível durante a decisão
    Given que o banco de dados fica indisponível durante a transação
    When "Carla" confirmar a decisão "APPROVE"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum dos efeitos (documento, etapa, status, evento) deve ser persistido parcialmente

  Scenario: [Falha de integração] Fila de renderização indisponível
    Given que a fila "document-render" está indisponível
    When "Carla" decidir "APPROVE"
    Then a decisão deve ser aplicada e a API deve responder 200
    And a "DocumentRendition" deve permanecer "PENDING" para nova tentativa
    And a decisão não deve ficar bloqueada esperando a renderização
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Decisão/comentário inválidos | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos; foca o primeiro erro |
| Avisos não reconhecidos | 422 | `WARNINGS_NOT_ACKNOWLEDGED` | "Confirme que está ciente dos avisos para continuar." | Exibe checklist de avisos |
| Regra bloqueante não satisfeita | 422 | `TRANSITION_BLOCKED` | "Não é possível concluir esta decisão agora." | Lista `violations[]` com links |
| Sem designação/segregação | 403 | `NOT_DESIGNATED_APPROVER` / `SELF_APPROVAL_FORBIDDEN` | "Você não pode decidir esta aprovação." | Oculta ações; explica o motivo |
| Aprovação já decidida | 409 | `APPROVAL_NOT_PENDING` | "Esta aprovação já foi decidida." | Recarrega e mostra a decisão registrada |
| Próximo aprovador não resolvido | 422 | `APPROVER_UNRESOLVED` | "Não foi possível determinar quem deve aprovar a próxima etapa." | Mantém decisão pendente; sugere contatar o administrador |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Esta aprovação foi atualizada por outra pessoa. Recarregue." | Recarrega dados atuais |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Não foi possível processar. Recarregue a página." | Recarrega antes de reenviar |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta decisão já foi enviada com outros dados." | Gera nova chave |
| Vínculo/tenant inativo | 403 | `MEMBERSHIP_INACTIVE` / `TENANT_SUSPENDED` | "Seu acesso não está ativo." | Redireciona para SCR-111 |
| Indisponibilidade crítica | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível registrar a decisão agora. Tente novamente." | Mantém formulário; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-051 (solicitação e resolução do aprovador — pré-requisito direto); US-047 (encaminhamento, estrutura de `ProcessMovement`); US-065 (submissão avulsa de documento, DOC-09, para o fluxo FA-01); US-055 (cálculo de `dueAt` da nova etapa).
- **Decisões/ADRs:** DEC-013, DEC-014, DEC-015, DEC-016, DEC-018, DEC-022, DEC-055, DEC-104, DEC-105; ADR-005, ADR-006, ADR-008.
- **Configurações:** `approval.preventSelfApproval`.
- **Lacunas nas fontes canônicas:** nenhuma — `WorkflowStage.approvalDocumentTypeCodes` e `WorkflowTransition` (`fromStageId`/`toStageId`/`action`) confirmados em `entities.md` §4.5.

## Impacto técnico
- Reutiliza o padrão de comando transacional estabelecido em US-001 (transação única com projeções síncronas, auditoria e outbox).
- Ponto de maior risco: a decisão pode disparar uma **cadeia** (documento → etapa → status → nova aprovação) dentro da mesma transação; o manipulador deve ser idempotente internamente e reverter tudo em caso de `APPROVER_UNRESOLVED` na etapa seguinte.
- `DocumentRendition` é assíncrona por design (fila `document-render`): a decisão nunca espera o Gotenberg.
- `onDocumentApproved` é um gancho interno (sem efeito colateral externo no MVP 1) para permitir integrações futuras sem reabrir este contrato.

## Backend
- **Módulo(s):** `approval` (dono); usa `process` (`ProcessLifecycleService.applyDecision`, `ProcessStage`/`ProcessMovement`), `workflow` (`WorkflowFacade.resolveTransition(fromStageId, action)`, avaliação de `WorkflowRule`), `document` (`DocumentLifecycleService.applyApprovalDecision`), `platform` (`OutboxWriter`, fila `document-render`, `IdempotencyService`), `audit`.
- **Casos de uso:** `DecideApprovalCommand` → `DecideApprovalHandler`; reaproveita `RequestApprovalHandler` (US-051) para o encadeamento.
- **Domínio:** `Approval.decide(decision, comment, actorId)`; `Document.applyApprovalDecision(decision)`; `ProcessStage.exit(movementId)` / `ProcessStage.enter(...)`; `ProcessMovement.record(...)`.
- **Transação:** passos 6.1–6.12 do fluxo principal, isolamento `READ COMMITTED`, lock da `Approval` (`SELECT … FOR UPDATE`).

## Frontend
- **Tela(s):** SCR-015 (`/aprovacoes/{id}`), consumida também em painel lateral a partir de SCR-006.
- **Componentes:** `ApprovalDecisionPanel` (três botões de decisão), `CommentField` (obrigatório condicional), `WarningsChecklist`, `DocumentCoverageList` (links para `DocumentVersion`), `ApprovalStatusBadge`.
- **Dados:** TanStack Query `['t', tenantId, 'approvals', id]`; `useMutation(decideApproval)` com `If-Match` da última leitura; após sucesso invalida `['t', tenantId, 'approvals']`, `['t', tenantId, 'processes', processId]`, `['t', tenantId, 'tasks']`.
- **Estados:** skeleton no carregamento; aviso quando `allowDeputy`; botão desabilitado durante o envio; mensagem clara quando a aprovação já foi decidida por outra pessoa (recarrega automaticamente).
- **Acessibilidade e responsividade:** botões de decisão com rótulo e estado `aria-pressed`; layout de coluna única e botões grandes abaixo de 768 px (uso móvel é requisito, FA-06).

## Banco de dados
- **Tabelas:** `approvals` (update), `approval_documents` (leitura), `documents` (update de status), `document_renditions` (insert `PENDING`), `process_stages`, `process_assignments`, `process_movements`, `process_access`, `process_timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma (usa estrutura de entities.md §4.5/4.6/4.4 já existente).
- **Índices/constraints relevantes:** `approvals` unique `(tenant_id, process_stage_id) WHERE status = 'PENDING'` garante não haver duas aprovações pendentes simultâneas na mesma etapa; check `decision NOT IN ('RETURN','REJECT') OR decision_comment IS NOT NULL`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| APV-02 | GET | `/api/v1/approvals/{id}` | — | `200 { data: Approval }` com `documents[]`, `allowedActions`, `ETag` | 200, 403, 404 |
| APV-03 | POST | `/api/v1/approvals/{id}/decide` | `{ decision, comment?, acknowledgedWarnings? }` + `If-Match` + `Idempotency-Key` | `200 { data: Approval }` com `processStage { key, name }`, `processStatus`, `ETag` nova | 200, 401, 403, 404, 409, 412, 422, 428, 429, 500, 503 |

## Logs
- `info` `approval.decided` — `approvalId`, `processId`, `decision`, `decidedAsDeputy`, `nextStageKey?`, `durationMs`, `correlationId`.
- `info` `approval.chained` — quando uma nova aprovação é solicitada automaticamente.
- `warn` `rendition.enqueue_failed` — ao não conseguir publicar na fila `document-render` (mantém `PENDING` para reconciliação).
- `error` `approval.decide_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** `decisionComment`, conteúdo dos documentos.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `approval.decide` | `WORKFLOW` | Commit da decisão | `changes`: `status`, `decision`; `metadata`: `processCode`, `fromStatus`/`toStatus`, `documentIds[]`, `warningsAcknowledged`, `decidedAsDeputy` |
| `access.denied` | `ACCESS` | Tentativa sem designação/segregação | `reasonCode = APPROVAL_DECIDE`, `approvalId` |

## Testes necessários
- **Unitários:** `Approval.decide` (RN-TRAM-54/55/62); resolução da `WorkflowTransition` por `action`; efeitos em `Document` por combinação de status de origem × decisão (DEC-018, tabela completa).
- **Integração (Testcontainers):** transação completa aprova→avança→conclui; encadeamento para nova `APPROVAL` com `APPROVER_UNRESOLVED` desfazendo tudo; `DocumentRendition` enfileirada corretamente.
- **Concorrência:** duas decisões simultâneas → uma 200, outra 412/409; duas decisões com a mesma `Idempotency-Key` → replay.
- **API/contrato:** respostas e erros conforme api.md; cabeçalhos `ETag`/`If-Match`/`Idempotent-Replayed`.
- **RBAC e multi-tenant:** matriz titular/substituto/perfil × segregação; aprovação de outro tenant → 404.
- **E2E (Playwright):** aprovar até concluir o processo; devolver e verificar retorno à etapa anterior; indeferir documento já aprovado.
- **Acessibilidade/performance:** axe em SCR-015; latência p95 < 1,5 s sem encadeamento.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados e passando no CI
- [ ] `APPROVAL_DECIDE` + POL-03 aplicados na API; UI oculta ações sem designação
- [ ] Efeitos atômicos (documento, etapa, status, encadeamento) cobertos por teste de falha induzida
- [ ] Auditoria `approval.decide` e eventos verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de APV-02/APV-03 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas e trace do encadeamento de aprovações
- [ ] SCR-015 acessível (axe) e usável em telas móveis
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**L** — decisão com efeitos atômicos em três agregados (aprovação, documentos, processo), encadeamento condicional de nova aprovação e geração assíncrona de renderização; alta sensibilidade de regra de negócio (Lei 14.133, segregação de funções).

## Prioridade
**P0** — sem decisão, nenhum processo com etapa de aprovação avança; bloqueia a conclusão do planejamento da contratação.

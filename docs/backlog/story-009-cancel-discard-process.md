---
id: US-009
title: "Cancelar processo ou descartar rascunho"
epic: EP-001
feature: FT-005
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-001, US-051]
modules: [process, workflow, access, timeline, audit, platform]
screens: [SCR-006, SCR-116]
endpoints: [PRC-06, PRC-25]
permissions: [PROCESS_CANCEL, PROCESS_CREATE]
events: [ProcessStatusChanged, ProcessCanceled, ApprovalCanceled, ProcessDraftDiscarded]
---

# US-009 — Cancelar processo ou descartar rascunho

## Título
Cancelar processo ou descartar rascunho

## Descrição
**Como** gestor de contratações, **quero** cancelar um processo que não deve seguir adiante — ou descartar um rascunho sem número — informando o motivo, **para** encerrar formalmente a tramitação sem perder o registro, ou, no caso do rascunho, sem deixar lixo no sistema.

Cancelar se aplica a qualquer processo em status não final e exige justificativa; encerra aprovações pendentes, a etapa ativa e a atribuição, e é definitivo (`CANCELED`). Descartar se aplica apenas a um rascunho (`DRAFT`) que ainda não recebeu número/código (numeração `assignOn = START`) e é exclusão lógica, não uma transição de status.

## Contexto
- Hoje, processos abertos por erro, duplicados ou que perderam o objeto ficam sem baixa formal — ninguém sabe se ainda estão em curso, poluindo filas e relatórios.
- DEC-013 torna `CANCELED` alcançável de `DRAFT`, `IN_PROGRESS`, `AWAITING_APPROVAL`, `RETURNED` e `SUSPENDED`, e final no MVP 1. DEC-034 estabelece que nada é excluído fisicamente, mas um rascunho sem número pode ser **descartado** (exclusão lógica) em vez de cancelado.
- POL-06 exige `PROCESS_CANCEL` cobrindo o processo, status não final e justificativa ≥ 20 caracteres; aprovações pendentes são canceladas na mesma transação.
- DEC-018 determina que documento `IN_REVIEW` coberto pela aprovação cancelada retorna a `DRAFT` (retirada automática).
- Relacionado à US-008 (suspender/retomar) e à US-047 (encaminhar; numeração em `START`, que define quando um rascunho deixa de ser "sem número").

## Objetivo
Permitir encerrar, em poucos segundos, processos que não devem continuar: 100% dos cancelamentos registram motivo, encerram aprovações pendentes e a etapa ativa; 100% dos descartes ficam restritos a rascunhos sem número, sem deixar aprovação, etapa ou atribuição ativa apontando para um registro inacessível.

## Persona
- **Principal:** Gestor de contratações (`GESTOR_CONTRATACOES`, escopo que cubra o processo).
- **Secundárias:** autoridade competente com `PROCESS_CANCEL` em escopo amplo; o próprio criador do rascunho sem número, para descartar.

## Pré-condições
- Usuário autenticado, tenant ativo, vínculo ativo.
- Processo existe, é visível (DEC-024) e não está em status final (`CANCELED`, `COMPLETED`, `PUBLISHED`) — para cancelar.
- Para descartar: processo em `DRAFT` com `number` e `code` nulos (FA-03 da US-001).
- Usuário tem `PROCESS_CANCEL` cobrindo o processo (cancelar); ou é o criador com `PROCESS_CREATE`, ou tem `PROCESS_CANCEL` (descartar).

## Fluxo principal
1. No painel do processo (SCR-006), menu "Mais" mostra "Cancelar processo" (sempre) ou "Descartar rascunho" (só em rascunho sem número).
2. **Cancelar:** diálogo SCR-116 pede justificativa (mín. 20 caracteres) e lista o que será encerrado (ex.: "1 aprovação pendente será cancelada"). Ao confirmar, o front envia `POST /processes/{id}/cancel` com `If-Match`.
3. A API, em transação: valida status não final e `PROCESS_CANCEL` (POL-06); cancela toda `Approval` `PENDING` do processo (`ApprovalCanceled`, motivo `PROCESS_CANCELED`); documentos `IN_REVIEW` cobertos voltam a `DRAFT`; encerra a `ProcessStage` ativa (`CANCELED`) e o `ProcessAssignment` ativo; grava `Process.status = CANCELED`, `canceledAt`, `canceledById`, `cancellationReason`; registra `ProcessMovement` (`CANCEL`); grava auditoria `process.cancel`, evento `ProcessStatusChanged`/`ProcessCanceled` e a entrada de timeline.
4. API responde 200; front exibe "Processo cancelado" e bloqueia as ações do painel.
5. **Descartar:** diálogo confirma a exclusão (justificativa opcional); front envia `DELETE /processes/{id}` com `If-Match`.
6. A API valida `code IS NULL`; aplica exclusão lógica (`deletedAt`, `deletedById`); encerra `ProcessStage`/`ProcessAssignment` ativos; grava auditoria `process.discard_draft` e o evento `ProcessDraftDiscarded` (sem entrada de timeline — o processo deixa de existir para efeitos práticos).
7. API responde 204; front navega para a lista com "Rascunho descartado".

## Fluxos alternativos
- **FA-01 — Descartar processo já numerado:** API responde 409 `CANNOT_DISCARD_NUMBERED_PROCESS`; a UI oferece "Cancelar processo" em vez disso.
- **FA-02 — Cancelar com aprovação pendente:** o diálogo avisa a quantidade de aprovações que serão canceladas antes de confirmar.
- **FA-03 — Cancelar processo suspenso:** permitido (DEC-013); `statusBeforeSuspension` é descartado junto com o cancelamento.
- **FA-04 — Justificativa insuficiente:** botão "Cancelar processo" permanece desabilitado até atingir 20 caracteres.
- **FA-05 — Sem `PROCESS_CANCEL`, mas criador de rascunho sem número:** o menu "Mais" oferece apenas "Descartar rascunho".

## Regras de negócio
- **RN-PROC-103** — Cancelamento permitido a partir de `DRAFT`, `IN_PROGRESS`, `AWAITING_APPROVAL`, `RETURNED` e `SUSPENDED` (DEC-013); em status final, `INVALID_PROCESS_STATUS` (409).
- **RN-PROC-104** — `cancellationReason` obrigatória, ≥ 20 caracteres, trim; persistida somente quando `status = CANCELED` (check de banco). No descarte, o motivo é opcional e não é persistido como coluna do processo (DEC-034).
- **RN-PROC-105** — Descarte (`PRC-06`) só é aceito com `number` e `code` nulos; caso contrário, `CANNOT_DISCARD_NUMBERED_PROCESS` (409).
- **RN-PROC-106** — Ao cancelar, toda `Approval` `PENDING` do processo é cancelada na mesma transação (`ApprovalCanceled`, motivo `PROCESS_CANCELED`); `Document` `IN_REVIEW` coberto por essa aprovação retorna a `DRAFT` (retirada automática, motivo "Processo cancelado").
- **RN-PROC-107** — A `ProcessStage` ativa muda para `CANCELED` (`exitedAt`, `exitedViaMovementId`); o `ProcessAssignment` ativo é encerrado (`endedAt`, `isActive = false`).
- **RN-PROC-108** — Descarte é exclusão lógica (`deletedAt`/`deletedById`); o processo some das listagens e buscas padrão (DEC-024 exige `deleted_at IS NULL`); nada é removido fisicamente (DEC-034).
- **RN-PROC-109** — Descarte também encerra `ProcessStage`/`ProcessAssignment` ativos, para não deixar vínculo ativo apontando a um processo excluído.
- **RN-PROC-110** — Quem pode descartar: o criador com `PROCESS_CREATE`, ou qualquer titular de `PROCESS_CANCEL` cobrindo o processo; quem pode cancelar: titular de `PROCESS_CANCEL` cobrindo o processo (POL-06), sem exigência de custódia (POL-01 não se aplica ao cancelamento).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Motivo do cancelamento | `cancellationReason` | texto longo | Sim (cancelar) | ≥ 20 caracteres; trim | — |
| Motivo do descarte | — (metadata de auditoria; não persiste coluna) | texto longo | Não (descartar) | até 500 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Justificativa ausente ou curta ao cancelar | Front + API | "A justificativa deve ter pelo menos 20 caracteres." | `VALIDATION_ERROR` (`TOO_SHORT`) |
| V-02 | Status já final | API | "Este processo já foi encerrado e não pode ser alterado." | `INVALID_PROCESS_STATUS` |
| V-03 | Descartar rascunho com número atribuído | API | "Este processo já tem número; cancele-o em vez de descartar." | `CANNOT_DISCARD_NUMBERED_PROCESS` |
| V-04 | Sem `PROCESS_CANCEL`/criador no descarte | API | "Você não tem permissão para esta ação." | `PERMISSION_DENIED` |
| V-05 | `If-Match` ausente/divergente | API | "Recarregue a página e tente novamente." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `PROCESS_CANCEL` cobrindo o processo (cancelar); `PROCESS_CREATE` do próprio criador **ou** `PROCESS_CANCEL` (descartar rascunho sem número) — PRC-06/PRC-25.
- **Políticas:** POL-06 (cancelar — justificativa, status não final, cancela aprovações pendentes). O descarte não exige POL-01 (custódia): o criador ou um titular de `PROCESS_CANCEL` pode agir mesmo sem estar com o processo.
- **MFA:** `PROCESS_CANCEL` tem riscoH; exigida conforme POL-14 quando aplicável ao perfil, ou se `security.mfaPolicy = ALL`.
- **Sem permissão:** "Cancelar processo"/"Descartar rascunho" não aparecem no menu "Mais"; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessStatusChanged` / `ProcessCanceled` | `process.status_changed.canceled` | Commit do cancelamento | `fromStatus`, `toStatus = CANCELED`, `reasonProvided = true` |
| `ApprovalCanceled` | `approval.canceled` | Aprovação(ões) pendente(s) canceladas na mesma transação | motivo `PROCESS_CANCELED` |
| `ProcessDraftDiscarded` | `process.draft_discarded` | Commit do descarte | `reasonProvided` |

Projeção síncrona no cancelamento: entrada `PROCESS_CANCELED` na timeline. O descarte não gera entrada de timeline (o processo deixa de ser visível).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `PROCESS_STATUS_CHANGED` (cancelado) | Criador, responsável atual (se houver), participantes com `notify = true` | IN_APP; e-mail desligado por padrão (preferência do usuário — US-113) | Ao confirmar o cancelamento (`ProcessStatusChanged`); timeline `PROCESS_CANCELED` com `reason` |
| — | — | — | Descarte de rascunho (`ProcessDraftDiscarded`) não notifica — o processo nunca saiu da custódia do criador |

## Critérios de aceite em Gherkin
```gherkin
Feature: Cancelar processo ou descartar rascunho

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And a usuária "Carla" possui "PROCESS_CANCEL" cobrindo a "Secretaria de Obras"

  Scenario: [Sucesso] Cancelar processo em andamento com aprovação pendente
    Given que o processo "0012/2026" está "AWAITING_APPROVAL" com 1 aprovação pendente
    When "Carla" cancelar o processo com a justificativa "Demanda já atendida por contrato vigente"
    Then o processo deve passar para o status "CANCELED" com "cancellationReason" preenchida
    And a aprovação pendente deve ser cancelada com motivo "PROCESS_CANCELED"
    And a etapa ativa deve ser encerrada com status "CANCELED"
    And deve gerar registro de auditoria "process.cancel"
    And deve gerar o evento "ProcessStatusChanged"

  Scenario: [Sucesso] Descartar rascunho sem número
    Given que o processo está em "DRAFT" sem "number" e sem "code", criado por "Carla"
    When "Carla" descartar o rascunho
    Then o processo deve receber "deletedAt" preenchido e deixar de aparecer na lista
    And deve gerar registro de auditoria "process.discard_draft"
    And deve gerar o evento "ProcessDraftDiscarded"

  Scenario: [Validação] Descartar rascunho que já tem número
    Given que o processo "0013/2026" está em "DRAFT" com número atribuído
    When "Carla" tentar descartar esse processo
    Then a API deve responder 409 com código "CANNOT_DISCARD_NUMBERED_PROCESS"

  Scenario: [Permissão] Usuário sem PROCESS_CANCEL tenta cancelar
    Given que o usuário "Bruno" possui apenas o perfil "SOMENTE_LEITURA"
    When "Bruno" enviar POST para "/api/v1/processes/{id}/cancel"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "PROCESS_CANCEL"

  Scenario: [Tenant incorreto] Cancelar processo de outro tenant
    Given que o processo "0099/2026" pertence ao tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", enviar POST para cancelar "0099/2026"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser alterado

  Scenario: [Duplicidade] Reenviar o cancelamento após sucesso
    Given que o processo "0012/2026" já foi cancelado por "Carla"
    When "Carla" enviar novamente o mesmo POST de cancelamento
    Then a API deve responder 409 com código "INVALID_PROCESS_STATUS"
    And nenhuma nova aprovação ou movimentação deve ser gerada

  Scenario: [Concorrência] Cancelamento simultâneo em duas abas
    Given que "Carla" tem o processo "0012/2026" aberto em duas abas na versão "3"
    When as duas abas enviarem o cancelamento simultaneamente com "If-Match: \"3\""
    Then uma requisição deve responder 200 com o processo "CANCELED"
    And a outra deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível durante o cancelamento
    Given que o banco de dados fica indisponível durante a transação de cancelamento
    When "Carla" confirmar o cancelamento do processo "0012/2026"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And o processo deve permanecer no status anterior, sem aprovação cancelada

  Scenario: [Falha de integração] Relay do outbox indisponível ao cancelar
    Given que o relay do outbox está indisponível
    When "Carla" cancelar o processo "0012/2026"
    Then o processo deve ser cancelado e a API deve responder 200
    And o evento "ProcessStatusChanged" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Justificativa ausente/curta ao cancelar | 422 | `VALIDATION_ERROR` | "A justificativa deve ter pelo menos 20 caracteres." | Foca o campo; botão desabilitado |
| Status já final | 409 | `INVALID_PROCESS_STATUS` | "Este processo já foi encerrado." | Atualiza o painel; oculta a ação |
| Descartar rascunho numerado | 409 | `CANNOT_DISCARD_NUMBERED_PROCESS` | "Este processo já tem número; cancele-o." | Oferece "Cancelar processo" |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta a ação |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente novamente." | Recarrega o processo |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Este processo foi alterado por outra pessoa." | Recarrega e mostra o estado atual |
| Recurso de outro tenant/inexistente | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | Redireciona à lista |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir a ação agora." | Botão "Tentar novamente"; correlationId |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-001 (processo precisa existir; descarte só no cenário FA-03 de numeração em `START`), US-051 (pré-requisito funcional indicado no backlog do épico).
- **Decisões/ADRs:** DEC-013, DEC-018, DEC-024, DEC-034, DEC-055, DEC-104, DEC-105.
- **Configurações:** nenhuma específica.
- **Lacunas nas fontes canônicas:** nenhuma (notificação canônica `PROCESS_STATUS_CHANGED` — events.md §6).

## Impacto técnico
- Reutiliza o `TransactionalCommandHandler` da US-001. O cancelamento toca múltiplos agregados filhos (`Approval`, `Document`, `ProcessStage`, `ProcessAssignment`) na mesma transação; como há só uma etapa ativa por processo (DEC-014), o número de aprovações pendentes a cancelar é tipicamente 0 ou 1 no MVP 1.
- Descartar é a única ação do módulo `process` que usa exclusão lógica no próprio agregado `Process`; os índices únicos de `code`/`internalCode` já contemplam `deleted_at IS NULL`.

## Backend
- **Módulo(s):** `process` (dono); usa `workflow` (encerrar etapa), `audit`, `platform` (outbox).
- **Casos de uso:** `CancelProcessCommand` → `CancelProcessHandler`; `DiscardDraftProcessCommand` → `DiscardDraftProcessHandler`.
- **Domínio:** `Process.cancel(reason)` (RN-PROC-103..107, emite `ProcessStatusChanged`); `Process.discardDraft()` (RN-PROC-108/109, emite `ProcessDraftDiscarded`); `Approval.cancel(reason)` chamada internamente pelo handler de cancelamento.
- **Transação:** padrão da US-001 (tenant → autorização → domínio → repositórios → projeções → auditoria → outbox → commit), em uma única transação por ação.

## Frontend
- **Tela(s):** SCR-006 (menu "Mais"), SCR-116 (diálogos).
- **Componentes:** `ConfirmDialog` com `Textarea` (contador de caracteres) e lista de impactos ("1 aprovação pendente será cancelada").
- **Estados:** botão com loading; diálogo bloqueado durante a requisição; erro inline.
- **Acessibilidade e responsividade:** foco inicial no campo de justificativa; aviso de impacto associado via `aria-describedby`; utilizável em 360 px.

## Banco de dados
- **Tabelas:** `processes` (`status`, `canceledAt`, `canceledById`, `cancellationReason`, `deletedAt`, `deletedById`), `approvals`, `process_stages`, `process_assignments`, `process_movements`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma nova (colunas já previstas em entities.md §4.4).
- **Índices/constraints relevantes:** check `status <> 'CANCELED' OR cancellation_reason IS NOT NULL`; índice único parcial de `code`/`internalCode` `WHERE deleted_at IS NULL` já cobre o descarte.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-25 | POST | `/api/v1/processes/{id}/cancel` | `{ cancellationReason }` + `If-Match` | `200 { data: Process }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| PRC-06 | DELETE | `/api/v1/processes/{id}` | `If-Match` | `204` | 204, 403, 404, 409, 412, 428, 503 |

## Logs
- `info` `process.canceled` — `processId`, `fromStatus`, `pendingApprovalsCanceled`, `durationMs`, `correlationId`.
- `info` `process.draft_discarded` — `processId`, `correlationId`.
- `error` `process.cancel_failed` / `process.discard_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** `cancellationReason`, título/objeto do processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.cancel` | `DATA_CHANGE` | Commit do cancelamento | `changes`: `status`; `metadata`: hash da justificativa, `pendingApprovalsCanceled` |
| `process.discard_draft` | `DATA_CHANGE` | Commit do descarte | `metadata`: `reasonProvided` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = PROCESS_CANCEL` |

## Testes necessários
- **Unitários:** `Process.cancel`/`discardDraft` (RN-PROC-103..110); rejeição em status finais.
- **Integração (Testcontainers):** cancelamento cancela aprovação pendente e devolve documento `IN_REVIEW` a `DRAFT` na mesma transação; descarte aplica soft delete.
- **Concorrência:** duas requisições de cancelamento simultâneas na mesma versão → uma 200, outra 412.
- **API/contrato:** snapshots 200/204/409/412 conforme api.md.
- **RBAC e multi-tenant:** matriz de perfis para cancelar/descartar; processo de outro tenant → 404.
- **E2E (Playwright):** cancelar com aprovação pendente; descartar rascunho; tentar descartar processo numerado.
- **Acessibilidade/performance:** axe no diálogo; p95 < 400 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados e passando no CI
- [ ] `PROCESS_CANCEL`/`PROCESS_CREATE` aplicados na API; ações ocultas sem permissão
- [ ] Cancelamento de aprovações pendentes e retorno de documentos a `DRAFT` cobertos por teste
- [ ] Exclusão lógica do descarte verificada (índices parciais, invisibilidade em listagens)
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-06 e PRC-25 compatível com api.md
- [ ] Logs sem dados sensíveis
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — regra de negócio e transação concentradas num único agregado (`Process` e seus filhos diretos), reaproveitando diálogos padrão (SCR-116) e o padrão transacional da US-001; superfície menor que a criação.

## Prioridade
**P0** — sem cancelar/descartar, processos abertos por erro ou duplicados nunca saem da lista ativa, poluindo filas e métricas de produtividade desde o primeiro mês de uso.

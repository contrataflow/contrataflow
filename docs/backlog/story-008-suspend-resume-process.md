---
id: US-008
title: "Suspender e retomar processo"
epic: EP-001
feature: FT-005
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-047, US-055]
modules: [process, approval, catalog, timeline, notification, audit, platform]
screens: [SCR-116, SCR-006]
endpoints: [PRC-23, PRC-24]
permissions: [PROCESS_SUSPEND]
events: [ProcessStatusChanged]
---

# US-008 — Suspender e retomar processo

## Título
Suspender e retomar o processo

## Descrição
**Como** gestor de contratações (ou autoridade competente), **quero** suspender um processo com motivo e retomá-lo depois, **para** registrar formalmente uma paralisação (ex.: aguardando definição orçamentária, determinação do tribunal de contas) sem que os prazos corram nem que alguém tramite ou decida durante a pausa.

A suspensão muda o status para `SUSPENDED`, guarda o status anterior, pausa o prazo da etapa ativa, congela as aprovações pendentes e bloqueia as ações de custódia. A retomada restaura o status anterior e estende o prazo pelos dias úteis em que o processo ficou suspenso. Ambas são feitas por diálogo (SCR-116) no detalhe do processo e registradas na tramitação, timeline, auditoria e notificações.

## Contexto
- Paralisações hoje ficam em despachos soltos; os prazos continuam "correndo" nas planilhas e geram falsos atrasos.
- DEC-013: `SUSPENDED` guarda `statusBeforeSuspension`, pausa prazos e congela aprovações; DEC-031: ao retomar, `dueAt` é estendido pelo tempo pausado; POL-07 define permissão, estados de origem e motivo obrigatório; POL-03 impede decidir aprovações com o processo suspenso.
- Cálculo de dias úteis e job `deadlines` são de US-055/US-106; esta story usa o calendário e ajusta o prazo na retomada (jornada J-06 de acceptance-criteria.md).

## Objetivo
Garantir que 100% dos processos suspensos tenham motivo, autor e data registrados, nenhum alerta de prazo seja emitido durante a suspensão e o prazo da etapa seja estendido exatamente pelos dias úteis suspensos na retomada.

## Persona
- **Principal:** Gestor de contratações (`GESTOR_CONTRATACOES`).
- **Secundárias:** Autoridade competente (`AUTORIDADE_COMPETENTE`); requisitante, responsável e participantes — informados pela notificação.

## Pré-condições
- Processo visível; usuário com `PROCESS_SUSPEND` em escopo que cubra o processo.
- Para suspender: processo em `IN_PROGRESS`, `AWAITING_APPROVAL` ou `RETURNED`. Para retomar: processo `SUSPENDED`.
- Calendário de dias úteis disponível (US-106) e prazos de etapa calculados (US-055).

## Fluxo principal
**Suspender**
1. No detalhe (SCR-006), o gestor escolhe **"Suspender"** no menu "Mais" (ação `SUSPEND` de PRC-08).
2. O diálogo (SCR-116) explica os efeitos ("Os prazos ficam pausados e ninguém poderá tramitar ou decidir aprovações até a retomada.") e pede o **Motivo** (obrigatório).
3. O front envia `POST /api/v1/processes/{id}/suspend` (PRC-23) com `{ reason }`, `If-Match` e `Idempotency-Key`.
4. A API, em uma transação com `app.tenant_id` e `SELECT … FOR UPDATE` no processo: valida o corpo; confere `If-Match`; autoriza `PROCESS_SUSPEND` + POL-07 (RN-PROC-93); grava `status = SUSPENDED`, `statusBeforeSuspension`, `suspendedAt`, `suspendedById`, `suspensionReason` (RN-PROC-94); marca `pausedAt` na etapa ativa (RN-PROC-95); registra `ProcessMovement` `SUSPEND`; grava auditoria, evento e timeline (RN-PROC-101).
5. A API responde **200** com o processo (`status = SUSPENDED`) e novo `ETag`; o painel passa a exibir "Suspenso desde DD/MM/AAAA — {motivo}" e o badge "Prazo pausado".
6. O worker envia `PROCESS_STATUS_CHANGED` ao criador, ao responsável atual e aos participantes com `notify` (exceto o autor).

**Retomar**
7. O gestor escolhe **"Retomar"** (ação primária quando o processo está suspenso — RN-PROC-49 de US-004); o diálogo mostra o período suspenso, os dias úteis que serão acrescidos ao prazo da etapa e o novo prazo calculado, e aceita um **Comentário** opcional.
8. O front envia `POST /api/v1/processes/{id}/resume` (PRC-24) com `{ comment? }`, `If-Match` e `Idempotency-Key`.
9. A API, na mesma estrutura transacional: restaura o status (RN-PROC-97), estende o prazo da etapa e da aprovação pendente (RN-PROC-98, RN-PROC-99), registra `ProcessMovement` `RESUME`, auditoria, evento e timeline.
10. A API responde **200**; o painel volta a mostrar o status anterior e o novo prazo; o worker notifica os mesmos destinatários.

## Fluxos alternativos
- **FA-01 — Suspensão em aprovação:** em `AWAITING_APPROVAL`, a aprovação permanece `PENDING`, mas o aprovador vê "Processo suspenso — decisão indisponível até a retomada" e a decisão é recusada (RN-PROC-96).
- **FA-02 — Etapa sem prazo:** sem `dueAt`, a retomada apenas acumula `pausedTotalSeconds`; o diálogo informa "Esta etapa não tem prazo definido."
- **FA-03 — Etapa já atrasada antes da suspensão:** o badge mostra "Prazo pausado (estava atrasado)"; na retomada, se o novo prazo ainda estiver vencido, o atraso continua (RN-PROC-99).
- **FA-04 — Mesmo dia:** suspensão e retomada na mesma data local não estendem o prazo (0 dia útil); o diálogo informa "Nenhum dia útil será acrescentado."
- **FA-05 — Cancelar processo suspenso:** permitido (US-009); a pausa é encerrada no cancelamento.
- **FA-06 — Prazo alvo:** na retomada, o diálogo lembra "O prazo alvo continua DD/MM/AAAA" com o atalho "Revisar prazo alvo" (US-005), sem alterá-lo automaticamente (RN-PROC-100).

## Regras de negócio
- **RN-PROC-93** — Suspender exige `PROCESS_SUSPEND` com escopo que cubra o processo (POL-07), **sem** exigência de custódia, e só a partir de `IN_PROGRESS`, `AWAITING_APPROVAL` ou `RETURNED` (DEC-013). Em `DRAFT`, `SUSPENDED` ou status final → 409 `INVALID_PROCESS_STATUS`.
- **RN-PROC-94** — Motivo obrigatório, de 20 a 5.000 caracteres, gravado em `suspensionReason` e como `comment` do `ProcessMovement` `SUSPEND` (com `statusFrom`, `statusTo = SUSPENDED`, etapa e unidade atuais como origem e destino, IP, user-agent e `correlationId`). `statusBeforeSuspension` recebe o status anterior; `suspendedAt`/`suspendedById` são preenchidos.
- **RN-PROC-95** — Pausa: a etapa ativa recebe `pausedAt = agora`. O job `deadlines` ignora etapas com `pausedAt` preenchido (nenhum `ProcessStageDueSoon`/`ProcessStageOverdue` durante a suspensão). Um `overdueSince` anterior é mantido, mas o processo suspenso não aparece em "Atrasados" (RN-PROC-23).
- **RN-PROC-96** — Congelamento: com o processo `SUSPENDED`, são recusadas com 409 `INVALID_PROCESS_STATUS` as ações de encaminhar, devolver, assumir, atribuir, concluir, editar dados, itens e etiquetas, editar/finalizar/submeter/reabrir documentos (POL-01, POL-02, POL-08, POL-11) e decidir aprovações (POL-03). A aprovação pendente permanece `PENDING`. Continuam permitidos: consultar, comentar, seguir, gerenciar participantes, definir sigilo (US-013), cancelar (US-009) e retomar.
- **RN-PROC-97** — Retomar exige `PROCESS_SUSPEND` cobrindo o processo e status `SUSPENDED`; restaura `status = statusBeforeSuspension` e limpa `statusBeforeSuspension`, `suspendedAt`, `suspendedById` e `suspensionReason` (o histórico permanece nos movimentos `SUSPEND`/`RESUME`, na timeline e na auditoria). Comentário opcional (até 5.000 caracteres) no movimento `RESUME`.
- **RN-PROC-98** — Extensão do prazo na retomada (DEC-031): `n` = dias úteis do calendário do tenant (feriados e `calendar.optionalHolidaysAreNonBusiness`) no intervalo [data local de `pausedAt`, data local da retomada) — ou dias corridos se `slaType = CALENDAR`; novo `dueAt` = `dueAt` acrescido de `n` dias úteis (ou corridos), mantendo o fim do dia no fuso do tenant; `pausedTotalSeconds` += (retomada − `pausedAt`); `pausedAt = null`; `Process.currentStageDueAt` atualizado. Etapa sem `dueAt` só acumula a pausa.
- **RN-PROC-99** — Após a extensão: se agora > novo `dueAt`, o atraso permanece; senão `overdueSince` da etapa e do processo é limpo, e `dueSoonNotifiedAt`/`overdueNotifiedAt` são zerados para permitir novos alertas. A aprovação `PENDING` da etapa tem seu `dueAt` estendido pelos mesmos `n` dias (fachada de `approval`).
- **RN-PROC-100** — `targetDate` (prazo alvo) não é estendido: é informativo (DEC-031); a retomada apenas sugere revisá-lo.
- **RN-PROC-101** — Efeitos na mesma transação: versão do processo incrementada; `ProcessStatusChanged` (`fromStatus`, `toStatus`, `cause` = `SUSPEND` ou `RESUME`, `reasonProvided`) publicado com as routing keys `process.status_changed.suspended` / `process.status_changed.resumed`; timeline `PROCESS_SUSPENDED` / `PROCESS_RESUMED` (`params.reason`); auditoria `process.suspend` / `process.resume`. A notificação `PROCESS_STATUS_CHANGED` é assíncrona.
- **RN-PROC-102** — Suspender e retomar não alteram etapa, unidade, responsável, atribuição nem concessões `ProcessAccess`.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Motivo da suspensão | `reason` → `Process.suspensionReason`, `ProcessMovement.comment` | texto longo | Sim | 20–5.000 caracteres | — |
| Comentário da retomada | `comment` → `ProcessMovement.comment` | texto longo | Não | até 5.000 | — |
| *(sistema)* Status anterior | `statusBeforeSuspension` | `ProcessStatus` | — | RN-PROC-94/97 | status atual |
| *(sistema)* Suspenso em / por | `suspendedAt`, `suspendedById` | data-hora / usuário | — | — | agora / ator |
| *(sistema)* Pausa da etapa | `ProcessStage.pausedAt`, `pausedTotalSeconds` | data-hora / inteiro | — | RN-PROC-95/98 | — |
| *(sistema)* Novo prazo | `ProcessStage.dueAt`, `Process.currentStageDueAt`, `Approval.dueAt` | data-hora | — | RN-PROC-98/99 | calculado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Motivo ausente ou curto/longo | Front + API | "Informe o motivo da suspensão (mínimo de 20 caracteres)." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`/`TOO_LONG`) |
| V-02 | Status de origem inválido (suspender) | API | "Só é possível suspender processos em andamento, aguardando aprovação ou devolvidos." | `INVALID_PROCESS_STATUS` |
| V-03 | Retomar processo não suspenso | API | "Este processo não está suspenso." | `INVALID_PROCESS_STATUS` |
| V-04 | Ação de custódia ou decisão com processo suspenso | API | "O processo está suspenso. Retome-o para continuar." | `INVALID_PROCESS_STATUS` |
| V-05 | `If-Match` ausente / divergente | API | "O processo foi alterado por outra pessoa. Recarregue e tente novamente." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `PROCESS_SUSPEND` (risco `M`, com escopo) para suspender e retomar — perfis padrão `GESTOR_CONTRATACOES` e `AUTORIDADE_COMPETENTE`.
- **Políticas:** POL-07; efeitos sobre POL-01, POL-02, POL-03, POL-08 e POL-11 durante a suspensão.
- **MFA:** não exigido, salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** "Suspender"/"Retomar" ocultos; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessStatusChanged` (`ProcessSuspended`) | `process.status_changed.suspended` | Commit da suspensão | `fromStatus`, `toStatus = SUSPENDED`, `cause = SUSPEND`, `reasonProvided = true` |
| `ProcessStatusChanged` (`ProcessResumed`) | `process.status_changed.resumed` | Commit da retomada | `fromStatus = SUSPENDED`, `toStatus` = status restaurado, `cause = RESUME` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `PROCESS_STATUS_CHANGED` | Criador, responsável atual e participantes com `notify` (nunca o autor) | In-app (e-mail desativado por padrão) | Suspensão e retomada |

Corpo sem dados sigilosos: "O processo 0012/2026 foi suspenso por Patrícia Almeida: {motivo resumido em até 140 caracteres}." Link: `/processos/{id}`.

## Critérios de aceite em Gherkin
```gherkin
Feature: Suspender e retomar processo

  Background:
    Given que o tenant "Prefeitura de São José" está ativo, com fuso "America/Sao_Paulo" e o feriado nacional "2026-10-12"
    And o processo "0012/2026", criado por "Ana", está "IN_PROGRESS" na etapa "PESQUISA_PRECOS" com "Juliana" como responsável
    And o prazo da etapa é "2026-10-09" (dias úteis)
    And "Patrícia" possui o perfil "GESTOR_CONTRATACOES" com escopo "TENANT"

  Scenario: [Sucesso] Suspender processo com motivo
    When "Patrícia" suspender o processo em "2026-10-06 10:00" com o motivo "Aguardando definição da dotação pela Secretaria de Finanças"
    Then o processo deve ficar "SUSPENDED" com "statusBeforeSuspension" igual a "IN_PROGRESS"
    And a etapa ativa deve ter "pausedAt" igual a "2026-10-06 10:00"
    And deve existir uma tramitação "SUSPEND" com o motivo como comentário
    And deve gerar o evento "ProcessStatusChanged" com routing key "process.status_changed.suspended"
    And deve existir a entrada "PROCESS_SUSPENDED" na timeline e o registro de auditoria "process.suspend"
    And "Ana" e "Juliana" devem receber a notificação "PROCESS_STATUS_CHANGED" e "Patrícia" não

  Scenario: [Sucesso] Retomar e estender o prazo pelos dias úteis suspensos
    Given que o processo foi suspenso em "2026-10-06 10:00"
    When "Patrícia" retomar o processo em "2026-10-13 15:00"
    Then o processo deve voltar a "IN_PROGRESS" e "statusBeforeSuspension" deve ficar vazio
    And o prazo da etapa deve passar de "2026-10-09" para "2026-10-16", pois 4 dias úteis foram suspensos (06, 07, 08 e 09/10; 12/10 é feriado)
    And "pausedTotalSeconds" deve ser 622800 e "pausedAt" deve ficar vazio
    And deve gerar o evento com routing key "process.status_changed.resumed" e a entrada "PROCESS_RESUMED" na timeline

  Scenario: [Sucesso] Aprovação pendente congelada e estendida
    Given que o processo "0031/2026" está "AWAITING_APPROVAL" com aprovação pendente de "Roberto" com prazo "2026-10-08"
    When "Patrícia" suspender o processo em "2026-10-06" e retomá-lo em "2026-10-08"
    Then a aprovação deve permanecer "PENDING" durante toda a suspensão
    And o prazo da aprovação deve passar a "2026-10-13", acrescido de 2 dias úteis
    And o processo deve voltar a "AWAITING_APPROVAL"

  Scenario: [Validação] Motivo curto e estado de origem inválido
    When "Patrícia" suspender o processo com o motivo "Pausa"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_SHORT" no campo "reason"
    Given que o processo "0060/2026" está "DRAFT"
    When "Patrícia" tentar suspendê-lo
    Then a API deve responder 409 com código "INVALID_PROCESS_STATUS"

  Scenario: [Permissão] Usuário sem PROCESS_SUSPEND e ações bloqueadas durante a suspensão
    Given que "Ana" possui apenas o perfil "REQUISITANTE"
    When "Ana" enviar POST para "/api/v1/processes/{id}/suspend"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e registrar "access.denied"
    Given que o processo "0031/2026" está suspenso
    When "Roberto" tentar decidir a aprovação pendente e "Juliana" tentar encaminhar o processo
    Then ambos devem receber 409 com código "INVALID_PROCESS_STATUS"
    And o painel deve mostrar "Processo suspenso — decisão indisponível até a retomada"

  Scenario: [Tenant incorreto] Processo de outro tenant e tenant suspenso
    When "Patrícia" suspender um processo da "Prefeitura B"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"
    Given que o tenant "Prefeitura de São José" está "SUSPENDED"
    When "Patrícia" tentar retomar um processo
    Then a API deve responder 403 com código "TENANT_SUSPENDED"

  Scenario: [Duplicidade] Duplo clique em "Suspender"
    Given que "Patrícia" enviou a suspensão com a chave de idempotência "K7" e recebeu 200
    When a mesma requisição for reenviada com "K7"
    Then a API deve responder 200 com o mesmo resultado e "Idempotent-Replayed: true"
    And deve existir uma única tramitação "SUSPEND"
    When uma nova suspensão for enviada com a versão atual
    Then a API deve responder 409 com código "INVALID_PROCESS_STATUS"

  Scenario: [Concorrência] Suspensão e encaminhamento simultâneos
    Given que "Juliana" encaminha o processo enquanto "Patrícia" o suspende, ambas com "If-Match" igual a "12"
    When as duas requisições disputarem o bloqueio do processo
    Then apenas a primeira a obter o bloqueio deve ser aplicada
    And a segunda deve receber 412 com código "VERSION_CONFLICT"
    And o job "deadlines" executado durante a suspensão não deve marcar atraso na etapa pausada

  Scenario: [Falha de banco] Banco indisponível ao suspender
    Given que o banco de dados fica indisponível durante a transação
    When "Patrícia" suspender o processo
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o processo deve continuar "IN_PROGRESS" sem pausa, tramitação, timeline, auditoria ou evento

  Scenario: [Falha de integração] Fila de notificações indisponível
    Given que a fila "notifications" está indisponível
    When "Patrícia" suspender o processo
    Then a suspensão deve ser concluída e a API deve responder 200
    And quando a fila voltar, "Ana" e "Juliana" devem receber a notificação uma única vez
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Motivo inválido | 422 | `VALIDATION_ERROR` | "Informe o motivo da suspensão (mínimo de 20 caracteres)." | Erro no campo |
| Status incompatível (suspender/retomar/ações durante a suspensão) | 409 | `INVALID_PROCESS_STATUS` | "Ação indisponível com o processo {status}." | Recarrega o painel |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para suspender ou retomar este processo." | Ação oculta |
| Tenant suspenso / vínculo inativo | 403 | `TENANT_SUSPENDED` / `MEMBERSHIP_INACTIVE` | "Seu acesso a este órgão não está ativo." | SCR-111 |
| Processo não visível / outro tenant | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | SCR-111 |
| Versão divergente / ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "O processo foi alterado por outra pessoa." | Recarrega e reabre o diálogo com o texto digitado |
| Requisição idêntica em processamento / chave reutilizada | 409 / 422 | `IDEMPOTENCY_IN_PROGRESS` / `IDEMPOTENCY_KEY_REUSED` | "Estamos concluindo a operação." / "Esta solicitação já foi enviada com outros dados." | Aguarda e reconsulta / gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém o diálogo e o texto |

## Dependências
- **Stories:** US-047 (tramitação, `ProcessMovement` e bloqueio do processo), US-055 (prazos, job `deadlines` e cálculo de dias úteis). Relacionadas: US-106 (calendário), US-051/US-052 (aprovações congeladas), US-009 (cancelar processo suspenso), US-004 (ação primária "Retomar", badge "Prazo pausado"), US-111/US-112 (entrega das notificações).
- **Decisões/ADRs:** DEC-013, DEC-031, DEC-055, DEC-104, DEC-105, DEC-132, DEC-161, DEC-162.
- **Configurações:** `calendar.optionalHolidaysAreNonBusiness`, `deadlines.warnBeforeBusinessDays`, `notifications.emailEnabled`.
- **Lacunas nas fontes canônicas:**
  1. **Idempotência de PRC-23/PRC-24:** o catálogo de api.md não marca "Idem." nesses comandos, embora DEC-105 aceite `Idempotency-Key` em todo comando. Proposta: marcar "Idem." em PRC-23, PRC-24 e PRC-25.
  2. **Valores de `cause` em `ProcessStatusChanged`:** events.md não enumera; adotados `SUSPEND` e `RESUME`. Proposta: enumerar em events.md §4.1 (`SUSPEND`, `RESUME`, `CANCEL`, `COMPLETE`, `FORWARD`, `RETURN`, `APPROVAL_APPROVED`, `APPROVAL_RETURNED`, `APPROVAL_REJECTED`).
  3. **Aprovador da aprovação congelada** não está entre os destinatários de `PROCESS_STATUS_CHANGED`. Proposta: incluir aprovadores de aprovações `PENDING` do processo nesse tipo de notificação.
  4. **Extensão de `Approval.dueAt` na retomada** não está explícita em DEC-013/DEC-031 (que citam apenas "prazos"); adotada a mesma extensão da etapa.

## Impacto técnico
- Implementado no `ProcessLifecycleService` (único dono das mudanças de status — DEC-013), com `SELECT … FOR UPDATE` no processo e na etapa ativa, serializando com tramitação, decisões de aprovação e o job `deadlines`.
- O job `deadlines` (US-055) deve filtrar `paused_at IS NULL` em todas as consultas de vencimento e alerta; teste de regressão obrigatório.
- A extensão usa `BusinessCalendarFacade.businessDaysBetween(dateFrom, dateTo)` e `addBusinessDays(dueAt, n)` com o calendário do tenant (US-106); o cálculo é feito com datas locais do tenant (sem conversões ambíguas de horário de verão).
- A política de congelamento é verificada pelas próprias políticas (POL-01/02/03/08/11 já exigem status adequado); esta story acrescenta testes de não regressão para cada ação bloqueada.

## Backend
- **Módulo(s):** `process` (dono); `approval` (estender `dueAt` da aprovação pendente), `catalog` (calendário), `timeline`, `notification` (consumidor assíncrono), `audit`, `platform`.
- **Casos de uso:** `SuspendProcessCommand`, `ResumeProcessCommand`.
- **Domínio:** `ProcessLifecycleService.suspend(reason)` / `.resume(comment)`; `ProcessStage.pause(at)` / `.resumeAndExtend(at, calendar)`; `ProcessMovement.record(SUSPEND|RESUME)`.
- **Integrações internas:** `AuthorizationService.assertCan('PROCESS_SUSPEND', process)`, `BusinessCalendarFacade`, `ApprovalFacade.extendPendingDueAt(processStageId, n, slaType)`, `TimelineProjector`, `AuditService`, `OutboxWriter`, `IdempotencyService`.
- **Transação:** todos os efeitos de cada comando (processo, etapa, aprovação, movimento, timeline, auditoria, outbox) em uma transação.

## Frontend
- **Tela(s):** SCR-116 (diálogos "Suspender processo" e "Retomar processo") em SCR-006.
- **Componentes:** `SuspendProcessDialog` (efeitos explicados, campo "Motivo" com contador), `ResumeProcessDialog` (período suspenso, dias úteis acrescidos, novo prazo, lembrete do prazo alvo, comentário opcional), `SuspendedBanner` no painel ("Suspenso desde … — motivo … — por …").
- **Dados:** mutações com `If-Match` e `Idempotency-Key`; após sucesso, invalidar detalhe, resumo, ações, stepper, timeline, lista e caixa de tarefas.
- **Estados:** botão com "Suspendendo…/Retomando…"; erro mantém o texto digitado; prévia do novo prazo calculada no front com os mesmos feriados (`CAL-05`) e confirmada pela resposta da API.
- **Acessibilidade:** diálogos com foco preso, descrição dos efeitos associada (`aria-describedby`), contador de caracteres anunciado; banner com ícone e texto.
- **Responsivo:** diálogos em tela cheia abaixo de 768 px.

## Banco de dados
- **Tabelas escritas:** `processes`, `process_stages`, `approvals` (prazo), `process_movements`, `process_timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma (colunas já previstas em entities.md).
- **Índices/constraints relevantes:** check `status <> 'SUSPENDED' OR status_before_suspension IS NOT NULL`; check de `process_movements` exigindo `comment` em `SUSPEND`; índice `(tenant_id, due_at) WHERE status = 'ACTIVE'` usado pelo job (com filtro adicional `paused_at IS NULL`).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-23 | POST | `/api/v1/processes/{id}/suspend` | `{ reason }` + `If-Match` + `Idempotency-Key` | `200 { data: Process }` (`status`, `statusBeforeSuspension`, `suspendedAt`, `suspensionReason`, `currentStage.pausedAt`) + `ETag` | 200, 403, 404, 409, 412, 422, 428, 503 |
| PRC-24 | POST | `/api/v1/processes/{id}/resume` | `{ comment? }` + `If-Match` + `Idempotency-Key` | `200 { data: Process, meta: { extendedBy: { days, slaType }, newDueAt } }` + `ETag` | 200, 403, 404, 409, 412, 422, 428, 503 |

## Logs
- `info` `process.suspended` / `process.resumed` — `processId`, `fromStatus`, `toStatus`, `extendedDays`, `durationMs`.
- `warn` `process.lifecycle_conflict` — 409/412 com status atual.
- `error` `process.lifecycle_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** o texto do motivo ou do comentário.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.suspend` | `WORKFLOW` | Commit da suspensão | `changes`: `status`, `statusBeforeSuspension`, `suspendedAt`; `metadata`: `processCode`, `fromStatus`, `toStatus`, `reason` (texto), `idempotencyKey` |
| `process.resume` | `WORKFLOW` | Commit da retomada | `changes`: `status`, `currentStageDueAt` (antigo/novo); `metadata`: `pausedSeconds`, `extendedDays`, `approvalDueAtExtended` |
| `access.denied` | `ACCESS` | 403 | `reasonCode = PROCESS_SUSPEND` |

## Testes necessários
- **Unitários:** cálculo de `n` (mesmo dia, fim de semana, feriado, ponto facultativo com e sem `calendar.optionalHolidaysAreNonBusiness`, `CALENDAR`); restauração do status anterior; limpeza de `overdueSince` × atraso persistente.
- **Integração (Testcontainers):** transação única (falha induzida → nada muda); job `deadlines` ignora etapas pausadas; aprovação pendente estendida; cada ação bloqueada durante a suspensão retorna 409.
- **API/contrato:** PRC-23/24 conforme api.md; idempotência com replay.
- **RBAC e multi-tenant:** perfis com e sem `PROCESS_SUSPEND` e escopo; outro tenant → 404; tenant `SUSPENDED` → 403 (suíte "tenant leak").
- **Concorrência:** suspensão × encaminhamento × decisão de aprovação × job `deadlines` com bloqueio.
- **E2E (Playwright):** suspender, verificar painel e bloqueios, retomar e conferir o novo prazo (jornada J-06).
- **Acessibilidade:** axe nos diálogos.

## Definition of Done
- [ ] Cenários Gherkin automatizados e passando no CI, incluindo a jornada J-06
- [ ] POL-07 aplicada; ações congeladas recusadas durante a suspensão
- [ ] Extensão de prazo correta com feriados, comprovada por testes de calendário
- [ ] Evento, timeline, auditoria e notificação verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-23/24 compatível com api.md
- [ ] Diálogos acessíveis e utilizáveis em 360 px
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — dois comandos de ciclo de vida com efeitos coordenados em etapa, aprovação e prazos, cálculo de dias úteis na retomada, integração com o job de prazos e testes de congelamento de todas as ações de custódia.

## Prioridade
**P1** — necessária ao release (paralisações são frequentes e prazos falsamente vencidos comprometem a confiança no painel e no dashboard), mas não bloqueia o fluxo principal de planejamento.

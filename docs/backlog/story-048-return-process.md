---
id: US-048
title: "Devolver processo"
epic: EP-008
feature: FT-032
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-047]
modules: [process, workflow, access, timeline, audit, platform]
screens: [SCR-104]
endpoints: [PRC-20]
permissions: [PROCESS_RETURN]
events: [ProcessStageChanged, ProcessStatusChanged, ProcessAssigned]
---

# US-048 — Devolver processo

## Título
Devolver processo

## Descrição
**Como** responsável atual por um processo (custodiante), **quero** devolvê-lo para uma etapa anterior já percorrida, registrando o motivo, **para** que quem respondia por aquela etapa corrija ou complemente o que for necessário antes de o processo seguir adiante novamente.

A devolução move o processo de volta para uma `WorkflowStage` já percorrida, de preferência sob a responsabilidade de quem já havia atuado nela (política `PREVIOUS_ASSIGNEE`). Ela não altera documentos: nenhum `Document` muda de status automaticamente só porque o processo voltou de etapa (POL-11) — reabrir um documento já concluído é ação separada e explícita do novo custodiante. Esta story cobre a devolução direta, feita por quem está com o processo numa etapa de tarefa (`TASK`); quando o processo está em `AWAITING_APPROVAL`, a devolução acontece pela decisão `RETURN` do aprovador (US-052) ou pela retirada da solicitação (US-053) — nunca por esta ação.

## Contexto
- Continuação natural do encaminhamento (US-047): nem toda tramitação segue adiante — pendências, informações incompletas ou documentos que precisam de ajuste exigem devolver o processo a quem pode resolver.
- DEC-013 modela a devolução como a transição de status `IN_PROGRESS → RETURNED`. DEC-014/DEC-015 estabelecem que qualquer etapa pode devolver para etapas anteriores já percorridas (lista configurável por transição do workflow). DEC-023 (custódia) e a política POL-01 definem quem pode devolver e em que status. POL-11 garante que a devolução, por si só, não reabre documentos — isso evita que um ETP já aprovado "volte a ser rascunho" sem decisão explícita e justificada.
- Reaproveitar o responsável anterior da etapa de destino reduz re-trabalho: quem já conhece o contexto retoma o processo sem precisar ser procurado manualmente.

## Objetivo
Permitir que o custodiante devolva um processo para uma etapa anterior em até 30 segundos, com motivo obrigatório, responsável de destino resolvido automaticamente sempre que alguém já tiver respondido por aquela etapa antes (política `PREVIOUS_ASSIGNEE`) e sem qualquer alteração indevida no status dos documentos do processo.

## Persona
- **Principal:** quem detém a custódia do processo (`currentResponsibleId`) numa etapa do tipo `TASK`.
- **Secundárias:** membro da unidade atual (quando a etapa não tem responsável individual, só a fila); gestor de contratações acompanhando a tramitação.

## Pré-condições
- Processo com status `IN_PROGRESS`; usuário é o `currentResponsibleId` ou, se não houver, está lotado na `currentDepartmentId` (POL-01).
- Usuário possui `PROCESS_RETURN`.
- O processo já percorreu ao menos uma etapa anterior na versão de workflow fixada (existe `ProcessStage` com `status` `COMPLETED` ou `RETURNED` para uma `WorkflowStage` diferente da atual).

## Fluxo principal
1. No painel do processo (SCR-006), o usuário aciona **"Devolver"**.
2. O sistema abre o diálogo SCR-104 e lista como destino as `WorkflowStage` já percorridas pelo processo (nome e data da última passagem), restritas às permitidas como destino da transição `RETURN` configurada na etapa atual.
3. O usuário escolhe a **etapa de destino**, escreve o **motivo** (mínimo 10 caracteres) e, somente se a transição permitir sobrescrita, ajusta o **prazo** sugerido para a etapa de destino.
4. O usuário confirma. O front envia `POST /api/v1/processes/{id}/return` com `If-Match` (versão atual do processo) e `Idempotency-Key`.
5. A API, em uma transação com `app.tenant_id`:
   1. recarrega o processo com `SELECT … FOR UPDATE`; valida `If-Match` (`version`) e, se enviado, `expectedStageId`;
   2. autoriza POL-01 (`PROCESS_RETURN` + custódia) e confirma `status = IN_PROGRESS`;
   3. valida que `targetStageId` é uma `WorkflowStage` já percorrida pelo processo e está entre os destinos permitidos da transição `RETURN` da etapa atual;
   4. encerra a `ProcessStage` ativa (`status = RETURNED`, `exitedAt = now`, `exitedViaMovementId`);
   5. cria a nova `ProcessStage` para `targetStageId` (`sequence` seguinte, `status = ACTIVE`): a unidade é recalculada pela regra de `departmentResolution` da etapa (para `CHOSEN_ON_FORWARD`, reaproveita o `departmentId` da última passagem por aquela etapa, já que a devolução não coleta nova escolha); o responsável é resolvido por `PREVIOUS_ASSIGNEE` (regras de negócio); `dueAt` é recalculado em dias úteis a partir do `slaDays`/`slaType` da etapa, salvo prazo informado quando a transição permitir sobrescrita;
   6. encerra a `ProcessAssignment` ativa (`isActive = false`, `endedAt = now`) e cria a nova (`type = RETURN`) para o responsável resolvido (ou `assigneeId = null`, fila da unidade);
   7. cria `ProcessMovement` (`action = RETURN`, `fromProcessStageId`/`toProcessStageId`, `comment`, IP, user-agent, `correlationId`);
   8. atualiza no `Process`: `status = RETURNED`, `currentStageId`, `currentWorkflowStageId`, `currentDepartmentId`, `currentResponsibleId`, `currentStageDueAt`; incrementa `version`;
   9. atualiza `ProcessAccess` (`CURRENT` anterior → `HISTORICAL`; novo `CURRENT` para a unidade de destino; `RESPONSIBLE` para o novo responsável, se houver);
   10. grava `AuditLog` `process.return`, a entrada de timeline `PROCESS_RETURNED`, o evento `ProcessStageChanged` (`cause = RETURN`), `ProcessStatusChanged` (`toStatus = RETURNED`) e, havendo novo responsável individual, `ProcessAssigned` (`assignmentType = RETURN`);
   11. confirma a transação.
6. A API responde **200** com o processo atualizado e `ETag` com a nova versão.
7. O front invalida a caixa de tarefas e a timeline do processo, exibe o toast "Processo devolvido para {etapa}" e atualiza o painel situacional.

## Fluxos alternativos
- **FA-01 — Etapa de destino sem responsável anterior:** `PREVIOUS_ASSIGNEE` não encontra ninguém (só a fila da unidade já respondeu por ela) → a etapa de destino fica sem responsável individual, disponível para ser assumida (US-049).
- **FA-02 — Sobrescrita de prazo não permitida:** a transição `RETURN` não permite alterar o prazo → o campo não aparece no diálogo; `dueAt` é sempre recalculado pela SLA da etapa.
- **FA-03 — Única etapa anterior disponível:** havendo só uma opção já percorrida, o diálogo a pré-seleciona e avança direto para o motivo.
- **FA-04 — Reenvio após falha de rede:** o front reenvia com a mesma `Idempotency-Key`; a API devolve a resposta original (`Idempotent-Replayed: true`).

## Regras de negócio
- **RN-TRAM-23** — Quem pode devolver: custodiante atual (POL-01: `currentResponsibleId` ou, sem responsável, lotado na `currentDepartmentId`) com `PROCESS_RETURN`, e o processo deve estar `IN_PROGRESS`. Em `AWAITING_APPROVAL` a devolução ocorre apenas pela decisão `RETURN` (US-052) ou pela retirada (US-053) — tentativa de usar esta ação nesse status retorna `INVALID_PROCESS_STATUS` (409).
- **RN-TRAM-24** — `targetStageId` deve ser uma `WorkflowStage` com `ProcessStage` anterior de status `COMPLETED`/`RETURNED` no processo **e** constar entre os destinos configurados para a transição `RETURN` da etapa atual (DEC-015); caso contrário, `TRANSITION_NOT_AVAILABLE` (422).
- **RN-TRAM-25** — `comment` é obrigatório, 10–5.000 caracteres (alinhado ao `CHECK` de `process_movements`: ações `RETURN` exigem `comment`).
- **RN-TRAM-26** — `dueAt` é recalculado em dias úteis (CAL-06) a partir de `slaDays`/`slaType` da etapa de destino; só pode ser sobrescrito quando a transição `RETURN` permitir (`allowDueDateOverride`), caso contrário `DUE_DATE_OVERRIDE_NOT_ALLOWED` (422) se enviado.
- **RN-TRAM-27** — A unidade da etapa de destino é recalculada pela mesma regra de `departmentResolution` da `WorkflowStage` (`FIXED`, `REQUESTING_DEPARTMENT`, `REQUESTING_SECRETARIAT` recalculados normalmente a partir do processo; `CHOSEN_ON_FORWARD` reaproveita o `departmentId` da última passagem por aquela etapa, por não haver nova escolha no comando de devolução).
- **RN-TRAM-28** — Resolução do responsável por `PREVIOUS_ASSIGNEE`: é o `assigneeId` do `ProcessAssignment` mais recente (maior `startedAt`) entre as instâncias anteriores de `ProcessStage` com o mesmo `workflowStageId` neste processo; se nenhuma instância anterior teve responsável individual, a etapa de destino fica sem responsável (fila da unidade, `assigneeId = null`).
- **RN-TRAM-29** — A devolução não altera o `status` de nenhum `Document` do processo (POL-11): documentos permanecem no status em que estavam; reabrir um documento `FINALIZED`/`APPROVED`/`REJECTED` para edição é ação separada (`DOCUMENT_REOPEN`, POL-11) do novo custodiante.
- **RN-TRAM-30** — O comando aceita `expectedStageId` (opcional, id da `ProcessStage` ativa no momento em que a tela foi carregada); se enviado e diferente da etapa ativa real, a API responde `STAGE_CHANGED` (409) antes mesmo de avaliar `If-Match`, dando uma mensagem mais específica que o `VERSION_CONFLICT` (412) genérico de DEC-104.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Etapa de destino | `targetStageId` | seleção (`WorkflowStage`) | Sim | já percorrida; destino permitido da transição `RETURN`; RN-TRAM-24 | — |
| Motivo da devolução | `comment` | texto longo | Sim | 10–5.000 caracteres | — |
| Prazo | `dueAt` | data/hora | Condicional (transição permite sobrescrita) | futuro; dias úteis | recalculado pela SLA da etapa |
| *(técnico)* Etapa esperada | `expectedStageId` | uuid (`ProcessStage`) | Não | deve igualar a etapa ativa; RN-TRAM-30 | etapa ativa no carregamento da tela |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `targetStageId`/`comment` ausentes | Front + API (Zod) | "Informe o {campo}." | `VALIDATION_ERROR` |
| V-02 | `comment` com menos de 10 caracteres | Front + API | "O motivo deve ter ao menos 10 caracteres." | `VALIDATION_ERROR` |
| V-03 | `targetStageId` não percorrido ou fora dos destinos da transição | API | "Esta etapa não está disponível como destino da devolução." | `TRANSITION_NOT_AVAILABLE` |
| V-04 | `dueAt` enviado sem a transição permitir sobrescrita | API | "O prazo desta devolução não pode ser alterado." | `DUE_DATE_OVERRIDE_NOT_ALLOWED` |
| V-05 | Status do processo diferente de `IN_PROGRESS` | API | "Este processo não pode ser devolvido no status atual." | `INVALID_PROCESS_STATUS` |
| V-06 | Usuário não é custodiante | API | "Você não está com este processo." | `NOT_PROCESS_CUSTODIAN` |
| V-07 | `expectedStageId` diverge da etapa ativa | API | "Este processo foi tramitado por outra pessoa. Atualize a página." | `STAGE_CHANGED` |
| V-08 | `If-Match` divergente | API | "Os dados do processo mudaram. Atualize a página." | `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `PROCESS_RETURN` com custódia do processo (POL-01).
- **Políticas:** POL-01 (custódia e status); POL-11 referenciada para deixar explícito que a devolução não dispara reabertura de documentos.
- **MFA:** não exigido (`PROCESS_RETURN` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão "Devolver" não é exibido no painel; a API responde 403 `NOT_PROCESS_CUSTODIAN` (sem custódia) ou `PERMISSION_DENIED` (sem a permissão) e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessStageChanged` | `process.stage_changed.return` | Commit da devolução | Especialização `ProcessReturned`; payload inclui `cause`, `movementId`, `fromStage`, `toStage`, `fromDepartmentId`, `toDepartmentId`, `toUserId?`, `dueAt?` |
| `ProcessStatusChanged` | `process.status_changed.returned` | Commit, quando o status muda para `RETURNED` | `fromStatus = IN_PROGRESS`, `toStatus = RETURNED`, `cause = RETURN` |
| `ProcessAssigned` | `process.assigned` | Commit, quando a etapa de destino resolve um responsável individual | `assignmentType = RETURN`, `fromUserId?`, `toUserId?` |

Projeções síncronas na mesma transação: entrada `PROCESS_RETURNED` na timeline ("{actor} devolveu para {toStageName} — {toDepartmentName}"); `ProcessAccess` (`CURRENT`/`RESPONSIBLE`) conforme §5 do pacote do épico.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `PROCESS_RETURNED` | Responsável de destino (resolvido por `PREVIOUS_ASSIGNEE`); se não houver, membros da unidade de destino | IN_APP + EMAIL (opcional) | Evento `ProcessStageChanged` (`RETURN`) |
| `PROCESS_ASSIGNED` | Novo responsável, exceto quando ele próprio é quem devolveu | IN_APP + EMAIL (opcional) | Evento `ProcessAssigned` (`RETURN`) |

Nenhuma das duas é obrigatória (usuário pode desativar os canais não obrigatórios — US-113).

## Critérios de aceite em Gherkin
```gherkin
Feature: Devolver processo

  Background:
    Given que o usuário está autenticado no tenant "Prefeitura de São José"
    And possui vínculo ativo
    And existe o processo "0012/2026" no workflow "Fase preparatória — Lei 14.133/2021"
    And o processo já percorreu as etapas "ABERTURA" e "APROVACAO_DFD" e está em "ESTUDOS_PRELIMINARES", responsável "Carla"

  Scenario: [Sucesso] Devolver para etapa anterior com responsável resolvido automaticamente
    Given que "Ana" foi a responsável pela etapa "ABERTURA" na passagem anterior
    When "Carla" devolver o processo "0012/2026" para a etapa "ABERTURA" com o motivo "Faltou detalhar a justificativa da contratação no DFD"
    Then o processo deve passar para o status "RETURNED"
    And a etapa ativa deve ser "ABERTURA" com responsável "Ana"
    And deve existir uma tramitação de ação "RETURN" com o motivo registrado
    And deve gerar registro de auditoria "process.return"
    And deve gerar os eventos "ProcessStageChanged", "ProcessStatusChanged" e "ProcessAssigned"
    And "Ana" deve receber notificação "PROCESS_RETURNED"

  Scenario: [Validação] Motivo abaixo do mínimo de caracteres
    When "Carla" tentar devolver o processo "0012/2026" para a etapa "ABERTURA" com o motivo "Corrigir"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro no campo "comment"
    And o processo deve permanecer em "ESTUDOS_PRELIMINARES"

  Scenario: [Permissão] Usuário sem custódia do processo
    Given que "Bruno" não é o responsável atual nem está lotado na unidade atual do processo "0012/2026"
    When "Bruno" enviar POST para "/api/v1/processes/0012-2026/return" com um corpo válido
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"
    And deve gerar registro de auditoria "access.denied"
    And o processo deve permanecer inalterado

  Scenario: [Tenant incorreto] Etapa de destino de outro processo
    Given que existe a etapa "ABERTURA" percorrida pelo processo "0030/2026" de outro tenant
    When "Carla" enviar POST com "targetStageId" dessa etapa
    Then a API deve responder 422 com código "TRANSITION_NOT_AVAILABLE"
    And a resposta não deve revelar dados do processo "0030/2026"

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Carla" devolveu o processo "0012/2026" com a chave de idempotência "K9" e recebeu 200
    When a mesma requisição for reenviada com a chave "K9"
    Then a API deve responder 200 com o mesmo resultado e o cabeçalho "Idempotent-Replayed: true"
    And deve existir apenas uma tramitação de ação "RETURN" para esse motivo

  Scenario: [Concorrência] Outro usuário já tramitou o processo
    Given que "Daniel", com acesso de encaminhamento, acabou de encaminhar o processo "0012/2026" para outra etapa
    When "Carla" enviar a devolução com "expectedStageId" da etapa "ESTUDOS_PRELIMINARES" (que já não é mais a atual)
    Then a API deve responder 409 com código "STAGE_CHANGED"
    And nenhuma nova tramitação deve ser criada

  Scenario: [Falha de banco] Banco indisponível durante a devolução
    Given que o banco de dados fica indisponível durante a transação
    When "Carla" confirmar a devolução
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhuma etapa, tramitação, acesso, auditoria ou evento deve ser persistido

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Carla" devolver o processo "0012/2026" com sucesso
    Then a API deve responder 200 e o processo deve constar como "RETURNED"
    And os eventos devem permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos; foca o primeiro erro |
| Etapa de destino não disponível | 422 | `TRANSITION_NOT_AVAILABLE` | "Esta etapa não está disponível como destino da devolução." | Recarrega a lista de etapas |
| Sobrescrita de prazo não permitida | 422 | `DUE_DATE_OVERRIDE_NOT_ALLOWED` | "O prazo desta devolução não pode ser alterado." | Oculta o campo de prazo |
| Status incompatível | 409 | `INVALID_PROCESS_STATUS` | "Este processo não pode ser devolvido no status atual." | Fecha o diálogo; atualiza o painel |
| Sem custódia | 403 | `NOT_PROCESS_CUSTODIAN` | "Você não está com este processo." | Oculta o botão "Devolver" |
| Etapa mudou (concorrência) | 409 | `STAGE_CHANGED` | "Este processo foi tramitado por outra pessoa. Atualize a página." | Botão "Atualizar" recarrega o painel |
| Versão divergente | 412 | `VERSION_CONFLICT` | "Os dados do processo mudaram. Atualize a página." | Idem |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Não foi possível confirmar a versão atual. Recarregue a página." | Recarrega antes de reenviar |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível devolver o processo agora. Tente novamente em instantes." | Mantém o diálogo aberto; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-047 (encaminhamento — mesma família de ações de tramitação e padrões de transação); US-049 (assumir, quando a devolução não resolve responsável individual); US-106 (cálculo de dias úteis).
- **Decisões/ADRs:** DEC-013, DEC-014, DEC-015, DEC-023, DEC-024, DEC-031, DEC-055, DEC-104, DEC-105; ADR-005.
- **Configurações:** `calendar.optionalHolidaysAreNonBusiness`, configuração de destinos/sobrescrita de prazo da transição `RETURN` (por `WorkflowTransition`).
- **Lacunas nas fontes canônicas:** nenhuma (algoritmo de `PREVIOUS_ASSIGNEE` — RN-TRAM-28 — registrado em entities.md, enum `StageAssignmentPolicy`).

## Impacto técnico
- Reaproveita o padrão transacional de US-047 (`TransactionalCommandHandler`), incluindo bloqueio de linha do processo (`SELECT … FOR UPDATE`) durante a tramitação.
- `PREVIOUS_ASSIGNEE` exige consulta ao histórico de `ProcessAssignment` por `workflowStageId` (via `ProcessStage.workflowStageId`), não apenas pela instância atual — índice `(tenant_id, process_id)` em `process_stages` já cobre a busca; considerar índice auxiliar `(tenant_id, process_id, workflow_stage_id)` se o volume de devoluções for alto.
- `expectedStageId` é uma conveniência de UX sobre a concorrência já garantida por `version`/`If-Match` (DEC-104); não substitui o bloqueio otimista.

## Backend
- **Módulo(s):** `process` (dono); fachadas de `workflow` (`getAllowedReturnTargets`, `computeStageDueAt`), `catalog` (`BusinessCalendarFacade`), `access` (`AuthorizationService.assertCan('PROCESS_RETURN')`), `timeline`, `audit`, `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `ReturnProcessCommand` → `ReturnProcessHandler`.
- **Domínio:** `Process.return(targetStageId, comment, dueAtOverride?)`; `ProcessStage.exit('RETURNED')` / `ProcessStage.enter(...)`; `ProcessAssignment.resolvePreviousAssignee(workflowStageId)`.
- **Transação:** passos 5.1–5.11 do fluxo principal, isolamento `READ COMMITTED` + bloqueio de linha do processo.

## Frontend
- **Tela(s):** SCR-104 (diálogo sobre SCR-006).
- **Componentes:** `StageTargetSelect` (lista etapas já percorridas), `TextareaField` (motivo, contador de caracteres), `DatePicker` condicional (prazo), `ConfirmButton` com estado de carregamento.
- **Estados:** skeleton ao carregar destinos possíveis; vazio ("Nenhuma etapa anterior disponível para devolução" — não deveria ocorrer dada a pré-condição, mas tratado defensivamente); erro de carregamento com "Tentar novamente"; sucesso fecha o diálogo e atualiza o painel.
- **Acessibilidade e responsividade:** foco inicial no seletor de etapa; erros anunciados via `aria-live`; diálogo em tela cheia abaixo de 768 px.

## Banco de dados
- **Tabelas:** `process_stages`, `process_assignments`, `process_movements`, `processes`, `process_access`, `process_timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma nova (reutiliza as tabelas de runtime já criadas em US-001/US-047).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, process_id) WHERE status = 'ACTIVE'` em `process_stages` garante uma única etapa ativa durante a troca; `CHECK` de `process_movements` exige `comment` para `action = 'RETURN'`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-20 | POST | `/api/v1/processes/{id}/return` | `{ targetStageId, comment, dueAt?, expectedStageId? }` + `If-Match` + `Idempotency-Key` | `200 { data: Process }` com `status`, `currentStage`, `currentDepartment`, `currentResponsible`, `version` | 200, 403, 404, 409, 412, 422, 428, 429, 500, 503 |

## Logs
- `info` `process.returned` — `processId`, `fromStageKey`, `toStageKey`, `resolvedAssigneeId?`, `durationMs`, `correlationId`.
- `warn` `return.previous_assignee_not_found` — quando a política não resolve responsável e a etapa fica na fila.
- `error` `process.return_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** o texto do motivo (`comment`).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.return` | `WORKFLOW` | Commit da devolução | `changes`: `status`, `currentStageId`, `currentResponsibleId`. `metadata`: `fromStageKey`, `toStageKey`, `movementId`, `commentLength` |
| `access.denied` | `ACCESS` | Tentativa sem custódia/permissão | `reasonCode = PROCESS_RETURN` |

## Testes necessários
- **Unitários:** resolução de `PREVIOUS_ASSIGNEE` (com e sem histórico individual); cálculo de `dueAt` em dias úteis; validação de destino permitido.
- **Integração (Testcontainers):** transação atômica (falha após encerrar a etapa ativa → nada persiste); RLS; `ProcessAccess` atualizado corretamente (`CURRENT`→`HISTORICAL`).
- **API/contrato:** respostas e erros conforme api.md; cabeçalhos `ETag`, `If-Match`, `Idempotent-Replayed`.
- **RBAC e multi-tenant:** custodiante vs não custodiante; `targetStageId` de outro tenant → `TRANSITION_NOT_AVAILABLE` sem revelar existência.
- **Concorrência:** duas tramitações simultâneas no mesmo processo (uma devolve, outra encaminha) → uma 200, outra `STAGE_CHANGED`/`VERSION_CONFLICT`.
- **E2E (Playwright):** jornada completa do diálogo de devolução até a notificação do novo responsável.
- **Acessibilidade/performance:** axe sem violações sérias no diálogo; p95 < 500 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `PROCESS_RETURN` com custódia (POL-01) aplicado na API; botão oculto sem permissão
- [ ] Resolução de `PREVIOUS_ASSIGNEE` coberta por testes unitários
- [ ] Transação única comprovada por teste de falha induzida
- [ ] Auditoria `process.return` e eventos verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-20 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas e trace de duração da transação
- [ ] Diálogo acessível (axe) e responsivo (360 px)
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reaproveita o padrão transacional de US-047, mas adiciona a resolução de `PREVIOUS_ASSIGNEE` e a garantia de que documentos não mudam de status (POL-11).

## Prioridade
**P0** — sem devolução, qualquer pendência ou erro de uma etapa trava o processo indefinidamente na etapa seguinte.

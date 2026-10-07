---
id: US-010
title: "Concluir processo (planejamento da contratação)"
epic: EP-001
feature: FT-005
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-047, US-052]
modules: [process, workflow, access, timeline, audit, platform]
screens: [SCR-006, SCR-116]
endpoints: [PRC-26]
permissions: [PROCESS_COMPLETE]
events: [ProcessStageChanged, ProcessStatusChanged, ProcessCompleted]
---

# US-010 — Concluir processo (planejamento da contratação)

## Título
Concluir processo (planejamento da contratação)

## Descrição
**Como** gestor de contratações, **quero** concluir manualmente o processo quando o planejamento da contratação estiver pronto — ou que o sistema conclua automaticamente ao aprovar a entrada na etapa final —, **para** formalizar o fim da fase preparatória com rastreabilidade completa.

Há dois caminhos para o mesmo resultado: conclusão **manual**, acionada por quem está com o processo quando a transição `COMPLETE` está disponível (ou a etapa atual já é do tipo `END`); e conclusão **automática**, disparada pela US-052 quando a última aprovação é `APPROVED` e a próxima etapa resolvida é do tipo `END`. A etapa final do workflow padrão do MVP 1 é "Planejamento da contratação concluído" (DEC-015).

## Contexto
- A fase preparatória da Lei 14.133/2021 (art. 18) termina quando o planejamento está pronto para seguir à seleção do fornecedor; o MVP 1 modela só essa fase, por isso a etapa final do workflow padrão é "Planejamento da contratação concluído" (DEC-015).
- DEC-013 define `COMPLETED` como alcançável de `IN_PROGRESS` (concluir, etapa `END`) e de `AWAITING_APPROVAL` (aprovação `APPROVED` com próxima etapa `END`); é estado final no MVP 1 (reabertura é PEND-03).
- POL-08 exige `PROCESS_COMPLETE` + custódia (POL-01) + transição `COMPLETE` disponível (ou etapa atual do tipo `END`) + regras `BLOCKING` satisfeitas (`RuleScope` `STAGE_EXIT`/`TRANSITION`).
- US-052 (decisão de aprovação) é quem aciona a conclusão automática; esta story cobre a transição manual e o resultado comum (`ProcessCompleted`) de ambos os caminhos, que devem compartilhar a mesma rotina de domínio.

## Objetivo
Garantir que 100% das conclusões — manuais ou automáticas — só ocorram com as regras `BLOCKING` satisfeitas, registrem `completedAt`/`completedById`, encerrem a etapa ativa como `COMPLETED` e publiquem os eventos de ciclo de vida, de forma atômica e em menos de 1 segundo.

## Persona
- **Principal:** Gestor de contratações (`GESTOR_CONTRATACOES`), com custódia do processo.
- **Secundárias:** quem decide a aprovação final (caminho automático, US-052).

## Pré-condições
- Processo em `IN_PROGRESS` com transição `COMPLETE` disponível na etapa atual, ou etapa atual já do tipo `END` aguardando confirmação (manual); ou aprovação pendente cuja decisão aprovada leva à próxima etapa `END` (automático).
- Usuário com `PROCESS_COMPLETE` e custódia do processo (POL-01/POL-08).
- Regras `BLOCKING` de saída da etapa satisfeitas (checklist do painel, PRC-09).

## Fluxo principal
1. **Manual:** no painel (SCR-006), com o checklist "o que falta" zerado, o botão primário mostra "Concluir processo". O usuário aciona; o diálogo SCR-116 confirma e permite observação opcional. O front envia `POST /processes/{id}/complete` com `If-Match` e `Idempotency-Key`.
2. A API, em transação: valida custódia (POL-01) e `PROCESS_COMPLETE`; resolve a transição `COMPLETE` (ou confirma a etapa `END`); avalia regras `BLOCKING` (`TRANSITION_BLOCKED` se houver pendência) e `WARNING` não reconhecidas (`WARNINGS_NOT_ACKNOWLEDGED`); encerra a `ProcessStage` ativa como `COMPLETED`, registra a passagem pela etapa `END` e a encerra também como `COMPLETED`; encerra o `ProcessAssignment` ativo; grava `Process.status = COMPLETED`, `completedAt`, `completedById`; registra `ProcessMovement` (`COMPLETE`); grava auditoria `process.complete`, os eventos `ProcessStageChanged` (causa `COMPLETE`) e `ProcessStatusChanged`/`ProcessCompleted`, e a entrada de timeline.
3. API responde 200; front exibe "Processo concluído" e o painel passa a mostrar o selo "Concluído" com ações bloqueadas.
4. **Automático:** o aprovador decide `APPROVE` na última aprovação (US-052); a etapa resolvida como próxima é do tipo `END`. Na mesma transação da decisão, o sistema aplica a mesma lógica dos passos 2 e 3, com `completedById` = aprovador. O evento da decisão e os eventos de conclusão são publicados juntos; a timeline registra ambos.

## Fluxos alternativos
- **FA-01 — Regras BLOCKING pendentes:** resposta 422 `TRANSITION_BLOCKED` com `violations[]`; o botão permanece desabilitado e o checklist aponta os itens.
- **FA-02 — Regras WARNING não reconhecidas:** diálogo lista os avisos com "Entendo os avisos e quero continuar"; reenvio com `acknowledgedWarnings`.
- **FA-03 — Etapa atual já é `END` sem transição nomeada:** "Concluir processo" aparece diretamente, sem rótulo de transição.
- **FA-04 — Processo suspenso:** `PROCESS_COMPLETE` fica indisponível até retomar (POL-08 exige status elegível).
- **FA-05 — Conclusão automática:** ao recarregar, o painel já mostra o processo `COMPLETED`, sem ação do usuário.

## Regras de negócio
- **RN-PROC-111** — Conclusão manual exige status `IN_PROGRESS`, custódia (POL-01) e `PROCESS_COMPLETE`; transição `COMPLETE` disponível na etapa atual ou etapa atual já `END`.
- **RN-PROC-112** — Conclusão automática ocorre quando uma `Approval` é decidida `APPROVE` e a etapa resolvida como próxima é do tipo `END` (US-052); não exige ação adicional do usuário.
- **RN-PROC-113** — Regras `BLOCKING` de `RuleScope` `STAGE_EXIT`/`TRANSITION` da etapa/transição devem estar satisfeitas; `WARNING` exige reconhecimento explícito (`acknowledgedWarnings`).
- **RN-PROC-114** — `Process.status` só muda para `COMPLETED` a partir de `IN_PROGRESS` (direto) ou `AWAITING_APPROVAL` (via aprovação) — nunca de `DRAFT`, `RETURNED` ou `SUSPENDED` diretamente (DEC-013).
- **RN-PROC-115** — `completedAt = now()`; `completedById` = usuário que confirmou (manual) ou aprovador cuja decisão gerou a conclusão (automática).
- **RN-PROC-116** — A etapa `END` alcançada é registrada como `ProcessStage` com `status = COMPLETED` e `exitedAt = completedAt`; `currentResponsibleId` permanece apenas como referência histórica.
- **RN-PROC-117** — `COMPLETED` é status final no MVP 1 (reabertura fora de escopo — PEND-03); nenhuma nova tramitação, edição de dados/itens ou documento é aceita após a conclusão (POL-01 passa a rejeitar com `INVALID_PROCESS_STATUS`).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Observação (opcional) | — (grava em `ProcessMovement.comment`) | texto longo | Não | até 5.000 caracteres | — |
| Avisos reconhecidos | `acknowledgedWarnings` | lista técnica | Condicional (há `WARNING`) | ids das regras avisadas | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Sem custódia | API | "Apenas quem está com o processo pode concluí-lo." | `NOT_PROCESS_CUSTODIAN` |
| V-02 | Sem `PROCESS_COMPLETE` | API | "Você não tem permissão para concluir este processo." | `PERMISSION_DENIED` |
| V-03 | Status não elegível | API | "Retome o processo antes de concluí-lo." | `INVALID_PROCESS_STATUS` |
| V-04 | Regra BLOCKING pendente | API | "Há pendências que impedem a conclusão." | `TRANSITION_BLOCKED` |
| V-05 | WARNING não reconhecido | Front + API | "Confirme que está ciente dos avisos para continuar." | `WARNINGS_NOT_ACKNOWLEDGED` |
| V-06 | `If-Match` ausente/divergente | API | "Recarregue a página e tente novamente." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `PROCESS_COMPLETE` cobrindo o processo.
- **Políticas:** POL-01 (custódia) + POL-08 (transição `COMPLETE` disponível ou etapa `END`, regras `BLOCKING` satisfeitas).
- **MFA:** `PROCESS_COMPLETE` tem riscoM; não exigida por padrão, salvo `security.mfaPolicy = ALL`.
- **Sem permissão/custódia:** botão "Concluir processo" fica oculto (sem permissão) ou desabilitado com a dica "Você precisa estar com o processo" (sem custódia); API responde 403 `PERMISSION_DENIED`/`NOT_PROCESS_CUSTODIAN`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessStageChanged` | `process.stage_changed.complete` | Encerramento da etapa ativa na conclusão | causa `COMPLETE` |
| `ProcessStatusChanged` / `ProcessCompleted` | `process.status_changed.completed` | Commit da conclusão (manual ou automática) | `fromStatus`, `toStatus = COMPLETED` |

Projeção síncrona: entrada de conclusão na timeline, em ambos os caminhos.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `PROCESS_STATUS_CHANGED` (concluído) | Criador, responsável atual, participantes com `notify = true` | IN_APP; e-mail desligado por padrão (preferência do usuário — US-113) | Ao concluir manual ou automaticamente (`ProcessStatusChanged`); timeline `PROCESS_COMPLETED` |

## Critérios de aceite em Gherkin
```gherkin
Feature: Concluir processo (planejamento da contratação)

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" está em "IN_PROGRESS" sob custódia de "Carla"
    And "Carla" possui "PROCESS_COMPLETE" cobrindo a "Secretaria de Obras"

  Scenario: [Sucesso] Concluir processo manualmente com todas as regras satisfeitas
    Given que não há regras "BLOCKING" pendentes na etapa atual
    When "Carla" confirmar "Concluir processo"
    Then o processo deve passar para o status "COMPLETED" com "completedAt" preenchido
    And a etapa atual deve ser encerrada com status "COMPLETED"
    And deve gerar registro de auditoria "process.complete"
    And deve gerar os eventos "ProcessStageChanged" e "ProcessStatusChanged"

  Scenario: [Sucesso] Conclusão automática após aprovação final
    Given que a última aprovação do processo "0012/2026" está pendente e a próxima etapa é do tipo "END"
    When o aprovador decidir "APPROVE"
    Then o processo deve passar para "COMPLETED" automaticamente, sem ação adicional de "Carla"
    And "completedById" deve ser o aprovador que decidiu a aprovação

  Scenario: [Validação] Regras BLOCKING pendentes impedem a conclusão
    Given que existe uma regra "BLOCKING" não satisfeita na etapa atual
    When "Carla" tentar concluir o processo
    Then a API deve responder 422 com código "TRANSITION_BLOCKED"
    And o processo deve permanecer em "IN_PROGRESS"

  Scenario: [Permissão] Usuário sem custódia tenta concluir
    Given que "Diego" não é o responsável atual nem está lotado na unidade atual do processo "0012/2026"
    When "Diego" enviar POST para concluir o processo
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"

  Scenario: [Tenant incorreto] Concluir processo de outro tenant
    Given que o processo "0099/2026" pertence ao tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", enviar POST para concluir "0099/2026"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Carla" concluiu o processo "0012/2026" com a chave "K5" e recebeu 200
    When a mesma requisição for reenviada com a chave "K5"
    Then a API deve responder 200 com o mesmo processo "COMPLETED" e o cabeçalho "Idempotent-Replayed: true"

  Scenario: [Concorrência] Conclusão e encaminhamento simultâneos
    Given que "Carla" tem o processo "0012/2026" aberto na versão "5"
    When um encaminhamento e uma conclusão forem enviados simultaneamente com "If-Match: \"5\""
    Then apenas uma requisição deve ser aplicada com sucesso
    And a outra deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível durante a conclusão
    Given que o banco de dados fica indisponível durante a transação de conclusão
    When "Carla" confirmar "Concluir processo"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And o processo deve permanecer em "IN_PROGRESS"

  Scenario: [Falha de integração] Relay do outbox indisponível ao concluir
    Given que o relay do outbox está indisponível
    When "Carla" concluir o processo "0012/2026" com sucesso
    Then a API deve responder 200 e o processo deve estar "COMPLETED"
    And o evento "ProcessStatusChanged" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Regras BLOCKING pendentes | 422 | `TRANSITION_BLOCKED` | "Há pendências que impedem a conclusão." | Mostra `violations` no checklist |
| Avisos não reconhecidos | 422 | `WARNINGS_NOT_ACKNOWLEDGED` | "Confirme que está ciente dos avisos para continuar." | Lista avisos com confirmação |
| Sem custódia | 403 | `NOT_PROCESS_CUSTODIAN` | "Apenas quem está com o processo pode concluí-lo." | Oculta/desabilita o botão |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para concluir este processo." | Oculta o botão |
| Status não elegível (ex.: suspenso) | 409 | `INVALID_PROCESS_STATUS` | "Retome o processo antes de concluí-lo." | Oferece "Retomar" |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Este processo foi alterado por outra pessoa." | Recarrega |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta solicitação já foi enviada com outros dados." | Gera nova chave |
| Recurso de outro tenant/inexistente | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | Redireciona |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir a ação agora." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-047 (encaminhar — a conclusão manual reaproveita a resolução de transições do workflow), US-052 (decisão de aprovação — caminho automático de conclusão).
- **Decisões/ADRs:** DEC-013, DEC-015, DEC-018, DEC-055, DEC-104, DEC-105.
- **Configurações:** nenhuma específica.
- **Lacunas nas fontes canônicas:** nenhuma (notificação canônica `PROCESS_STATUS_CHANGED` — events.md §6).

## Impacto técnico
- A conclusão automática (via US-052) e a manual (esta story) devem compartilhar a mesma rotina de domínio (`Process.complete(...)`) para que as regras RN-PROC-111..117 valham nos dois caminhos — risco de duplicar lógica se implementadas separadamente.
- `COMPLETED` é terminal no MVP 1; a reabertura fica fora de escopo (PEND-03) — a API deve bloquear toda mutação pós-conclusão de forma consistente (POL-01 já cobre, mas vale teste de regressão dedicado).

## Backend
- **Módulo(s):** `process` (dono); `workflow` (resolver transição `COMPLETE`/etapa `END`, avaliar regras `BLOCKING`/`WARNING`), `audit`, `platform`.
- **Casos de uso:** `CompleteProcessCommand` → `CompleteProcessHandler`, chamado pelo endpoint PRC-26 e, internamente, pelo handler de decisão de aprovação da US-052.
- **Domínio:** `Process.complete(actorId, comment?)` (RN-PROC-111..117); `WorkflowFacade.evaluateExitRules(stageId, ruleContext)`.
- **Transação:** mesmo padrão transacional da US-001; no caminho automático, ocorre dentro da transação de decisão de aprovação (US-052), reutilizando `Process.complete`.

## Frontend
- **Tela(s):** SCR-006 (botão primário "Concluir processo"), SCR-116 (diálogo).
- **Componentes:** painel de checklist (regras `BLOCKING`/`WARNING`, reaproveitado do painel situacional — DEC-180), `ConfirmDialog` com lista de avisos e caixa "Entendo os avisos".
- **Estados:** botão primário desabilitado com dica quando há `BLOCKING`; loading ao confirmar; selo "Concluído" após sucesso.
- **Acessibilidade e responsividade:** violações anunciadas via `aria-live`; diálogo navegável por teclado; utilizável em 360 px.

## Banco de dados
- **Tabelas:** `processes` (`status`, `completedAt`, `completedById`), `process_stages`, `process_assignments`, `process_movements`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma nova.
- **Índices/constraints relevantes:** nenhum adicional além dos já previstos para `Process`/`ProcessStage`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-26 | POST | `/api/v1/processes/{id}/complete` | `{ comment?, acknowledgedWarnings? }` + `If-Match` + `Idempotency-Key` | `200 { data: Process }` | 200, 403, 404, 409, 412, 422, 428, 503 |

## Logs
- `info` `process.completed` — `processId`, `cause` (`MANUAL`\|`APPROVAL`), `durationMs`, `correlationId`.
- `warn` `workflow.exit_rule_warning_acknowledged` — `ruleId`, `processId`.
- `error` `process.complete_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** comentário livre do usuário, dados sigilosos do processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.complete` | `DATA_CHANGE` | Commit da conclusão | `changes`: `status`, `completedAt`; `metadata`: `cause` (`MANUAL`\|`APPROVAL`) |
| `access.denied` | `ACCESS` | Tentativa sem permissão/custódia | `reasonCode = PROCESS_COMPLETE` |

## Testes necessários
- **Unitários:** `Process.complete` (RN-PROC-111..117); avaliação de regras `BLOCKING`/`WARNING`.
- **Integração (Testcontainers):** conclusão automática disparada por decisão de aprovação, na mesma transação; conclusão manual bloqueada por regra pendente.
- **Concorrência:** conclusão concorrente com encaminhamento → apenas uma aplicada, a outra 412.
- **API/contrato:** snapshots 200/409/412/422 conforme api.md.
- **RBAC e multi-tenant:** custódia + `PROCESS_COMPLETE`; processo de outro tenant → 404.
- **E2E (Playwright):** concluir manualmente; concluir automaticamente após aprovar a última etapa.
- **Acessibilidade/performance:** axe no diálogo e no checklist; p95 < 400 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados e passando no CI
- [ ] `PROCESS_COMPLETE` + POL-01/POL-08 aplicados na API; botão oculto/desabilitado conforme regra
- [ ] Rotina de domínio compartilhada entre conclusão manual e automática, comprovada por teste
- [ ] Bloqueio de mutações pós-conclusão coberto por teste de regressão
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-26 compatível com api.md
- [ ] Logs sem dados sensíveis
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — lógica concentrada na transição de estado e nas regras de saída já modeladas pelo workflow; parte do esforço (avaliação de regras `BLOCKING`/`WARNING`) é compartilhada com o encaminhamento (US-047).

## Prioridade
**P0** — sem conclusão formal, não há como fechar a fase preparatória nem medir o throughput do planejamento de contratações, impedindo os relatórios básicos do MVP 1.

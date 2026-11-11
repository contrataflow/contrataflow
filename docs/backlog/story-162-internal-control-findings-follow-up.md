---
id: US-162
title: "Acompanhar o atendimento dos achados"
epic: EP-026
feature: FT-077
mvp: 2
priority: P1
estimate: S
status: Especificada
depends_on: [US-160]
modules: [internal-control, process, notification, timeline, rules, access, audit]
screens: [SCR-020, SCR-006, SCR-013]
endpoints: [ICT-18, ICT-19, ICT-09, ICT-11]
permissions: [INTERNAL_CONTROL_REVIEW_VIEW, INTERNAL_CONTROL_REVIEW_MANAGE, PROCESS_VIEW]
events: [InternalControlFindingResolved]
---

# US-162 — Acompanhar o atendimento dos achados

## Título
Acompanhar o atendimento dos achados e recomendações do Controle Interno

## Descrição
**Como** responsável pela etapa em que o processo se encontra (ou pela unidade que recebeu uma recomendação) e como analista do Controle Interno, **quero** registrar como cada achado foi atendido e acompanhar, entre processos, quais achados continuam abertos, **para** que as recomendações do Controle Interno não se percam depois da manifestação e a autoridade decida sabendo o que já foi sanado e o que permanece.

A story entrega a resposta ao achado (`OPEN → ADDRESSED`, ICT-18) mesmo depois de a manifestação estar concluída, a lista de achados em aberto por tenant (ICT-19, SCR-020) e a atualização imediata dos fatos `internalControl.openFindings` e `internalControl.openFindingsHighOrCritical` do `RuleContext` v2, que alimentam o aviso `WARNING` da autorização. `RISK_ACCEPTED` não é registrado aqui: é efeito da decisão da autoridade na etapa `AUTORIZACAO_LICITACAO` (POL-23); `CANCELED` é do próprio Controle Interno, antes da conclusão (US-160).

## Contexto
- DEC-200: achados e recomendações com situação `OPEN`, `ADDRESSED`, `RISK_ACCEPTED` e `CANCELED`; o achado `ADDRESSED` exige resposta (`InternalControlFinding.response`, `respondedById`, `respondedAt`) e a lista de achados abertos acompanha o processo até o fim (RN-ICT-17).
- Máquina de estados dos achados (`entities.md` §6.5): `OPEN → ADDRESSED` (resposta de quem detém a custódia), `OPEN → RISK_ACCEPTED` (autoridade, com motivação, na decisão de `AUTORIZACAO_LICITACAO` — POL-23) e `OPEN → CANCELED` (Controle Interno antes da conclusão).
- A análise concluída é imutável (US-161, RN-ICT-41), com **uma única exceção**: o atendimento do achado, que grava só `status`, `response`, `respondedById` e `respondedAt` e nunca altera a situação da manifestação, o documento nem as versões analisadas.
- O evento `InternalControlFindingResolved` (routing key `internal_control_review.finding_resolved`) já está catalogado e projeta a timeline `INTERNAL_CONTROL_FINDING_RESOLVED`; esta story o publica no atendimento.
- Leitura ampla do Controle Interno (POL-20): a lista de achados cobre todos os processos do escopo; para quem não é do Controle Interno, vale a visibilidade do processo (DEC-024) e só os achados de processos visíveis.
- Orçamento sigiloso (DEC-030): a lista e os eventos não carregam valores; texto de achado só aparece a quem pode ver o processo.

## Objetivo
Garantir que 100% dos achados tenham situação rastreável até o fim do processo, que a resposta fique registrada com autor e data, e que a contagem de achados abertos (por criticidade) no `RuleContext` reflita o atendimento em até 5 segundos, com a lista de achados abertos abrindo em p95 < 1,5 s para 2.000 achados.

## Persona
- **Principal:** Responsável pela custódia — responsável atribuído da etapa ou titular/substituto da unidade que detém o processo (por exemplo `PLANEJAMENTO`, `COMPRAS`).
- **Secundárias:** Analista do Controle Interno (`CONTROLE_INTERNO`, acompanha e cancela antes da conclusão); Autoridade competente (`AUTORIDADE_COMPETENTE`, vê o que está aberto ao decidir); Auditor (`AUDITOR`, lê); Gestor de contratações (`GESTOR_CONTRATACOES`, consulta o saldo de achados).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`.
- Existe achado `OPEN` em manifestação do processo (em andamento ou concluída) visível ao usuário.
- Para responder: o usuário detém a custódia do processo ou da unidade da etapa, ou é titular/substituto da unidade jurídica ou solicitante conforme a recomendação (POL-20 não permite ao Controle Interno responder por quem deve atender).
- Processo não está em status final (`COMPLETED`, `CANCELED`); `SUSPENDED` bloqueia respostas (POL-03).

## Fluxo principal
1. O responsável abre o processo (SCR-006, aba "Controle Interno") ou a caixa de tarefas (SCR-013), onde o achado aparece como pendência vinculada ao processo, e vê a lista de achados com título, criticidade, recomendação e situação.
2. Escolhe **"Registrar atendimento"** no achado `OPEN`, descreve como foi atendido (`response`, 10–5.000 caracteres) e, opcionalmente, anexa evidência (versão de documento ou anexo — `INTERNAL_CONTROL_REVIEW`).
3. O front envia `POST /internal-control/reviews/{id}/findings/{findingId}/respond` (ICT-18) com `Idempotency-Key` e `If-Match`.
4. A API, em uma transação com `app.tenant_id`: trava o achado; verifica `OPEN`; confere `If-Match`; autoriza a custódia; grava `status = ADDRESSED`, `response`, `respondedById`, `respondedAt`; grava a auditoria `internal_control_finding.respond`, a timeline e publica `InternalControlFindingResolved` (outbox).
5. O consumidor do `RuleContext` recalcula `openFindings` e `openFindingsHighOrCritical`; se o processo estiver na autorização, o aviso `WARNING` deixa de listar o achado.
6. O analista do Controle Interno abre **"Achados em aberto"** (SCR-020, `GET /internal-control/findings`, ICT-19), filtra por situação, criticidade, processo, unidade e prazo, e acompanha o que falta; achados antigos aparecem com o envelhecimento em dias.
7. A UI mostra "Atendimento registrado." e atualiza a aba, o painel da manifestação e a lista.

## Fluxos alternativos
- **FA-01 — Achado já resolvido:** achado `ADDRESSED`, `RISK_ACCEPTED` ou `CANCELED` retorna 409 `FINDING_NOT_OPEN`; a UI recarrega (RN-ICT-47).
- **FA-02 — Atendimento depois da conclusão:** permitido; a manifestação e a situação não mudam (RN-ICT-41); o painel exibe o histórico "atendido em {data} por {nome}".
- **FA-03 — Autoridade aceita o risco:** ao decidir `APPROVE` na `AUTORIZACAO_LICITACAO` com achados `OPEN`, a decisão (POL-23) leva-os a `RISK_ACCEPTED` na mesma transação, com a motivação da autoridade; esta story só **exibe** o resultado (a lógica está na story que implementa a autorização, ver lacuna 2).
- **FA-04 — Cancelamento pelo Controle Interno:** antes da conclusão, o analista cancela o achado pela edição (US-160); depois da conclusão ninguém cancela (RN-ICT-17).
- **FA-05 — Processo suspenso, cancelado ou concluído:** resposta bloqueada com 409 `INVALID_STATE`; a lista continua legível (POL-03).
- **FA-06 — Resposta por quem não detém a custódia:** 403 `PERMISSION_DENIED`; a UI desabilita "Registrar atendimento" e informa quem detém a custódia.
- **FA-07 — Achado de rodada anterior:** achados abertos reaproveitados na nova rodada (RN-ICT-18) seguem a mesma regra; a resposta registra a `round` atual no metadado de auditoria.

## Regras de negócio
- **RN-ICT-17** — Achado `ADDRESSED` ou `RISK_ACCEPTED` exige resposta; `RISK_ACCEPTED` só é registrado pela autoridade com motivação na decisão de `AUTORIZACAO_LICITACAO`, e `CANCELED` só pelo Controle Interno antes da conclusão (DEC-200).
- **RN-ICT-47** — `ADDRESSED` só vale a partir de `OPEN`; é terminal e não se reverte nesta story; resposta de 10 a 5.000 caracteres, sem dados sigilosos (DEC-030).
- **RN-ICT-48** — O atendimento é do detentor da custódia (responsável da etapa, titular/substituto da unidade) e nunca do analista que registrou o achado (independência da POL-20).
- **RN-ICT-49** — O atendimento é a única alteração aceita numa análise concluída e grava apenas `status`, `response`, `respondedById`, `respondedAt` (RN-ICT-41).
- **RN-ICT-50** — Responder não altera a situação da manifestação (`COMPLIANT_WITH_RECOMMENDATIONS`, `NON_COMPLIANT`), a versão do documento nem as versões analisadas.
- **RN-ICT-51** — `internalControl.openFindings` e `internalControl.openFindingsHighOrCritical` são recalculados a cada mudança de situação de achado (RN-ICT-13, US-129).
- **RN-ICT-52** — A lista de achados (ICT-19) respeita DEC-024: o Controle Interno lê todos do escopo; os demais só os de processos visíveis; ordenação padrão por criticidade e depois pela data de registro; paginação por cursor.
- **RN-ICT-53** — A lista nunca expõe valores de orçamento sigiloso nem texto de achado de processo não visível (POL-09, DEC-030).
- **RN-ICT-54** — O envelhecimento do achado conta dias corridos desde o registro e é calculado na leitura (não é prazo contratual nem SLA — EP-030 não o trata).
- **RN-ICT-55** — Resposta repetida com a mesma `Idempotency-Key` devolve o mesmo resultado sem novo evento ou auditoria.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Atendimento | `response` | texto (10–5.000) | Sim | sem dado sigiloso (RN-ICT-47) | — |
| Evidência | `evidenceAttachmentIds` / `evidenceDocumentVersionId` | uuid[] / uuid | Não | só do mesmo processo e tenant | — |
| Situação (filtro) | `status` | `FindingStatus` | Não | `OPEN` por padrão | — |
| Criticidade (filtro) | `severity` | `FindingSeverity` | Não | multi | — |
| Processo / unidade (filtro) | `processId`, `departmentId` | uuid | Não | escopo do usuário | — |
| Envelhecimento | `ageDays` | inteiro (somente leitura) | — | RN-ICT-54 | derivado |
| ETag do achado | `If-Match` | string | Sim | — | `ETag` da leitura |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `response` vazio ou fora de 10–5.000 caracteres | Front + API (Zod) | "Descreva como o achado foi atendido (mínimo 10 caracteres)." | `VALIDATION_ERROR` |
| V-02 | `response` com dado de orçamento sigiloso | API | "O atendimento não pode conter valores de orçamento sigiloso." | `VALIDATION_ERROR` (`CONFIDENTIAL_CONTENT`) |
| V-03 | Achado fora de `OPEN` | API | "Este achado já foi resolvido." | `FINDING_NOT_OPEN` |
| V-04 | Evidência de outro processo ou tenant | API | "A evidência informada não pertence a este processo." | `VALIDATION_ERROR` |
| V-05 | `If-Match` ausente | API | "Recarregue o achado e tente de novo." | `PRECONDITION_REQUIRED` |
| V-06 | Filtros da lista inválidos (`severity`, `status`, cursor) | API (Zod) | "Filtro inválido." | `VALIDATION_ERROR` |
| V-07 | Processo suspenso ou em status final | API | "O processo não aceita alterações agora." | `INVALID_STATE` |

## Permissões
- **Permissão:** responder (ICT-18) exige **custódia** do processo ou da unidade da etapa, mais `PROCESS_VIEW`; listar (ICT-19) e ler (ICT-09, ICT-11) exigem `INTERNAL_CONTROL_REVIEW_VIEW` (escopo amplo do Controle Interno) ou `PROCESS_VIEW` no processo; o analista usa `INTERNAL_CONTROL_REVIEW_MANAGE` apenas para o cancelamento (US-160).
- **Políticas:** POL-20 (independência), POL-03 (processo editável), DEC-024 (visibilidade), POL-09 (orçamento sigiloso).
- **MFA:** não exigido (risco `M`/`L`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** a UI esconde "Registrar atendimento"; a API responde 403 `PERMISSION_DENIED` e grava `access.denied`; processo invisível responde 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `InternalControlFindingResolved` | `internal_control_review.finding_resolved` | Commit de ICT-18 | `reviewId`, `findingId`, `status` (`ADDRESSED`); timeline `INTERNAL_CONTROL_FINDING_RESOLVED`; recalcula o `RuleContext` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhum tipo catalogado para o atendimento de achado em `events.md` (ver lacuna 1); a timeline e a aba do processo cumprem o acompanhamento |

## Critérios de aceite em Gherkin
```gherkin
Feature: Acompanhar o atendimento dos achados do Controle Interno

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0045/2026" tem a manifestação "COMPLIANT_WITH_RECOMMENDATIONS" concluída
    And existem os achados "A1" (HIGH, "OPEN") e "A2" (LOW, "OPEN")
    And "Lívia Rocha" é a responsável pela etapa "AUTORIZACAO_LICITACAO" do processo
    And "Renata Prado" é analista do Controle Interno com "INTERNAL_CONTROL_REVIEW_VIEW"

  Scenario: [Sucesso] Responsável registra o atendimento de um achado
    When "Lívia Rocha" registrar o atendimento de "A1" com a resposta "Matriz de riscos revisada e anexada na versão 3."
    Then a API deve responder 200 com o achado "ADDRESSED", "respondedBy" "Lívia Rocha" e "respondedAt" preenchido
    And a manifestação deve permanecer "COMPLIANT_WITH_RECOMMENDATIONS" com as mesmas versões analisadas
    And "internalControl.openFindingsHighOrCritical" deve passar de 1 para 0
    And deve gerar registro de auditoria "internal_control_finding.respond"
    And deve gerar o evento "InternalControlFindingResolved" e a entrada de timeline "INTERNAL_CONTROL_FINDING_RESOLVED"

  Scenario: [Sucesso] Controle Interno acompanha os achados em aberto
    When "Renata Prado" abrir "Achados em aberto" com "status" "OPEN" e "severity" "HIGH"
    Then a API deve responder 200 com os achados ordenados por criticidade e envelhecimento
    And cada item deve trazer o processo, a criticidade, "ageDays" e a unidade responsável
    And nenhum valor de orçamento sigiloso deve aparecer na lista

  Scenario: [Validação] Resposta curta e evidência de outro processo
    When "Lívia Rocha" enviar o atendimento com a resposta "ok"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e mensagem "Descreva como o achado foi atendido (mínimo 10 caracteres)."
    When ela informar uma evidência anexada a outro processo
    Then a API deve responder 422 com código "VALIDATION_ERROR" e o achado deve continuar "OPEN"

  Scenario: [Permissão] Sem custódia e analista que registrou o achado
    Given que "Bruno Lopes" não tem custódia do processo nem da unidade da etapa
    When "Bruno Lopes" registrar o atendimento de "A2"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar auditoria "access.denied"
    When "Renata Prado" tentar registrar o atendimento de "A2" que ela mesma registrou
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And o achado deve continuar "OPEN"

  Scenario: [Tenant incorreto] Achado de outro tenant
    Given que existe o achado "B1" da "Prefeitura B"
    When "Lívia Rocha", da "Prefeitura A", chamar "POST /internal-control/reviews/{id}/findings/{id-de-B1}/respond"
    Then a API deve responder 404 com código "INTERNAL_CONTROL_REVIEW_NOT_FOUND"
    And "B1" não deve aparecer em "GET /internal-control/findings" da "Prefeitura A"

  Scenario: [Duplicidade] Reenvio do atendimento com a mesma chave de idempotência
    Given que "Lívia Rocha" respondeu "A1" com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o mesmo resultado e o cabeçalho "Idempotent-Replayed: true"
    And deve existir um único evento "InternalControlFindingResolved" e uma única auditoria "internal_control_finding.respond"
    When "Lívia Rocha" tentar responder "A1" de novo com outra chave
    Then a API deve responder 409 com código "FINDING_NOT_OPEN"

  Scenario: [Concorrência] Atendimento e aceite de risco simultâneos
    When "Lívia Rocha" registrar o atendimento de "A2" ao mesmo tempo em que a autoridade aprova a autorização com o achado aberto
    Then exatamente uma das operações deve efetivar a mudança de "A2"
    And a outra deve responder 409 com código "FINDING_NOT_OPEN" ou "INVALID_STATE" ou 412 com código "VERSION_CONFLICT"
    And o achado deve ter uma única situação final e um único evento "InternalControlFindingResolved"

  Scenario: [Falha de banco] Falha ao gravar o atendimento
    Given que o banco de dados fica indisponível durante a transação de "POST .../findings/{findingId}/respond"
    When "Lívia Rocha" confirmar o atendimento
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And o achado deve continuar "OPEN" sem auditoria, evento nem timeline gravados

  Scenario: [Falha de integração] Fila de eventos indisponível
    Given que o broker de mensagens está indisponível
    When "Lívia Rocha" registrar o atendimento de "A1"
    Then o atendimento deve ser gravado com o evento no outbox para publicação posterior
    And o recálculo do "RuleContext" e a timeline devem ocorrer assim que o outbox for publicado
    And deve ser registrado log "warn" "outbox.publish_delayed"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Resposta inválida | 422 | `VALIDATION_ERROR` | "Descreva como o achado foi atendido (mínimo 10 caracteres)." | Marca o campo |
| Achado já resolvido | 409 | `FINDING_NOT_OPEN` | "Este achado já foi resolvido." | Recarrega a lista |
| Processo suspenso ou encerrado | 409 | `INVALID_STATE` | "O processo não aceita alterações agora." | Desabilita a ação |
| Sem permissão ou custódia | 403 | `PERMISSION_DENIED` | "Você não tem permissão para registrar este atendimento." | Oculta a ação |
| Achado ou análise inexistente ou de outro tenant | 404 | `INTERNAL_CONTROL_REVIEW_NOT_FOUND` | "Achado não encontrado." | Volta à lista |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "O achado foi alterado. Recarregue e confira." | Recarrega |
| Chave de idempotência reutilizada com corpo diferente | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível registrar agora. Tente novamente em instantes." | "Tentar novamente"; respeita `Retry-After` |

## Dependências
- **Stories:** US-160 (achados e recomendações registrados). Indiretas: US-159 (painel e aba do processo), US-161 (conclusão e imutabilidade), US-129 (`RuleContext` v2), US-056 (caixa de tarefas), US-059 (outbox/timeline).
- **Decisões/ADRs:** DEC-200, DEC-030, DEC-024, DEC-196, ADR-008.
- **Configurações:** nenhuma.
- **Lacunas nas fontes canônicas:**
  1. **Notificação do atendimento:** `events.md` não define tipo de notificação para `InternalControlFindingResolved` (só `INTERNAL_CONTROL_CONCLUDED`). Proposta: `INTERNAL_CONTROL_FINDING_RESOLVED` ao analista do Controle Interno, opcional e desligada por padrão. **Dúvida de produto.**
  2. **Aceite de risco pela autoridade (POL-23):** a regra "ressalvas/achados abertos passam a `RISK_ACCEPTED` na mesma transação da decisão `APPROVE`" está em `permissions.md` mas nenhum card de story a implementa (a US-052/US-134 cobrem a decisão do MVP 1/múltipla). Precisa de story ou extensão explícita de US-130/US-134 e do erro `AUTHORIZATION_MOTIVATION_REQUIRED`; a US-162 apenas exibe o resultado.
  3. **Permissão para responder:** `permissions.md` não define permissão de resposta ao achado; esta story adota "custódia + `PROCESS_VIEW`". Confirmar com o piloto (talvez exigir `PROCESS_UPDATE`).
  4. **Auditoria `internal_control_finding.respond`** não está na matriz de auditoria; incluir. Códigos novos (`FINDING_NOT_OPEN`, `INTERNAL_CONTROL_REVIEW_NOT_FOUND`) e o parâmetro de lista (`ageDays`) a consolidar no card 9.

## Impacto técnico
- Mudança pequena e localizada: uma rota de escrita (ICT-18), uma de leitura (ICT-19) e o gatilho de recálculo do `RuleContext`; sem tabela nova (colunas `response`, `respondedById`, `respondedAt` já existem).
- Exceção controlada à imutabilidade: o trigger de `internal_control_reviews` bloqueia mudança de situação, mas `internal_control_findings` aceita a transição `OPEN → ADDRESSED` em análise concluída (teste de trigger obrigatório).
- Performance: índice parcial `(tenant_id, status) WHERE status = 'OPEN'` e cursor por `(severity, created_at)` para a lista; contadores do `RuleContext` por `review_id`.
- Observabilidade: métrica de achados abertos por criticidade e idade, alimentando o EP-028 (read model) no futuro.

## Backend
- **Módulo(s):** `internal-control` (dono), `process` (custódia e visibilidade), `rules` (`RuleContext`), `notification`, `timeline`, `audit`.
- **Casos de uso:** `RespondInternalControlFindingCommand` (ICT-18), `ListInternalControlFindingsQuery` (ICT-19), recálculo do provedor `internalControl`.
- **Domínio:** `InternalControlFinding` (transição `OPEN → ADDRESSED`), `FindingCustodyPolicy`.
- **Integrações internas:** `ProcessFacade.isCustodian`, `OutboxWriter`, `AuditService`, `AttachmentFacade` (evidência).
- **Transação:** trava do achado → validações → gravação → auditoria → outbox → timeline → commit.

## Frontend
- **Tela(s):** SCR-020 (`/controle-interno`, aba/visão "Achados em aberto"), SCR-006 (aba "Controle Interno"), SCR-013 (pendência na caixa).
- **Componentes:** `FindingsTable` (filtros, envelhecimento, criticidade), `RespondFindingDialog`, `FindingStatusBadge`, `FindingHistory`.
- **Estados:** skeleton, vazio ("Nenhum achado em aberto"), erro com "Tentar novamente", sucesso com atualização imediata.
- **Acessibilidade e responsividade:** situação e criticidade por texto e ícone; tabela com cabeçalhos associados; diálogo com foco preso; lista em cartões abaixo de 768 px.

## Banco de dados
- **Tabelas:** `internal_control_findings` (escrita de resposta), `internal_control_reviews` (leitura).
- **Migrações:** nenhuma além da M2 do módulo; ajuste no trigger de imutabilidade da análise concluída para permitir só `ADDRESSED` no achado.
- **Índices/constraints relevantes:** check `status NOT IN ('ADDRESSED','RISK_ACCEPTED') OR response IS NOT NULL`; índice parcial de achados `OPEN`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `ICT-18` | POST | `/api/v1/internal-control/reviews/{id}/findings/{findingId}/respond` | `{ response, evidenceAttachmentIds? }` + `If-Match` + `Idempotency-Key` | `200 { data: InternalControlFinding }` | 200, 403, 404, 409, 412, 422, 503 |
| `ICT-19` | GET | `/api/v1/internal-control/findings` | filtros `status`, `severity`, `processId`, `departmentId`, `olderThanDays`, cursor | `200 { data: Finding[], meta.nextCursor }` com `ageDays` | 200, 403, 422 |
| `ICT-09` | GET | `/api/v1/internal-control/reviews/{id}` | path `id` | achados com situação, resposta e autor | 200, 403, 404 |
| `ICT-11` | GET | `/api/v1/processes/{id}/internal-control` | path `id` | manifestação vigente e achados do processo | 200, 403, 404 |

## Logs
- `info` `internal_control.finding_addressed` — `reviewId`, `findingId`, `severity`, `round`, `correlationId`.
- `warn` `internal_control.finding_response_rejected` — `findingId`, `errorCode`; `warn` `outbox.publish_delayed`.
- `error` `internal_control.finding_respond_failed` — `errorCode`, causa resumida.
- **Nunca logar:** texto do achado, da recomendação ou da resposta; valores de orçamento sigiloso.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `internal_control_finding.respond` | `DATA_CHANGE` | Commit de ICT-18 | `changes` de `status`; `metadata`: `reviewId`, `severity`, `round` (sem o texto) |
| `access.denied` | `ACCESS` | 403 em ICT-18/ICT-19 | `reasonCode`, `findingId` |

## Testes necessários
- **Unitários:** transição `OPEN → ADDRESSED`, política de custódia, independência do analista, recálculo dos contadores do `RuleContext`, cálculo de `ageDays`.
- **Integração (Testcontainers):** ICT-18 em análise em andamento e concluída (trigger permite só o achado), auditoria, outbox, timeline; listagem com filtros e cursor; rollback total na falha.
- **API/contrato:** corpo, erros e idempotência de ICT-18; filtros e paginação de ICT-19.
- **RBAC e multi-tenant:** custódia × analista × auditor; 404 entre tenants; lista restrita a processos visíveis (DEC-024); teste novo na suíte "tenant leak".
- **Concorrência:** atendimento × aceite de risco; dois atendimentos simultâneos.
- **E2E (Playwright):** análise concluída com achados → responsável registra → contador do aviso na autorização cai → analista vê o saldo em "Achados em aberto".
- **Acessibilidade/performance:** axe em `FindingsTable` e no diálogo; p95 da lista < 1,5 s com 2.000 achados (suíte de performance).

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada
- [ ] Teste prova que o atendimento não altera a situação, o documento nem as versões analisadas
- [ ] Decisão do piloto registrada sobre a notificação do atendimento e sobre quem pode responder

## Estimativa
**S** — uma rota de escrita, uma de leitura e o recálculo dos contadores; a transição de estado já está definida e o esforço está na exceção à imutabilidade, na política de custódia e nos testes de concorrência.

## Prioridade
**P1** — acompanha o fechamento da fase preparatória sem bloquear a conclusão da manifestação nem a autorização (RN-ICT-12); entra depois das stories P0 do épico.

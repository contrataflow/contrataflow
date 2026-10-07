---
id: US-058
title: "Ações em lote na caixa de tarefas"
epic: EP-009
feature: FT-036
mvp: 1
priority: P2
estimate: M
status: Especificada
depends_on: [US-056]
modules: [process, access, platform]
screens: [SCR-013, SCR-115]
endpoints: [TSK-03, TSK-04]
permissions: [PROCESS_CLAIM, PROCESS_ASSIGN]
events: [ProcessAssigned]
---

# US-058 — Ações em lote na caixa de tarefas

## Título
Ações em lote na caixa de tarefas

## Descrição
**Como** membro da unidade com `PROCESS_CLAIM`, titular/substituto de unidade ou gestor com `PROCESS_ASSIGN`, **quero** selecionar várias linhas da fila da minha unidade e assumir ou atribuir todas de uma vez, **para** distribuir ou absorver um volume de processos sem repetir a ação uma a uma.

A partir da visão "Na fila da minha unidade" (SCR-013, US-056), o usuário marca várias linhas sem responsável e aciona **"Assumir selecionados"** ou **"Atribuir selecionados"** (diálogo SCR-115, adaptado para múltiplos processos). O sistema processa cada processo individualmente e devolve um resultado por item — sucesso parcial é esperado e normal.

## Contexto
- A caixa de tarefas unificada (US-056) já mostra a fila da unidade; em órgãos com volume alto (ex.: início de exercício, mutirões de triagem), repetir "Assumir" processo a processo é lento.
- Reaproveita integralmente as regras de "assumir" (POL-04/US-049) e "atribuir" (POL-05/US-050) por item; esta story apenas orquestra a execução em lote e o relato de resultado — não cria nova regra de autorização.
- Limite de 50 processos por lote (definido no pacote do épico) equilibra utilidade (mutirões reais) com tempo de resposta e raio de impacto de um erro operacional (ex.: atribuir muitos processos à pessoa errada).

## Objetivo
Permitir que um usuário processe até 50 processos da fila em uma única ação, com resultado claro por item (sucesso/erro), sem que a falha de um item impeça o sucesso dos demais.

## Persona
- **Principal:** membro lotado com `PROCESS_CLAIM` e titular/substituto de unidade (assumir em lote); gestor com `PROCESS_ASSIGN` (atribuir em lote).
- **Secundárias:** Equipe operacional que recebe a atribuição.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE`.
- Usuário está na visão "Na fila da minha unidade" (US-056) com ao menos dois processos sem responsável selecionáveis.
- Para atribuir: usuário tem `PROCESS_ASSIGN` com escopo adequado ou é titular/substituto da unidade atual dos processos (POL-05).

## Fluxo principal
1. Na visão "Na fila da minha unidade", o usuário marca as caixas de seleção de 2 a 50 linhas sem responsável; a barra de ações em lote exibe "{N} selecionados" com os botões **"Assumir selecionados"** e **"Atribuir selecionados"**.
2. **Assumir em lote:** o usuário clica em "Assumir selecionados" e confirma; o front chama `TSK-03` (`POST /tasks/bulk-claim`) com `{ processIds: [...] }`, `Idempotency-Key` e, para cada item, o `If-Match` capturado na listagem.
3. **Atribuir em lote:** o usuário clica em "Atribuir selecionados"; o sistema abre o diálogo SCR-115 adaptado ("Atribuir {N} processos a"), o usuário escolhe o responsável (lista filtrada por lotação ativa na unidade atual e `PROCESS_VIEW`) e informa o motivo (obrigatório — POL-05); o front chama `TSK-04` (`POST /tasks/bulk-assign`) com `{ processIds: [...], assigneeId, reason }`, `Idempotency-Key` e os `If-Match` capturados.
4. A API processa cada `processId` individualmente (mesma regra de POL-04/POL-05 por item) e retorna `200` com um resultado por item: sucesso (processo atualizado) ou erro (código e mensagem), sem transação única entre itens.
5. O front exibe um resumo: "42 de 45 processos assumidos. 3 não puderam ser assumidos." com a lista dos erros por processo (ex.: "0012/2026 — já havia sido assumido por outra pessoa").
6. A lista e os contadores da caixa de tarefas são revalidados; os itens processados com sucesso saem de "Na fila da minha unidade".

## Fluxos alternativos
- **FA-01 — Seleção acima do limite:** ao marcar o 51º item, a UI desabilita novas seleções e exibe "Selecione no máximo 50 processos por vez."; se mesmo assim a API receber mais de 50, responde 422.
- **FA-02 — Todos os itens falham:** a API ainda responde 200 (resultado por item, todos com erro); a UI trata esse caso como falha total e destaca "Nenhum processo pôde ser processado." sem remover itens da lista.
- **FA-03 — Processo muda de etapa entre a seleção e o envio:** o item correspondente falha com `STAGE_CHANGED` (409); os demais seguem normalmente.
- **FA-04 — Atribuir sem responsável elegível:** se o responsável escolhido perder a lotação na unidade entre a abertura do diálogo e o envio, aquele item falha com `ASSIGNEE_NOT_ELIGIBLE`; os demais seguem.
- **FA-05 — Cancelar seleção:** o usuário desmarca todas as linhas ou clica em "Cancelar seleção"; a barra de ações em lote desaparece sem chamada à API.

## Regras de negócio
- **RN-INBOX-19** — Lote de 2 a 50 `processId` distintos por requisição; fora desse intervalo, a API responde 422 `VALIDATION_ERROR` com `errors[].code = "TOO_SHORT"` (< 2) ou `"TOO_LONG"` (> 50) no campo `processIds` — não há código de erro específico de lote nas fontes canônicas.
- **RN-INBOX-20** — `bulk-claim` (`TSK-03`) aplica POL-04 individualmente a cada `processId`: só é bem-sucedido quem está na fila (sem responsável), na unidade atual do usuário, e o usuário tem `PROCESS_CLAIM`; os demais retornam o erro de POL-04 (`PROCESS_ALREADY_ASSIGNED`) ou de elegibilidade, sem interromper o lote.
- **RN-INBOX-21** — `bulk-assign` (`TSK-04`) atribui todos os `processId` do lote ao **mesmo** `assigneeId`, aplicando POL-05 individualmente (escopo `TENANT`/`ORGANIZATION` que cubra o processo, ou titular/substituto da unidade atual); `reason` é obrigatório para o lote inteiro (mesma exigência de motivo da reatribuição manual, DEC-022/POL-05).
- **RN-INBOX-22** — O processamento do lote não é uma única transação: cada `processId` é processado em sua própria transação (mesma usada por `PRC-21`/`PRC-22`), de modo que sucesso e erro podem coexistir no mesmo resultado.
- **RN-INBOX-23** — `Idempotency-Key` cobre o lote inteiro (mesma chave + mesmo corpo em 24 h devolve o mesmo resultado por item, sem reprocessar); mesma chave com corpo diferente → 422 `IDEMPOTENCY_KEY_REUSED` (§1.3 de api.md).
- **RN-INBOX-24** — Cada item bem-sucedido gera `ProcessAssigned` individualmente (payload conforme events.md, `assignmentType = CLAIM` ou `MANUAL`), com as mesmas projeções e notificações de US-049/US-050 (`PROCESS_CLAIMED` sem destinatários; `PROCESS_ASSIGNED` notifica o novo responsável, exceto quando ele é o próprio ator).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Processos selecionados | `processIds` | array de uuid | Sim | 2–50 itens, sem repetição (RN-INBOX-19) | seleção na tabela |
| Responsável (atribuir) | `assigneeId` | uuid | Sim (só em `bulk-assign`) | vínculo ativo, lotado na unidade atual, `PROCESS_VIEW` | — |
| Motivo (atribuir) | `reason` | texto | Sim (só em `bulk-assign`) | não vazio | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `processIds` com menos de 2 itens | Front + API | "Selecione ao menos 2 processos." | `VALIDATION_ERROR` (`TOO_SHORT`) |
| V-02 | `processIds` com mais de 50 itens | Front + API | "Selecione no máximo 50 processos por vez." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-03 | `processIds` com item repetido | API | — | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) |
| V-04 | `assigneeId`/`reason` ausentes em `bulk-assign` | Front + API | "Selecione o responsável e informe o motivo." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-05 | Mesma `Idempotency-Key` com corpo diferente | API | "Esta solicitação já foi enviada com outros dados." | `IDEMPOTENCY_KEY_REUSED` |

## Permissões
- **Permissão:** `PROCESS_CLAIM` (POL-04) por item em `bulk-claim`; `PROCESS_ASSIGN` ou titular/substituto (POL-05) por item em `bulk-assign`.
- **Políticas:** POL-04, POL-05 — aplicadas individualmente a cada `processId`, nunca de forma agregada.
- **MFA:** não exigido (`PROCESS_CLAIM` risco `L`; `PROCESS_ASSIGN` risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** sem `PROCESS_CLAIM`/`PROCESS_ASSIGN` nenhum, os botões de lote não aparecem; a API responde 403 `PERMISSION_DENIED` para o lote inteiro somente se o usuário não tiver a permissão base (itens individualmente inelegíveis retornam erro por item, não 403 global).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessAssigned` | `process.assigned` | Por item bem-sucedido do lote | `assignmentType = CLAIM` (bulk-claim) ou `MANUAL` (bulk-assign); payload igual ao de US-049/US-050 |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `PROCESS_CLAIMED` | — (nenhum destinatário) | — | Por item bem-sucedido de `bulk-claim` (reaproveita US-049; sem notificação) |
| `PROCESS_ASSIGNED` | Novo responsável (exceto se for o próprio ator) | In-app | Por item bem-sucedido de `bulk-assign` (reaproveita US-050) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Ações em lote na caixa de tarefas

  Background:
    Given que o usuário "Carlos" está autenticado no tenant "Prefeitura de São José"
    And "Carlos" é titular da unidade "Setor de Manutenção"

  Scenario: [Sucesso] Assumir vários processos de uma vez
    Given que existem 5 processos sem responsável na fila do "Setor de Manutenção"
    When "Carlos" selecionar os 5 processos e clicar em "Assumir selecionados"
    Then a API deve responder 200 com 5 resultados de sucesso
    And os 5 processos devem passar a ter "Carlos" como responsável
    And devem ser gerados 5 eventos "ProcessAssigned"

  Scenario: [Sucesso] Sucesso parcial — um item falha sem afetar os demais
    Given que, dos 5 processos selecionados, 1 já foi assumido por outra pessoa
    When "Carlos" clicar em "Assumir selecionados"
    Then a API deve responder 200 com 4 resultados de sucesso e 1 erro "PROCESS_ALREADY_ASSIGNED"
    And os 4 processos bem-sucedidos devem sair da fila da unidade

  Scenario: [Validação] Lote acima do limite
    When "Carlos" enviar "bulk-claim" com 51 processos
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_LONG" no campo "processIds"
    And nenhum processo deve ser assumido

  Scenario: [Permissão] Atribuir em lote sem PROCESS_ASSIGN e sem titularidade
    Given que "Daniela" não possui "PROCESS_ASSIGN" e não é titular nem substituta de nenhuma unidade
    When "Daniela" tentar enviar "bulk-assign"
    Then a API deve responder 403 com código "PERMISSION_DENIED" para o lote
    And deve gerar registro de auditoria "access.denied" com reasonCode "PROCESS_ASSIGN"

  Scenario: [Tenant incorreto] Processo de outro tenant no lote
    Given que um dos "processId" enviados pertence a outro tenant
    When "Carlos" enviar "bulk-claim" com esse lote
    Then o item desse processo deve retornar erro "REFERENCE_NOT_FOUND" sem revelar sua existência
    And os demais itens válidos devem ser processados normalmente

  Scenario: [Duplicidade] Reenvio do lote com a mesma chave de idempotência
    Given que "Carlos" enviou "bulk-claim" com a chave "K2" e recebeu 200 com 5 sucessos
    When a mesma requisição for reenviada com a chave "K2"
    Then a API deve responder 200 com o mesmo resultado e o cabeçalho "Idempotent-Replayed: true"
    And nenhum processo deve ser assumido novamente

  Scenario: [Concorrência] Dois usuários enviam lotes com processos em comum
    Given que os processos "0012/2026" e "0013/2026" estão sem responsável
    When "Carlos" e "Fernanda" enviarem "bulk-claim" incluindo ambos os processos quase simultaneamente
    Then cada processo deve ter exatamente um responsável final
    And o usuário que não conseguiu deve receber erro "PROCESS_ALREADY_ASSIGNED" para aquele item

  Scenario: [Falha de banco] Banco indisponível durante o lote
    Given que o banco de dados fica indisponível no meio do processamento do lote
    When "Carlos" enviar "bulk-claim"
    Then os itens já processados antes da indisponibilidade devem permanecer consistentes
    And os itens não processados devem retornar erro "DEPENDENCY_UNAVAILABLE"

  Scenario: [Falha de integração] Relay do outbox indisponível durante o lote
    Given que o relay do outbox está indisponível
    When "Carlos" assumir 5 processos com sucesso
    Then a API deve responder 200 para os 5 itens
    And os 5 eventos "ProcessAssigned" devem permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Lote com menos de 2 itens | 422 | `VALIDATION_ERROR` (`TOO_SHORT`) | "Selecione ao menos 2 processos." | Mantém seleção |
| Lote acima de 50 | 422 | `VALIDATION_ERROR` (`TOO_LONG`) | "Selecione no máximo 50 processos por vez." | Desabilita novas seleções |
| Sem permissão base | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação em lote." | Oculta botão de lote |
| Item já atribuído | 200 (item) | `PROCESS_ALREADY_ASSIGNED` | "{código} já havia sido assumido por outra pessoa." | Lista de erros do resumo |
| Item de outro tenant/inexistente | 200 (item) | `REFERENCE_NOT_FOUND` | "{código} não pôde ser processado." | Lista de erros do resumo |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta solicitação já foi enviada com outros dados." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir a ação agora." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-056 (caixa de tarefas e visão da fila da unidade, pré-requisito de navegação). Indiretas: US-049 (regra de assumir, reaproveitada por item), US-050 (regra de atribuir, reaproveitada por item), US-097, US-102.
- **Decisões/ADRs:** DEC-022, DEC-024, DEC-026, DEC-105 (idempotência).
- **Configurações:** nenhuma (limite fixo de 50 itens por lote no MVP 1, registrado em api.md TSK-03/04).
- **Lacunas nas fontes canônicas:** nenhuma (lote fora do limite → `VALIDATION_ERROR` com `errors[].code` `TOO_SHORT`/`TOO_LONG`, api.md §2.1.1; limite registrado em TSK-03/04).

## Impacto técnico
- Reaproveita os `Command`/transação de `PRC-21`/`PRC-22` item a item — nenhuma nova regra de domínio, apenas um orquestrador que itera a lista e agrega resultados (sem transação distribuída).
- Processamento item a item é sequencial e síncrono dentro da requisição (até 50 itens); se o tempo de resposta não for aceitável em produção, considerar processamento paralelo controlado (ex.: `Promise.allSettled` com limite de concorrência) — não é pré-requisito para esta story dado o teto de 50.

## Backend
- **Módulo(s):** `process` (dono, reaproveita `ClaimProcessHandler`/`AssignProcessHandler` de US-049/US-050); usa `platform` (`IdempotencyService` para o lote).
- **Casos de uso:** `BulkClaimProcessesCommand` → `BulkClaimProcessesHandler` (TSK-03); `BulkAssignProcessesCommand` → `BulkAssignProcessesHandler` (TSK-04).
- **Domínio:** nenhuma entidade nova; cada item reaproveita `Process`/`ProcessAssignment` existentes.
- **Integrações internas:** `ClaimProcessHandler`, `AssignProcessHandler` (chamados por item, cada um em sua própria transação).
- **Transação:** uma transação por item (não uma transação para o lote inteiro); falha de um item nunca desfaz os demais.

## Frontend
- **Tela(s):** SCR-013 (`/tarefas`, seleção múltipla na visão "Na fila da minha unidade"); SCR-115 (diálogo de atribuição adaptado para múltiplos processos).
- **Componentes:** `BulkActionBar` ("{N} selecionados"), `BulkResultSummary` (sucesso/erro por item), `AssigneeSelect` (reaproveitado de US-050).
- **Estados:** barra de ações oculta sem seleção; botões desabilitados durante o processamento ("Processando {N} processos…"); resumo com lista expansível de erros.
- **Acessibilidade e responsividade:** seleção por teclado (checkbox com `aria-label` por linha); resumo de resultado anunciado via `aria-live`; barra de ações fixa no rodapé em telas pequenas.

## Banco de dados
- **Tabelas:** mesmas de `PRC-21`/`PRC-22` (`process_assignments`, `process_stages`, `processes`, `audit_logs`, `outbox_events`); nenhuma tabela nova.
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** reaproveita os de `process_assignments` (ver US-056); nenhum índice novo.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| TSK-03 | POST | `/api/v1/tasks/bulk-claim` | `{ processIds: uuid[] }` + `Idempotency-Key` | `200 { data: [{ processId, ok, code?, message?, process? }], meta: { successCount, errorCount } }` | 200, 401, 403, 422, 429, 500, 503 |
| TSK-04 | POST | `/api/v1/tasks/bulk-assign` | `{ processIds: uuid[], assigneeId, reason }` + `Idempotency-Key` | `200 { data: [{ processId, ok, code?, message?, process? }], meta: { successCount, errorCount } }` | 200, 401, 403, 422, 429, 500, 503 |

## Logs
- `info` `tasks.bulk_claim` / `tasks.bulk_assign` — `batchSize`, `successCount`, `errorCount`, `durationMs`, `correlationId`.
- `warn` `tasks.bulk_partial_failure` — quando `errorCount` > 0.
- `error` `tasks.bulk_failed` — falha que impediu o processamento do lote inteiro (ex.: banco indisponível antes de iniciar).
- **Nunca logar:** motivo da atribuição (`reason`) em texto livre além do necessário à auditoria.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.claim` | `WORKFLOW` | Por item bem-sucedido de `bulk-claim` | `metadata.batchId`, `metadata.idempotencyKey` (mesma ação de US-049) |
| `process.assign` | `WORKFLOW` | Por item bem-sucedido de `bulk-assign` | `metadata.batchId`, `reason` (mesma ação de US-050) |
| `access.denied` | `ACCESS` | Lote rejeitado por falta de permissão base | `reasonCode = PROCESS_CLAIM\|PROCESS_ASSIGN` |

## Testes necessários
- **Unitários:** validação de tamanho do lote (2–50, RN-INBOX-19); agregação de resultados por item.
- **Integração (Testcontainers):** lote misto (itens elegíveis e inelegíveis) retorna sucesso parcial; idempotência do lote.
- **Concorrência:** dois lotes concorrentes com processos em comum (apenas um vence por item).
- **API/contrato:** formato de resposta por item conforme api.md; cabeçalhos de idempotência.
- **RBAC e multi-tenant:** item de outro tenant no lote não é revelado; permissão base checada antes de iniciar.
- **E2E (Playwright):** selecionar múltiplos itens, assumir em lote, ver resumo e contadores atualizados; atribuir em lote com motivo obrigatório.
- **Performance:** lote de 50 itens processado em tempo aceitável (meta: < 5 s no p95).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] POL-04/POL-05 aplicadas item a item; nenhuma checagem agregada substitui a checagem individual
- [ ] Resultado por item comprovado em teste de lote misto (sucesso + erro)
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de TSK-03 e TSK-04 compatível com api.md
- [ ] Logs sem dados sensíveis; métrica de tamanho de lote e taxa de erro
- [ ] Acessibilidade (axe) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Limite de lote (2–50) e erros `TOO_SHORT`/`TOO_LONG` cobertos por testes de integração

## Estimativa
**M** — orquestração sobre regras já existentes (sem nova lógica de domínio), mas com complexidade de resultado parcial, idempotência de lote e UI de seleção múltipla.

## Prioridade
**P2** — melhoria de produtividade para cenários de volume; a caixa de tarefas (US-056) e a lista de aprovações (US-057) já atendem o uso individual.

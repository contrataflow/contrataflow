---
id: US-149
title: "Abrir a análise jurídica e fila priorizada"
epic: EP-025
feature: FT-073
mvp: 2
priority: P0
estimate: L
status: Especificada
depends_on: [US-047, US-097, US-104]
modules: [legal-review, process, workflow, organization, access, timeline, notification, audit, platform]
screens: [SCR-019, SCR-006]
endpoints: [LGL-01, LGL-02, LGL-09]
permissions: [LEGAL_REVIEW_VIEW, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [LegalReviewOpened]
---

# US-149 — Abrir a análise jurídica e fila priorizada

## Título
Abrir a análise jurídica e fila priorizada

## Descrição
**Como** procurador, chefe da assessoria jurídica ou auditor do órgão, **quero** que cada processo que chega à etapa `JURIDICO` abra sozinho uma análise jurídica na fila, ordenada por critérios objetivos e com os fatores da ordem à vista, **para** que a Procuradoria trabalhe pela prioridade real (prazo, urgência, valor e antiguidade) e não pela ordem de insistência, e para que qualquer pessoa autorizada consiga explicar por que uma análise está à frente de outra (art. 53, § 1º, I, da Lei 14.133/2021).

A story entrega: (1) a abertura da `LegalReview` `PENDING` na entrada da etapa `JURIDICO` (e a nova análise quando o processo volta depois de uma análise concluída); (2) o cálculo e o recálculo de `queuePriorityScore` e `priorityFactors`; (3) a fila da SCR-019 (`/juridico`) com filtros, ordenação e fatores visíveis (LGL-01); (4) o detalhe/painel da análise (LGL-02, que as demais stories apenas estendem); (5) o resumo da fila e da carga por procurador (LGL-09). Distribuir é da US-150; configurar critérios e hipóteses é da US-151; iniciar a análise é da US-152; diligência e retomada em nova rodada são da US-153.

## Contexto
- A DEC-199 cria a `LegalReview` por processo e define a fila priorizada por critérios objetivos configuráveis (prazo, valor, urgência, data de entrada); a DEC-196 posiciona a etapa `JURIDICO` depois de `DOTACAO` e `MINUTA_EDITAL` e antes de `CONTROLE_INTERNO` no workflow padrão v2 e define que a análise é **retomada, não recriada**, quando o processo volta de uma diligência.
- `entities.md §4.3` já define os campos `sequence`, `enteredQueueAt`, `queuePriorityScore` (`numeric(12,4)`), `priorityFactors` (`jsonb`), o índice da fila `(tenant_id, status, queue_priority_score DESC, entered_queue_at)` e o unique parcial de **uma análise aberta por processo**. `§7.5` fixa o schema `LegalQueueCriteria` (fator, peso 0..100, direção) e o padrão semeado (prazo da etapa, urgência, valor estimado, data de entrada).
- O valor estimado pode ser sigiloso (art. 24; DEC-030): ele participa do cálculo, mas `priorityFactors` grava só a **faixa**, nunca o valor (RN-LGL-04). Esta story vai além do mínimo: o termo do valor é calculado **a partir da faixa**, de modo que nem o score carrega mais informação que a faixa.
- A fila só lista análises de processos **visíveis** ao usuário (DEC-024) cujo escopo de `LEGAL_REVIEW_VIEW` cubra o processo (`permissions.md §5.3`); o predicado é o `buildVisibilityPredicate` da US-097.
- O evento `LegalReviewOpened` (`events.md §4.5`) alimenta a timeline (`LEGAL_REVIEW_OPENED`), a notificação `LEGAL_REVIEW_QUEUED` ao titular e ao substituto da unidade jurídica e o read model.
- O que é "urgência" no produto: `Process.priority` (`Priority`: `LOW`, `MEDIUM`, `HIGH`, `URGENT`) do MVP 1; o prazo é `ProcessStage.dueAt` da passagem por `JURIDICO` (DEC-031); o valor é `Process.estimatedValue` (DEC-032).

## Objetivo
Garantir que 100% dos processos que entram em `JURIDICO` tenham, na mesma transação da tramitação, exatamente uma análise aberta com score e fatores registrados, que a fila abra em até 1,5 s (p95) com 500 análises abertas, que a ordem seja explicável em um clique e que nenhum valor sigiloso apareça em fatores, eventos, notificações ou logs.

## Persona
- **Principal:** Jurídico / procurador (`JURIDICO`) — consulta a fila e abre o painel das análises.
- **Secundárias:** chefe da assessoria jurídica (titular ou substituto da unidade jurídica; acompanha e distribui — US-150); Gestor de contratações (`GESTOR_CONTRATACOES`) e Autoridade competente (`AUTORIDADE_COMPETENTE`), que leem a fila dentro do escopo; Auditor (`AUDITOR`: confere ordem e fatores); Controle Interno (`CONTROLE_INTERNO`: leitura).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`; sessão com MFA conforme `security.mfaPolicy` (`LEGAL_REVIEW_VIEW` é risco `L`: MFA não exigido).
- Para ler a fila e o painel: `LEGAL_REVIEW_VIEW` com escopo que cubra o processo e processo visível (DEC-024).
- Para a abertura (automática): workflow com a etapa de chave `JURIDICO` na versão do processo (workflow v2 adotado ou etapa equivalente criada pelo tenant com essa chave) e o processo `IN_PROGRESS`.
- Chave `legalReview.queueCriteria` semeada no tenant (padrão de `entities.md §7.5`); ausente, vale o padrão do registro.

## Fluxo principal
1. O responsável da etapa anterior encaminha o processo "0045/2026" (US-047) para a etapa `JURIDICO`; a tramitação publica `ProcessStageChanged` com `toStage.key = JURIDICO`.
2. Na **mesma transação** da tramitação, o `StageLifecycleListener` do módulo `legal-review` verifica se há análise aberta do processo (RN-LGL-31). Não havendo, cria a `LegalReview`: `status = PENDING`, `sequence = max + 1`, `processStageId` e `currentProcessStageId` = passagem recém-aberta, `currentRound = 1`, `enteredQueueAt = now()`.
3. O `LegalQueueScoreCalculator` lê o prazo da etapa, a prioridade e o valor estimado do processo e os critérios do tenant (`legalReview.queueCriteria`), calcula `queuePriorityScore` e grava `priorityFactors` (RN-LGL-32/33).
4. Na mesma transação grava a linha de timeline `LEGAL_REVIEW_OPENED` e o evento `LegalReviewOpened` no outbox. Depois do commit, o outbox entrega a notificação `LEGAL_REVIEW_QUEUED` ao titular e ao substituto da unidade jurídica da etapa.
5. O procurador abre a SCR-019 (`/juridico`); o front chama `GET /legal-reviews` (LGL-01) com os filtros da URL; a API aplica o predicado de visibilidade e o escopo, ordena por `queuePriorityScore` decrescente e devolve a página com o resumo dos fatores de cada linha.
6. A tela mostra, por linha: posição, código do processo, objeto, secretaria solicitante, situação, responsável (ou "Sem responsável"), prazo da etapa (com selo "vencido" quando for o caso), faixa de valor, urgência e o botão "Por que esta ordem?" que expande os fatores (nome, peso, direção, entrada considerada e contribuição).
7. O front chama `GET /legal-reviews/summary` (LGL-09) para os contadores do topo ("Aguardando", "Em análise", "Sem responsável", "Vencidas", "Minhas") e para a carga por procurador usada na distribuição (US-150).
8. O procurador abre uma análise (`/juridico/[reviewId]`); o front chama `GET /legal-reviews/{id}` (LGL-02) e exibe o painel: processo, objeto, etapa e prazo, situação, rodada, responsável, fatores completos e links para o processo (SCR-006). Os botões de ação (distribuir, iniciar, pedir diligência, concluir…) são acrescentados pelas stories seguintes.
9. Quando urgência, valor ou prazo mudam, o `LegalQueueRescoreHandler` relê o estado atual, recalcula o score e atualiza a linha **sem alterar a versão (ETag)** da análise; a posição na fila muda na próxima consulta (RN-LGL-34).

## Fluxos alternativos
- **FA-01 — Processo volta a `JURIDICO` com análise aberta:** se existe `LegalReview` em `PENDING`, `IN_REVIEW` ou `DILIGENCE`, o listener **não cria** outra; aciona o ponto de extensão de retomada (US-153: rodada + 1, `currentProcessStageId` novo). Esta story só garante a não duplicação (RN-LGL-31).
- **FA-02 — Processo volta depois de análise concluída:** se a última análise é final (`FAVORABLE*`, `UNFAVORABLE`, `WAIVED` ou `CANCELED`), nasce nova `LegalReview` com `sequence + 1`, `PENDING`, novo `enteredQueueAt` e novo score; o painel mostra "Reanálise (análise anterior: {sequence})" com link para a anterior (por exemplo, devolução do Controle Interno).
- **FA-03 — Reentrega do evento de tramitação:** a abertura é idempotente pela passagem (`processStageId`); a reentrega não cria segunda análise nem segundo evento (RN-LGL-31).
- **FA-04 — Fator sem dado:** processo sem valor estimado ainda, ou etapa sem prazo, tem o termo daquele fator igual a 0, registrado como "Sem estimativa" ou "Sem prazo" nos fatores; o processo fica na fila normalmente (RN-LGL-32).
- **FA-05 — Orçamento sigiloso e usuário sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`:** a faixa de valor é devolvida como `null` com `masked: true` e a linha exibe "Faixa restrita"; o cálculo e a ordem não mudam (RN-LGL-33).
- **FA-06 — Filtro por faixa de valor com processo sigiloso:** para quem não tem a permissão de sigilo, processos sigilosos não casam com o filtro `valueBand`, para que o filtro não revele a faixa por inferência (RN-LGL-33).
- **FA-07 — Prioridade, valor ou prazo alterados:** o score é recalculado; o painel mostra "Prioridade recalculada em {data e hora}" e o motivo resumido (`urgência`, `valor`, `prazo`, `critérios`) (RN-LGL-34).
- **FA-08 — Passagem do tempo:** o prazo restante e a antiguidade mudam sem evento; o job diário de recálculo (00:30, fuso do tenant) atualiza os scores das análises `PENDING` e `IN_REVIEW` (RN-LGL-34).
- **FA-09 — Unidade jurídica sem titular nem substituto:** a análise abre normalmente; não há destinatário para `LEGAL_REVIEW_QUEUED`, o log `warn` `legal_review.queued_without_recipient` é gravado e a fila segue visível.
- **FA-10 — Fila vazia ou sem resultado:** estado vazio "Nenhuma análise na fila" ou "Nenhuma análise corresponde aos filtros" com o atalho "Limpar filtros".
- **FA-11 — Análise de processo invisível:** não aparece na lista; o detalhe responde 404 `LEGAL_REVIEW_NOT_FOUND`, nunca 403 (DEC-024, US-097 FA-05).
- **FA-12 — Processo suspenso:** a análise permanece na fila com o selo "Processo suspenso"; o prazo estendido pela suspensão (DEC-031) dispara o recálculo.

## Regras de negócio
- **RN-LGL-01** — Ao entrar em `JURIDICO` abre-se uma `LegalReview` `PENDING`; há uma análise aberta por processo, e uma nova só nasce se o processo voltar a `JURIDICO` depois de uma análise concluída (DEC-199). *(regra da feature, adotada)*
- **RN-LGL-02** — A fila usa critérios objetivos configuráveis (prazo da etapa, urgência, valor estimado, data de entrada), com pesos de 0 a 100 e direção; o padrão semeado segue essa ordem (DEC-199, overview §7). *(regra da feature, adotada)*
- **RN-LGL-03** — A prioridade é recalculada quando mudam prazo, urgência ou valor; `priorityFactors` guarda os fatores usados, de forma auditável (art. 53, § 1º, I) (DEC-199). *(regra da feature, adotada)*
- **RN-LGL-04** — Valor sigiloso participa do cálculo, mas `priorityFactors` grava só a faixa, nunca o valor (DEC-030). *(regra da feature, adotada)*
- **RN-LGL-05** — A fila lista só análises de processos visíveis ao usuário, dentro do escopo de `LEGAL_REVIEW_VIEW` (DEC-024). *(regra da feature, adotada)*
- **RN-LGL-30** — Abertura: o gatilho é `ProcessStageChanged` (qualquer causa que leve a `JURIDICO`: `FORWARD`, `RETURN`, `APPROVAL_*`) cuja etapa de destino tem `key = JURIDICO`; o `StageLifecycleListener` é **síncrono**, na transação da tramitação (padrão dos projetores `TimelineProjector`/`ProcessAccessProjector`), de modo que um processo nunca esteja em `JURIDICO` sem análise aberta. Falha ao abrir desfaz a tramitação (nada parcial). A abertura não exige permissão do usuário que encaminha e não gera auditoria própria (events.md §8: ator "sistema, pela tramitação").
- **RN-LGL-31** — Uma análise aberta por processo e idempotência: há análise aberta (`PENDING`, `IN_REVIEW`, `DILIGENCE`) → nenhuma criação (retomada é da US-153); última análise final → nova com `sequence + 1`. A criação é idempotente pela chave natural `(tenant_id, process_stage_id)` e protegida pelos uniques `(tenant_id, process_id, sequence)` e `(tenant_id, process_id) WHERE status IN ('PENDING','IN_REVIEW','DILIGENCE')`; violação concorrente é tratada como "já aberta".
- **RN-LGL-32** — Cálculo do score: `queuePriorityScore = Σ (peso × termo)` sobre os quatro fatores de `legalReview.queueCriteria`, com termo normalizado em `[0, 1]`: **prazo** (`STAGE_DUE_AT`): `r = clamp(diasCorridosRestantes / 30, 0, 1)` (vencido = 0; 30 dias ou mais = 1; sem prazo = fator sem dado); **urgência** (`URGENCY`): `r` = `LOW` 0, `MEDIUM` 1/3, `HIGH` 2/3, `URGENT` 1; **valor** (`ESTIMATED_VALUE`): `r = (índiceDaFaixa − 1) / 4` (RN-LGL-33; sem estimativa = fator sem dado); **entrada** (`ENTERED_QUEUE_AT`): `r = 1 − clamp(diasNaFila / 30, 0, 1)`. A direção define o termo: `DESC` usa `r` (maior primeiro); `ASC` usa `1 − r` (menor primeiro). **Fator sem dado contribui 0**, qualquer que seja a direção. Resultado arredondado a 4 casas. Padrão semeado: prazo `ASC` peso 40, urgência `DESC` peso 30, valor `DESC` peso 20, entrada `ASC` peso 10. Empate: `enteredQueueAt` mais antigo, depois `id`.
- **RN-LGL-33** — Faixas de valor (constante do produto, não configurável nesta entrega): `B1` até R$ 50.000; `B2` acima de R$ 50.000 até R$ 200.000; `B3` acima de R$ 200.000 até R$ 1.000.000; `B4` acima de R$ 1.000.000 até R$ 10.000.000; `B5` acima de R$ 10.000.000; `NOT_ESTIMATED` sem valor. `priorityFactors` guarda só `band`, nunca o valor, e o termo do valor sai do índice da faixa. A resposta devolve a faixa; para orçamento sigiloso e usuário sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` devolve `band: null, masked: true`; o filtro `valueBand` ignora processos sigilosos para esse usuário (DEC-030, POL-09).
- **RN-LGL-34** — Recálculo: o `LegalQueueRescoreHandler` (assíncrono, fila `domain-events`) reage a `process.updated` com `changedFields` contendo `priority` ou `estimatedValue`, a `process.status_changed.*` (suspensão e retomada estendem o prazo — DEC-031), a `legal_review.resumed`, a `sla_policy.changed` e a `TenantSettingsChanged` da chave `legalReview.queueCriteria` (lote, US-151); lê o **estado atual**, não o payload, e é idempotente (reentrega não muda nada). Um job diário (00:30 no fuso do tenant) cobre a passagem do tempo. Só recalcula `PENDING` e `IN_REVIEW`. O recálculo atualiza `queuePriorityScore`, `priorityFactors` e `priorityCalculatedAt` e **não** altera `version` (a ETag) nem `updatedAt`, para não invalidar distribuição ou início em curso. Não gera evento nem linha de auditoria por análise (o rastro é `priorityFactors` + a auditoria da configuração, US-151).
- **RN-LGL-35** — Consulta da fila (LGL-01): ordenação padrão `queuePriorityScore DESC, enteredQueueAt ASC, id ASC`; `sort` aceita ainda `stageDueAt` e `enteredQueueAt`; paginação por cursor (`cursor`, `limit` padrão 50, máximo 100) sobre a chave de ordenação; filtros: `status[]` (padrão `PENDING` e `IN_REVIEW`), `assignee` (`me`, `none` ou id), `dueFrom`/`dueTo`, `valueBand[]`, `priority[]`, `secretariatId`, `q` (código ou objeto). Itens que mudam de posição durante a paginação podem repetir ou faltar entre páginas; a UI reconsulta a primeira página no "Atualizar".
- **RN-LGL-36** — Visibilidade e escopo: LGL-01, LGL-02 e LGL-09 aplicam o predicado de visibilidade (DEC-024) e o escopo de `LEGAL_REVIEW_VIEW` na própria consulta SQL (nunca filtrando depois); análise de outro tenant ou de processo invisível é inexistente (404 no detalhe). Os contadores de LGL-09 respeitam o mesmo filtro.
- **RN-LGL-37** — Explicabilidade: cada item traz `priorityFactors` resumido (`total` e, por fator, `weight`, `direction`, `contribution`); o detalhe traz as entradas (`dueAt`, `priority`, `band`, `enteredQueueAt`), `criteriaVersion` (versão da chave no cálculo) e `calculatedAt`. Recalcular com os mesmos dados e os mesmos critérios dá o mesmo resultado (função pura do instante `calculatedAt`).
- **RN-LGL-38** — Painel (LGL-02): devolve a `LegalReview`, o resumo do processo (código, objeto, secretaria solicitante, etapa, prazo, situação), `priorityFactors` completos, o responsável, `currentRound` e `ETag` (= `version`). Os itens de ação são aditivos nas stories seguintes (`canStart`, `canAssign`…).
- **RN-LGL-39** — Resumo (LGL-09): `counts` por situação aberta (`PENDING`, `IN_REVIEW`, `DILIGENCE`), `unassigned` (`PENDING` sem responsável), `overdue` (prazo da etapa vencido), `mine` (designadas ao usuário) e `byAssignee[]` (`assigneeId`, `name`, `pending`, `inReview`) restrito ao visível; sem valores monetários nem faixas. Meta de desempenho: LGL-01 p95 < 1,5 s com 500 análises abertas; LGL-02 e LGL-09 p95 < 400 ms (escritas na suíte de performance, medidas no endurecimento).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Situação | `status[]` (filtro) | lista de `LegalReviewStatus` | Não | valores do enum | `PENDING`, `IN_REVIEW` |
| Responsável | `assignee` (filtro) | `me` \| `none` \| uuid | Não | uuid do tenant | — |
| Prazo de / até | `dueFrom`, `dueTo` (filtro) | data | Não | `dueFrom` <= `dueTo` | — |
| Faixa de valor | `valueBand[]` (filtro) | `B1`..`B5` | Não | RN-LGL-33 | — |
| Urgência | `priority[]` (filtro) | `Priority` | Não | `LOW`..`URGENT` | — |
| Secretaria | `secretariatId` (filtro) | uuid | Não | visível ao usuário | — |
| Busca | `q` (filtro) | texto | Não | 2..100 | — |
| Ordenação | `sort` | `priority` \| `stageDueAt` \| `enteredQueueAt` | Não | RN-LGL-35 | `priority` |
| Paginação | `cursor`, `limit` | texto, int | Não | `limit` 1..100 | 50 |
| *(saída)* Posição / score | `position`, `queuePriorityScore` | int, decimal | — | derivado da página | servidor |
| *(saída)* Fatores | `priorityFactors` | objeto | — | RN-LGL-37 | `LegalReview` |
| *(saída)* Faixa de valor | `valueBand`, `masked` | texto / booleano | — | RN-LGL-33 | derivado |
| *(saída)* Entrada na fila | `enteredQueueAt` | datetime | — | `now()` na abertura | servidor |
| *(saída)* Versão | `ETag` | texto | — | `version` | servidor |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `status`, `priority`, `valueBand` ou `sort` fora dos valores permitidos | Front + API (Zod) | "Revise os filtros escolhidos." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-02 | `limit` fora de 1..100 | API | "Escolha de 1 a 100 itens por página." | `VALIDATION_ERROR` |
| V-03 | `cursor` inválido ou de outra ordenação | API | "Não foi possível continuar a lista. Atualize a fila." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-04 | `dueFrom` posterior a `dueTo` | Front + API | "A data inicial deve ser anterior à final." | `VALIDATION_ERROR` |
| V-05 | `assignee` ou `secretariatId` inexistente no tenant | API | "Selecione um responsável válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-06 | Usuário sem `LEGAL_REVIEW_VIEW` cobrindo o escopo | API | "Você não tem permissão para ver a fila jurídica." | `PERMISSION_DENIED` (403) |
| V-07 | Análise inexistente, de outro tenant ou de processo invisível | API | "Análise jurídica não encontrada." | `LEGAL_REVIEW_NOT_FOUND` (404) |

## Permissões
- **Permissão:** `LEGAL_REVIEW_VIEW` (fila, painel e resumo) com escopo que cubra o processo; `PROCESS_VIEW` para abrir o processo a partir do painel; `PROCESS_VIEW_CONFIDENTIAL_BUDGET` apenas para desmascarar a faixa de valor de orçamento sigiloso. Perfis com `LEGAL_REVIEW_VIEW`: `GESTOR_CONTRATACOES`, `JURIDICO`, `CONTROLE_INTERNO`, `AUTORIDADE_COMPETENTE` e `AUDITOR` (`permissions.md §3`).
- **Políticas:** DEC-024 (visibilidade), POL-09 (valor sigiloso), `permissions.md §5.3`.
- **MFA:** `LEGAL_REVIEW_VIEW` tem risco `L`: não exigido.
- **Sem permissão:** o item "Jurídico" do menu fica oculto; a API responde 403 `PERMISSION_DENIED` com auditoria `access.denied`; análise invisível ou de outro tenant responde 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `LegalReviewOpened` | `legal_review.opened` | Commit da tramitação que leva o processo a `JURIDICO` (sem análise aberta) | Payload `legalReviewId`, `sequence`, `processStageId`, `queuePriorityScore`, `enteredQueueAt`; consumidores T (timeline `LEGAL_REVIEW_OPENED`), N (notificação) e R (read model); sem valores monetários |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `LEGAL_REVIEW_QUEUED` | Titular e substituto da unidade jurídica da etapa | IN_APP; e-mail não é padrão; não obrigatória | Evento `LegalReviewOpened` (após o commit, via outbox) |

O texto leva o código e o objeto do processo e o link para o painel; nunca valor, faixa ou fatores. O recálculo da fila não notifica.

## Critérios de aceite em Gherkin
```gherkin
Feature: Abrir a análise jurídica e fila priorizada

  Background:
    Given que o tenant "Prefeitura A" está ativo e usa os critérios padrão da fila
    And a unidade "Assessoria Jurídica" tem titular "Dra. Helena Prado" e o procurador "Dr. André Nunes" com "LEGAL_REVIEW_VIEW"
    And "Carla Mendes", da "Secretaria de Obras", criou o processo "0045/2026", urgente e com valor estimado na faixa B4
    And o processo "0045/2026" está na etapa "MINUTA_EDITAL" e será encaminhado a "JURIDICO" com prazo em 2 dias

  Scenario: [Sucesso] Entrar em JURIDICO abre a análise com score e fatores
    When "Carla Mendes" encaminhar o processo "0045/2026" para a etapa "JURIDICO"
    Then deve existir uma "LegalReview" "PENDING" com "sequence" 1, "currentRound" 1 e "enteredQueueAt" preenchido
    And "queuePriorityScore" deve ser 82.3333 e "priorityFactors" deve listar prazo, urgência, faixa "B4" e entrada, sem nenhum valor monetário
    And deve gerar o evento "LegalReviewOpened" e a linha de timeline "Processo entrou na fila do Jurídico"
    And "Dra. Helena Prado" deve receber a notificação "LEGAL_REVIEW_QUEUED" sem valores no texto

  Scenario: [Sucesso] Fila ordenada pelo score com fatores visíveis
    Given que a análise "LR-0051" do processo "0051/2026" tem score 31.6667 e a "LR-0045" tem score 82.3333
    When "Dr. André Nunes" chamar "GET /legal-reviews"
    Then a API deve responder 200 com "LR-0045" na posição 1 e "LR-0051" na posição 2
    And cada item deve trazer "priorityFactors" com peso, direção e contribuição de cada fator

  Scenario: [Sucesso] Painel da análise e resumo da fila
    When "Dr. André Nunes" chamar "GET /legal-reviews/{id-LR-0045}" e "GET /legal-reviews/summary"
    Then o painel deve trazer processo, etapa, prazo, "currentRound" 1, fatores completos com "criteriaVersion" e "ETag"
    And o resumo deve trazer "unassigned" e "byAssignee" apenas com o que "Dr. André Nunes" pode ver

  Scenario: [Sucesso] Recalcular quando a urgência muda e voltar depois de análise concluída
    Given que o gestor altera a prioridade do processo "0051/2026" de "MEDIUM" para "URGENT"
    Then o score de "LR-0051" deve ser recalculado e o "version" da análise não deve mudar
    Given que "LR-0030" do processo "0030/2026" foi concluída e o processo volta a "JURIDICO"
    Then deve nascer a "LegalReview" com "sequence" 2 em "PENDING" e a anterior deve permanecer imutável

  Scenario: [Sucesso] Orçamento sigiloso mostra só a faixa a quem pode
    Given que o orçamento do processo "0045/2026" é sigiloso e "Dr. André Nunes" não tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    When "Dr. André Nunes" chamar "GET /legal-reviews" com "valueBand=B4"
    Then a API deve responder 200 sem a "LR-0045" e, no item sem filtro, "valueBand" nulo com "masked" verdadeiro
    And o evento, a notificação e os logs não devem conter valor nem faixa

  Scenario: [Validação] Filtros e cursor inválidos
    When "Dr. André Nunes" chamar "GET /legal-reviews?limit=500&valueBand=B9&cursor=xyz"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erros em "limit", "valueBand" e "cursor"

  Scenario: [Permissão] Sem acesso à fila e processo invisível
    Given que "Bruno Lopes" não tem "LEGAL_REVIEW_VIEW"
    When "Bruno Lopes" chamar "GET /legal-reviews"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar auditoria "access.denied"
    Given que o processo "0060/2026" não é visível a "Dr. André Nunes" pelo predicado de visibilidade
    When "Dr. André Nunes" listar a fila e chamar "GET /legal-reviews/{id-LR-0060}"
    Then a lista não deve conter "LR-0060" e o detalhe deve responder 404 com código "LEGAL_REVIEW_NOT_FOUND"

  Scenario: [Tenant incorreto] Análise de outro órgão
    Given que a análise "LR-0007" pertence ao tenant "Prefeitura B"
    When "Dr. André Nunes" chamar "GET /legal-reviews/{id-LR-0007}"
    Then a API deve responder 404 com código "LEGAL_REVIEW_NOT_FOUND"
    And a lista e o resumo não devem conter dados da "Prefeitura B"

  Scenario: [Duplicidade] Reentrega da tramitação e retorno com análise aberta
    Given que o evento "ProcessStageChanged" para "JURIDICO" é reentregue
    Then deve continuar existindo uma única "LegalReview" aberta e um único "LegalReviewOpened"
    Given que a análise "LR-0045" está em "DILIGENCE" e o processo volta a "JURIDICO"
    Then nenhuma nova "LegalReview" deve ser criada e a retomada deve ser acionada para a US-153

  Scenario: [Concorrência] Duas entradas simultâneas e recálculo durante a distribuição
    Given que duas transações tentam abrir a análise do processo "0045/2026" ao mesmo tempo
    Then exatamente uma "LegalReview" aberta deve existir, protegida pelo unique parcial
    Given que "Dra. Helena Prado" está distribuindo "LR-0045" com a "ETag" lida na tela
    When o recálculo da fila atualizar o score de "LR-0045" antes do envio
    Then a distribuição não deve receber "412 VERSION_CONFLICT" por causa do recálculo

  Scenario: [Falha de banco] Falha ao abrir a análise
    Given que o banco de dados fica indisponível durante a transação de encaminhamento a "JURIDICO"
    When "Carla Mendes" encaminhar o processo "0045/2026"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And o processo deve continuar na etapa anterior, sem "LegalReview", evento ou timeline

  Scenario: [Falha de integração] Cache de configuração e relay de notificações indisponíveis
    Given que o Redis está indisponível e o relay do outbox está parado
    When "Carla Mendes" encaminhar o processo "0045/2026" para "JURIDICO"
    Then a análise deve abrir lendo "legalReview.queueCriteria" direto do banco e registrar log "warn" "cache.unavailable"
    And o evento "LegalReviewOpened" deve ficar "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Filtro, ordenação, limite ou cursor inválido | 422 | `VALIDATION_ERROR` | "Revise os filtros escolhidos." | Marca os filtros; mantém a lista anterior |
| Referência inexistente (`assignee`, `secretariatId`) | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Selecione um responsável válido." | Limpa o filtro |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para ver a fila jurídica." | Oculta o menu; página de acesso negado |
| Análise inexistente, de outro tenant ou de processo invisível | 404 | `LEGAL_REVIEW_NOT_FOUND` | "Análise jurídica não encontrada." | Volta à fila |
| Excesso de requisições | 429 | `RATE_LIMITED` | "Muitas consultas seguidas. Aguarde alguns segundos." | Respeita `Retry-After` |
| Banco indisponível (consulta ou abertura) | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar a fila agora. Tente novamente em instantes." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-047 (encaminhar: origem do `ProcessStageChanged` que abre a análise); US-097 (autorização e predicado de visibilidade DEC-024); US-104 (catálogos: infraestrutura de `CatalogItem` e semeadura de tenant em que o catálogo `LEGAL_WAIVER_HYPOTHESIS` e a chave da fila são provisionados). Indiretas: US-150 (distribuição), US-151 (critérios), US-152 (iniciar), US-153 (retomada), US-129 (provedor `legalReview.*` do `RuleContext` v2), US-103 (registro de chaves do tenant, usado por `legalReview.queueCriteria`).
- **Decisões/ADRs:** DEC-024, DEC-030, DEC-031, DEC-032, DEC-196, DEC-199; POL-09, POL-19; RN-LGL-01 a RN-LGL-05.
- **Configurações:** `legalReview.queueCriteria` (lida; editada na US-151).
- **Lacunas nas fontes canônicas:**
  1. **Códigos de erro do módulo:** `LEGAL_REVIEW_NOT_FOUND` (404) não consta em `permissions.md` nem em `events.md`; a consolidar no `api.md` do MVP 2 (mesma lacuna da US-152).
  2. **LGL-09** (`GET /legal-reviews/summary`) não está nos endpoints indicativos da feature; a story o define para os contadores da fila e a carga por procurador (necessária à US-150). A consolidar no `api.md`.
  3. **Fórmula do score, horizonte de 30 dias, faixas de valor (`B1`..`B5`) e pesos padrão 40/30/20/10:** `entities.md §7.5` e o overview só dizem "nesta ordem" e "pesos de 0 a 100"; a story fixa esses números. **Dúvida de produto:** validar com a assessoria jurídica do piloto (horizonte, limites das faixas, pesos).
  4. **Formato de `priorityFactors`** (`total`, `factors[]` com entradas e contribuição, `criteriaVersion`, `calculatedAt`) e a coluna `priorityCalculatedAt` não constam de `entities.md §4.3`; a story os acrescenta (a confirmar com o card de migração M2-15).
  5. **Gatilho de mudança de prazo:** não há evento do MVP 1 ou 2 que diga "prazo da etapa mudou"; a story usa `process.status_changed.*`, `legal_review.resumed`, `sla_policy.changed` e o job diário, e depende de a US-191 (SLA) publicar o que mudar `dueAt`. **Dúvida de produto:** aceitar a defasagem de até um dia na parte de tempo do score.
  6. **Identificação da etapa jurídica pela chave `JURIDICO`:** tenants que renomearem a chave não abrem análise. **Dúvida de produto:** marcar a etapa jurídica por atributo (por exemplo, `isLegallyRequired` + `systemModule`) em vez de por chave.
  7. **Faixa de valor para quem não tem a permissão de sigilo:** a feature manda gravar a faixa; a story a mascara na resposta para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`. **Dúvida de produto:** a faixa é considerada informação sigilosa?
  8. **Sem ação de auditoria** para abertura ou recálculo em `events.md §7` (só `legal_review.assign`, `start`…); o rastro está em `priorityFactors`. O cancelamento da análise (`LegalReviewCanceled`) é da FT-074; aqui só aparece como situação filtrável.

## Impacto técnico
- **Atomicidade:** o listener roda na transação da tramitação; carga extra de um `INSERT` e três leituras por entrada em `JURIDICO`.
- **Imutabilidade:** análises finais não são recalculadas; o trigger de imutabilidade de análise concluída (US-155) deve permitir `UPDATE` de `queue_priority_score`/`priority_factors` apenas em `PENDING`/`IN_REVIEW`.
- **Desempenho:** a consulta usa o índice `(tenant_id, status, queue_priority_score DESC, entered_queue_at)` e o predicado de visibilidade; paginação por chave, sem `OFFSET`; resumo em uma consulta agregada.
- **Determinismo:** o calculador é função pura (entradas + critérios + instante) para poder ser reproduzido em auditoria.
- **Compatibilidade:** nenhum contrato do MVP 1 muda; `ProcessStageChanged`, `ProcessUpdated` e `ProcessStatusChanged` são apenas consumidos.
- **Sigilo:** valores nunca saem do `ProcessFacade`; o calculador recebe a faixa e o `isBudgetConfidential`, não o valor.

## Backend
- **Módulo(s):** `legal-review` (dono), `process` (`ProcessFacade`: prioridade, valor→faixa, prazo da etapa, status), `workflow` (chave da etapa), `organization` (`OrgUnitFacade.getTitularAndDeputy`), `access` (predicado de visibilidade e escopo), `timeline`, `notification`, `audit`, `platform` (outbox, jobs).
- **Casos de uso:** `OpenLegalReviewOnStageEntry` (`StageLifecycleListener`), `LegalQueueRescoreHandler`, `RescoreLegalQueueJob`, `ListLegalReviewsQuery` (LGL-01), `GetLegalReviewQuery` (LGL-02), `GetLegalQueueSummaryQuery` (LGL-09).
- **Domínio:** `LegalReview.open(...)`, `LegalQueueScoreCalculator` (puro), `ValueBand`, `LegalQueueCriteria` (schema da `§7.5`).
- **Integrações internas:** `ProcessFacade`, `SettingsFacade.getLegalQueueCriteria`, `OrgUnitFacade`, `AccessFacade.buildVisibilityPredicate`, `OutboxWriter`, `TimelineProjector`.
- **Transação:** abertura = criação da análise, score, timeline e outbox na transação da tramitação; recálculo = uma transação curta por análise (`UPDATE ... WHERE status IN ('PENDING','IN_REVIEW')`).

## Frontend
- **Tela(s):** SCR-019 (`/juridico`, fila; `/juridico/[reviewId]`, painel), SCR-006 (aba Resumo e timeline mostram a entrada na fila).
- **Componentes:** `LegalQueueTable` (posição, selos de prazo e urgência), `QueueFilters` (FilterPanel aberto, chips só dos filtros extras), `PriorityFactorsPopover` ("Por que esta ordem?"), `QueueSummaryBar`, `LegalReviewPanel` (cabeçalho e fatores), `ReviewStatusBadge`.
- **Estados:** skeleton; vazio com "Limpar filtros"; erro com "Tentar novamente"; faixa restrita como "Faixa restrita"; aviso "Prioridade recalculada em {hora}".
- **Acessibilidade e responsividade:** ordem e prazo vencido nunca só por cor (texto e ícone); tabela com cabeçalhos associados e `aria-sort`; popover de fatores navegável por teclado; abaixo de 768 px a tabela vira lista de cartões; contraste AA.

## Banco de dados
- **Tabelas:** `legal_reviews` (inserção na abertura; escrita de `queue_priority_score`, `priority_factors`, `priority_calculated_at` no recálculo), leitura de `processes`, `process_stages`, `departments`, `users`, `tenant_settings`.
- **Migrações:** nenhuma nova além de M2-15 (cria `legal_reviews`); a coluna `priority_calculated_at` entra em M2-15 (a confirmar com o card de migração).
- **Índices/constraints relevantes:** unique `(tenant_id, process_id, sequence)`; unique parcial de uma análise aberta por processo; unique `(tenant_id, process_stage_id)` para a idempotência da abertura; índice da fila `(tenant_id, status, queue_priority_score DESC, entered_queue_at)`; `(tenant_id, assignee_id) WHERE status IN ('PENDING','IN_REVIEW')`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `LGL-01` | GET | `/api/v1/legal-reviews` | `status[]?`, `assignee?`, `dueFrom?`, `dueTo?`, `valueBand[]?`, `priority[]?`, `secretariatId?`, `q?`, `sort?`, `cursor?`, `limit?` | `200 { data: [ { id, processId, processCode, processObject, secretariat, status, sequence, assignee?, enteredQueueAt, stageDueAt?, valueBand?, masked, priority, queuePriorityScore, priorityFactors (resumo), version } ], meta: { nextCursor, hasMore } }` | 200, 401, 403, 422, 429, 503 |
| `LGL-02` | GET | `/api/v1/legal-reviews/{id}` | — | `200 { data: LegalReview + process + priorityFactors completos + currentRound }` + `ETag` | 200, 401, 403, 404, 429, 503 |
| `LGL-09` | GET | `/api/v1/legal-reviews/summary` | — | `200 { data: { counts, unassigned, overdue, mine, byAssignee[] } }` | 200, 401, 403, 429, 503 |

## Logs
- `info` `legal_review.opened` — `legalReviewId`, `processId`, `sequence`, `queuePriorityScore`, `durationMs`, `correlationId`.
- `info` `legal_review.priority_recalculated` — `legalReviewId`, `reason` (`PRIORITY`, `VALUE`, `DUE`, `CRITERIA`, `DAILY`), `scoreFrom`, `scoreTo`.
- `warn` `legal_review.queued_without_recipient`, `cache.unavailable`.
- `error` `legal_review.open_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** valor estimado, faixa de valor de processo sigiloso, objeto do processo nem texto de documentos.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `access.denied` | `ACCESS` | 403 em LGL-01, LGL-02 ou LGL-09 | `reasonCode = LEGAL_REVIEW_VIEW` |

A abertura e o recálculo não geram `AuditLog` próprio: a abertura é efeito da tramitação (movimentação e auditoria do encaminhamento) e o rastro da ordem está em `priorityFactors` (RN-LGL-34).

## Testes necessários
- **Unitários:** calculador (cada fator, direção `ASC`/`DESC`, fator sem dado, fronteiras de 30 dias e das faixas, arredondamento, determinismo), seleção da faixa sem expor valor, decisão abrir x retomar x nova análise, parsing de filtros e cursor.
- **Integração (Testcontainers):** abertura na transação da tramitação e rollback total na falha; uniques sob concorrência; recálculo sem mexer em `version`; reação a `process.updated`, suspensão/retomada e mudança de critérios; job diário; consulta com visibilidade e escopo (SQL único).
- **API/contrato:** LGL-01/02/09 (filtros, cursor, `ETag`, `masked`); `LegalReviewOpened` e timeline `LEGAL_REVIEW_OPENED` conforme `events.md`.
- **RBAC e multi-tenant:** suíte "tenant leak" com LGL-01/02/09; matriz de autorização (gerada) com `LEGAL_REVIEW_VIEW`; teste de sigilo (nenhum valor em `priorityFactors`, eventos, notificação e logs; filtro `valueBand` sem inferência).
- **Concorrência:** duas aberturas simultâneas (uma efetiva); recálculo x distribuição/início (sem 412 espúrio).
- **E2E (Playwright):** encaminhar a `JURIDICO`, ver a análise no topo da fila com "Por que esta ordem?", filtrar, abrir o painel.
- **Acessibilidade/performance:** axe em fila, popover e painel; 360 px; metas de p95 (500 análises) na suíte de performance.

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
- [ ] Abertura atômica com a tramitação e uma única análise aberta por processo comprovadas por teste de concorrência
- [ ] Teste de sigilo: nenhum valor de orçamento sigiloso em `priorityFactors`, eventos, notificações ou logs
- [ ] Gherkin das 8 categorias automatizado

## Estimativa
**L** — abertura transacional acoplada à tramitação, calculador determinístico com recálculo incremental e job, três consultas com visibilidade e sigilo, e a fila/painel da SCR-019; o esforço está na atomicidade com `ProcessStageChanged`, no recálculo sem invalidar a ETag e nos testes de sigilo.

## Prioridade
**P0** — sem a abertura e a fila não há análise jurídica no produto; bloqueia US-150, US-151, US-152 e US-156.

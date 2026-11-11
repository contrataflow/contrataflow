---
id: US-173
title: "Relatório detalhado com detalhamento por processo"
epic: EP-028
feature: FT-081
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-172]
modules: [analytics, access, organization, catalog, workflow, identity, audit, platform]
screens: [SCR-028]
endpoints: [ANL-09, ANL-10]
permissions: [REPORT_VIEW, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: []
---

# US-173 — Relatório detalhado com detalhamento por processo

## Título
Abrir, a partir de qualquer número de um relatório, a lista dos processos por trás dele e o detalhe analítico de cada um, respeitando a visibilidade e o sigilo

## Descrição
**Como** gestor de contratações, controlador interno ou auditor, **quero** clicar num número do relatório (por exemplo, "6 devoluções da Saúde em abril") e ver quais processos o compõem, com seus marcos, tempos e atrasos, e abrir o detalhe de cada um, **para** entender a causa do número e agir sobre o processo, sabendo que só vejo o que eu veria em Processos e que valores sigilosos continuam protegidos.

A story entrega a tela **SCR-028** (`/relatorios/[relatorio]`) na parte de detalhamento por processo: a lista de processos do recorte (ANL-09), com ordenação, busca por número e paginação por cursor, e o detalhe analítico de um processo (ANL-10), com as passagens de etapa, os marcos e os indicadores, lidos **só** do read model. Aplica sempre o predicado de visibilidade da DEC-024 sobre os fatos, mesmo com escopo `TENANT` em `REPORT_VIEW`, mascara valores sigilosos por linha e audita o acesso (`report.view_detail`, uma vez por sessão e relatório). As definições dos indicadores e o recorte por filtros são da US-172; a exportação do mesmo detalhamento é da US-174; as abas de gargalos de SCR-028 são das US-176 e US-177.

## Contexto
- O agregado de SCR-027 (US-172) é recortado pelo escopo de `REPORT_VIEW`; o detalhamento é mais restrito: aplica o predicado de visibilidade da DEC-024 sobre os fatos, de modo que a pessoa só lista processos que veria em Processos (RN-ANL-12, permissions.md §5.2, POL-28). Quem tem `REPORT_VIEW` com escopo `TENANT`, mas só vê alguns processos, recebe números agregados do tenant e uma lista menor, com aviso do que ficou de fora.
- O detalhamento é uma superfície de acesso a dados de processo por outro caminho que não o módulo de Processos; por isso o acesso é auditado (RN-ANL-14, DEC-206) e o resultado nunca traz mais do que o processo traria (sem título, objeto, texto livre ou documento).
- O sigilo por linha segue a POL-09 estendida (POL-28): o valor de processo sigiloso sai `null` com `masked: true` para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo nem detém a custódia atual, como na lista de Processos (US-002, US-013). Diferente do agregado, a linha respeita também a custódia; por isso esta tela **não soma valores** (sem totais monetários), para não permitir dedução pela diferença com o relatório.
- Os fatos (`AnalyticsProcessFact`, `AnalyticsStageFact`) não têm título nem objeto do processo e não são alterados por esta story; a leitura passa pelo repositório do `analytics` (funções `security definer` e consultas sobre fatos, com RLS) e a visibilidade usa o predicado publicado pelo módulo `access` sobre `process_access` (DEC-024), sem tocar `ProcessStage` nem `ProcessMovement` (RN-ANL-19).
- A tela SCR-028 é compartilhada com os gargalos (US-176 e US-177): esta story cria a rota e a aba "Processos"; as outras abas se registram pelo `ReportRegistry` da US-172.
- A cada número do relatório corresponde um conjunto de processos; um teste de paridade garante que o total do detalhamento (sem considerar a visibilidade) é igual ao número clicado (RN-ANL-96).

## Objetivo
Garantir que 100% dos números de SCR-027 tenham detalhamento por processo com o mesmo recorte, que nenhum processo invisível à pessoa seja listado ou revelado, que nenhum valor sigiloso saia mascarado de forma errada, que 100% dos acessos ao detalhamento sejam auditados uma vez por sessão e relatório, e que a primeira página responda em até 1,5 s (p95, meta proposta na suíte de performance).

## Persona
- **Principal:** Gestor de contratações (`GESTOR_CONTRATACOES`) com `REPORT_VIEW`.
- **Secundárias:** Controle Interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`) — investigam o processo por trás do número, por padrão com `PROCESS_VIEW_CONFIDENTIAL_BUDGET`; Autoridade competente (`AUTORIDADE_COMPETENTE`).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`; sessão com identificador (usado na auditoria por sessão, RN-ANL-93).
- `REPORT_VIEW` cobrindo ao menos uma secretaria solicitante (US-172, RN-ANL-79). A visibilidade dos processos vem de `PROCESS_VIEW` e das concessões de `ProcessAccess` (DEC-024); sem nenhum processo visível, a lista vem vazia.
- Read model inicializado para o tenant (US-171); caso contrário, 409 `ANALYTICS_NOT_READY` (US-172, RN-ANL-83).
- Relatório do catálogo da pessoa (US-172, RN-ANL-70).

## Fluxo principal
1. No relatório (SCR-027), o gestor aciona **"Ver processos"** num número, numa barra do gráfico ou numa linha da tabela. O front navega para `/relatorios/devolucoes?fiscalYear=2026&periodKey=2026-04&secretariatId=<id>&metric=returns`, levando os filtros do recorte e o que foi clicado.
2. SCR-028 abre com o título do relatório, os filtros do recorte em chips, "Dados atualizados em 11/11/2026 14:05" e a descrição do número ("6 devoluções · Saúde · abril de 2026").
3. O front chama `GET /api/v1/reports/{report}/processes` (ANL-09) com os filtros, `periodKey`, `metric`, `sort`, `q` e `cursor`.
4. A API valida os parâmetros; resolve o escopo de `REPORT_VIEW` (RN-ANL-79) e o predicado de visibilidade (DEC-024); consulta os fatos aplicando os dois; mascara o valor de cada linha (RN-ANL-92); calcula `matchedTotal`, `visibleTotal` e `hiddenCount`; e, se for o primeiro acesso da sessão a este relatório, grava a auditoria `report.view_detail` (RN-ANL-93).
5. A tela mostra a tabela: processo (número, com link), secretaria, modalidade, situação, etapa atual, abertura, conclusão, tempo de ciclo em dias úteis, devoluções, etapas atrasadas, valor estimado ou "Sigiloso", e a coluna "No número" (quanto aquele processo contribui: "2 devoluções").
6. Se `hiddenCount > 0`, a tela avisa: "Este número inclui {hiddenCount} processo(s) que você não tem permissão para abrir em Processos. A lista mostra os {visibleCount} que você pode ver."
7. O gestor ordena colunas, busca pelo número do processo e pagina (cursor); trocar a ordenação ou a busca não repete a auditoria da sessão.
8. Ao escolher um processo, abre-se o painel lateral "Detalhe do processo": o front chama `GET /api/v1/reports/detail/{processId}` (ANL-10), que devolve os marcos, as passagens de etapa (unidade, responsável, entrada, saída, dias úteis e corridos, pausa, prazo, atraso, devolução) e os indicadores; a primeira abertura do processo na sessão grava `report.view_detail` com o `processId`.
9. O painel traz "Abrir processo" (SCR-006), onde estão título, objeto, documentos e a tramitação completa, que são a fonte da verdade.
10. O gestor volta ao relatório pelo caminho de navegação ("Relatórios > Devoluções"), mantendo os filtros.

## Fluxos alternativos
- **FA-01 — Nenhum processo visível:** a lista vem vazia com `hiddenCount` igual ao total do número; a tela mostra "Você não tem permissão para abrir nenhum dos processos deste número." (RN-ANL-91).
- **FA-02 — Escopo sem cobertura:** `REPORT_VIEW` não cobre nenhuma secretaria (US-172, RN-ANL-79); lista vazia, `hiddenCount` 0 e a orientação de pedir ajuste de acesso.
- **FA-03 — Valor sigiloso na linha:** a coluna mostra "Sigiloso" com ícone de cadeado e o texto acessível "Valor sigiloso (art. 24 da Lei 14.133/2021)"; quem tem a permissão ou a custódia vê o valor (RN-ANL-92).
- **FA-04 — Ordenar por valor:** linhas com valor mascarado ou ausente vão para o fim, em qualquer sentido, sem revelar a ordem entre elas (RN-ANL-94).
- **FA-05 — Busca por número:** `q` com `0012/2026` ou `0012` filtra por prefixo do número; outro texto é recusado (RN-ANL-94).
- **FA-06 — Dados atrasados:** `meta.stale = true` (US-172, RN-ANL-82) mostra a faixa "Os dados mostram a situação de {dataAsOf}. A atualização está atrasada."
- **FA-07 — Passagens abertas vencidas:** `metric = open-overdue` lista processos com passagem aberta já vencida; a coluna "No número" mostra quantas (RN-ANL-95).
- **FA-08 — Processo sem fato ou não visível no painel:** ANL-10 responde 404 `PROCESS_NOT_FOUND` e o painel mostra "Processo não encontrado ou sem permissão de acesso." (RN-ANL-98).
- **FA-09 — Visibilidade perdida durante a sessão:** o processo deixou de ser visível (a pessoa perdeu a concessão); a lista seguinte já não o traz e o painel aberto recebe 404 ao recarregar.
- **FA-10 — Parâmetro de link adulterado:** `metric`, `periodKey` ou `sort` inválido responde 422 e a tela volta ao relatório com os filtros padrão.
- **FA-11 — Primeira auditoria e Redis fora:** sem o controle de "uma vez por sessão", cada acesso é auditado (falha segura, RN-ANL-93).
- **FA-12 — Indicadores ainda sendo preparados:** 409 `ANALYTICS_NOT_READY`, como no relatório (US-172, FA-02).

## Regras de negócio
- **RN-ANL-06** — Os relatórios nunca consultam `ProcessStage`/`ProcessMovement` diretamente em produção; só o read model (DEC-206). *(regra da feature, adotada)*
- **RN-ANL-11** — Os agregados são recortados pelo escopo de `REPORT_VIEW`; `DEPARTMENT` e `OWN_DEPARTMENTS` veem processos da secretaria solicitante no escopo (DEC-206, permissions.md §5.2). *(regra da feature, adotada)*
- **RN-ANL-12** — O detalhamento por processo aplica o predicado de visibilidade da DEC-024 sobre os fatos, mesmo com escopo `TENANT`: só lista o que a pessoa veria em Processos (DEC-206, POL-28). *(regra da feature, adotada)*
- **RN-ANL-13** — Processos com orçamento sigiloso ficam fora das somas de quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` sobre eles; o mascaramento é por linha antes de agregar (DEC-030, POL-28). *(regra da feature, adotada)*
- **RN-ANL-14** — Abrir o detalhamento por processo é auditado (`report.view_detail`, uma vez por sessão e relatório) (DEC-206). *(regra da feature, adotada)*
- **RN-ANL-19** — Nenhum relatório consulta `ProcessStage`/`ProcessMovement` em produção; só o read model (DEC-206). *(regra da feature, adotada)*
- **RN-ANL-90** — O detalhamento lista os **processos por trás de um número**: recebe o mesmo recorte de ANL-06 (US-172: `granularity`, `fiscalYear` ou `from`/`to`, `secretariatId[]`, `modalityCode[]`, `contractingTypeCode[]`), mais `periodKey` (o período clicado), `stageKey` (quando o número é por etapa) e `metric` (o que foi clicado). `metric` aceito por relatório: `cycle-time` → `completed`, `in-progress`; `returns` → `returns`; `deadline-compliance` → `overdue`, `on-time`, `no-due`, `open-overdue`; `volume-value` → `opened`, `completed`, `canceled`, `in-progress`. Combinação inválida responde 422.
- **RN-ANL-91** — Visibilidade: o predicado da DEC-024 (`buildVisibilityPredicate`, publicado por `access` sobre `process_access`) é aplicado em SQL sobre os fatos, **além** do escopo de `REPORT_VIEW` (RN-ANL-79) e dos filtros. Processo não visível nunca é listado, não conta em `visibleTotal`, não aparece em busca, ordenação ou cursor e não tem detalhe (404). Acesso histórico de unidades (`access.historicalDepartmentsCanView`) vale como no módulo de Processos.
- **RN-ANL-92** — Sigilo por linha: para processo com `isBudgetConfidential`, `estimatedValue` sai `null` com `valueMasked = true` salvo se o usuário tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo ou detém a custódia atual (POL-09, POL-28, regra de `ConfidentialFieldsInterceptor`). Nenhum total monetário é calculado nesta tela; marcos, contagens e durações não são sigilosos.
- **RN-ANL-93** — Auditoria `report.view_detail` (categoria `ACCESS`): ANL-09 grava **uma vez por sessão e relatório** (chave `(sessionId, report)`); ANL-10 grava **uma vez por sessão e processo** (chave `(sessionId, processId)`), com `metadata.report`. O controle usa uma chave Redis com validade igual à da sessão (`SET NX`); sem Redis, audita todo acesso (falha segura). A gravação é síncrona e obrigatória: se a auditoria falhar, a requisição falha com 503 e nenhum dado é devolvido.
- **RN-ANL-94** — Ordenação e paginação: `sort` aceita `code`, `openedAt`, `completedAt`, `cycleTimeBusinessDays`, `returnsCount`, `overdueStagesCount`, `estimatedValue` e `matched`, com `-` para decrescente; padrão por relatório: `cycle-time` → `-cycleTimeBusinessDays`; `returns` e `deadline-compliance` → `-matched`; `volume-value` → `-openedAt`; desempate por `processId`. Na ordenação por valor, linha com valor mascarado ou ausente tem chave `null` e vai ao fim. Paginação por cursor opaco, assinado e preso a tenant e usuário; `limit` de 1 a 100 (padrão 25). `q` aceita de 1 a 40 caracteres entre dígitos, `/` e `-` e filtra por prefixo do número. `meta.totalItems` é exato até 10.000 e, acima, vale 10.000 com `totalItemsCapped = true`.
- **RN-ANL-95** — `matched` é a contribuição do processo ao número clicado: 1 nas métricas de processo (`opened`, `completed`, `canceled`, `in-progress`, `completed` do ciclo) e a quantidade de passagens que contribuem nas métricas de passagem (`returns`, `overdue`, `on-time`, `no-due`, `open-overdue`), respeitando o período e a etapa clicados. A lista só traz processos com `matched ≥ 1`.
- **RN-ANL-96** — Paridade: `meta.matchedTotal` é a soma de `matched` de **todos** os processos do recorte dentro do escopo de `REPORT_VIEW`, antes do predicado de visibilidade, e é igual ao número de ANL-06 para o mesmo recorte; `meta.visibleTotal` é a soma só dos visíveis; `meta.hiddenCount` é o número de processos do recorte que a pessoa não pode ver. Teste de paridade obrigatório por relatório e métrica.
- **RN-ANL-97** — Fonte única: as linhas e o detalhe vêm de `AnalyticsProcessFact`, `AnalyticsStageFact` e `AnalyticsPcaItemFact`; rótulos de secretaria, modalidade, tipo, etapa e nomes de responsáveis vêm de consultas de apoio dos módulos donos (`organization`, `catalog`, `workflow`, `identity`); item removido aparece como "Item removido". Nenhuma leitura de `ProcessStage`, `ProcessMovement` nem de dados do processo além do read model e do predicado de visibilidade.
- **RN-ANL-98** — ANL-10: devolve marcos, passagens e indicadores do processo, na ordem de `enteredAt`; processo inexistente, de outro tenant, sem fato ou **não visível** responde 404 `PROCESS_NOT_FOUND` de forma idêntica (DEC-024). Passagens trazem unidade e responsável (nome apenas) e nenhum comentário, documento ou texto livre.
- **RN-ANL-99** — Frescor: cada linha e o detalhe trazem `projectedAt` do fato; `meta.dataAsOf` e `meta.stale` seguem a US-172 (RN-ANL-82). A fonte da verdade do processo é SCR-006, para onde o painel aponta.
- **RN-ANL-100** — Minimização: título, objeto, descrição, comentários, CPF e e-mail não existem nos fatos e não são devolvidos; o responsável é identificado só pelo nome exibido. Dados pessoais não entram em log nem em `metadata` de auditoria.
- **RN-ANL-101** — A consulta do detalhamento é uma função única (`ReportDetailQuery`) reutilizada pela exportação (US-174), com o mesmo recorte, a mesma visibilidade e o mesmo sigilo; a paridade tela × exportação é testada lá.
- **RN-ANL-102** — Parâmetros: todo estado de SCR-028 está na URL; `periodKey` aceita `AAAA-MM` (mês), `AAAA-Tn` (trimestre do exercício, `n` de 1 a 4) e `FYAAAA` (exercício) e deve ser coerente com `granularity`; valores fora disso respondem 422.
- **RN-ANL-103** — Limite de uso: 60 requisições por minuto por usuário em ANL-09 e ANL-10; acima, 429 `RATE_LIMITED` com `Retry-After` (proposta, lacuna 3).
- **RN-ANL-104** — Sessão: `sessionId` é o identificador da sessão do BFF; é guardado só como *hash* na auditoria e na chave Redis.
- **RN-ANL-105** — Escopo sem cobertura ou sem processo visível responde 200 com lista vazia, nunca 403 (a existência de processos fora da visibilidade só é revelada pela contagem `hiddenCount`).
- **RN-ANL-106** — Consistência de leitura: cada página é uma única consulta `READ ONLY`; entre páginas, o projetor pode alterar fatos, e o cursor por chave de ordenação evita repetir linha, aceitando que uma linha mude de página.
- **RN-ANL-107** — `metadata` da auditoria: `report`, `metric`, `periodKey`, `filtersHash` (hash dos filtros, nunca os ids), `rowsReturned`, `processId` (só em ANL-10) e `sessionHash`.
- **RN-ANL-108** — Rótulos e formatos como na US-172 (RN-ANL-75 e RN-ANL-89): dias úteis, dinheiro em texto com 2 casas, `label` pronto, nenhum valor técnico de enum.
- **RN-ANL-109** — A rota `/relatorios/[relatorio]` é um contêiner de abas registradas pelo `ReportRegistry`; esta story entrega a aba "Processos" para os quatro relatórios da US-172, e as US-176 e US-177 acrescentam as suas sem alterar o contrato de ANL-09 e ANL-10.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Relatório | `report` (path) | texto | Sim | Catálogo da pessoa (US-172) | rota |
| Filtros do recorte | `granularity`, `fiscalYear` ou `from`/`to`, `secretariatId[]`, `modalityCode[]`, `contractingTypeCode[]` | como em ANL-06 | Não | RN-ANL-90 | URL do relatório |
| Período clicado | `periodKey` | texto | Não | `AAAA-MM`, `AAAA-Tn`, `FYAAAA` (RN-ANL-102) | número clicado |
| Etapa clicada | `stageKey` | texto | Não | Só quando o número é por etapa | número clicado |
| O que foi clicado | `metric` | enum | Sim | RN-ANL-90 | número clicado |
| Busca | `q` | texto (1–40) | Não | Dígitos, `/`, `-` (RN-ANL-94) | — |
| Ordenação | `sort` | texto | Não | RN-ANL-94 | padrão do relatório |
| Paginação | `cursor`, `limit` | texto, inteiro | Não | `limit` 1–100, padrão 25 | servidor |
| Processo (detalhe) | `processId` (path de ANL-10) | uuid | Sim | Visível à pessoa (RN-ANL-91) | linha clicada |
| *(saída)* Linha | `processId`, `code`, `secretariat`, `modality`, `contractingType`, `status`, `currentStages[]`, `openedAt`, `completedAt`, `canceledAt`, `cycleTimeBusinessDays`, `returnsCount`, `overdueStagesCount`, `estimatedValue`, `valueMasked`, `pcaItemCode`, `matched`, `projectedAt` | objeto | — | RN-ANL-92, RN-ANL-95, RN-ANL-97 | read model |
| *(saída)* Totais | `meta.matchedTotal`, `meta.visibleTotal`, `meta.hiddenCount`, `meta.totalItems`, `meta.totalItemsCapped` | inteiros, boolean | — | RN-ANL-94, RN-ANL-96 | servidor |
| *(saída)* Atualização | `meta.dataAsOf`, `meta.lagSeconds`, `meta.stale` | timestamptz, inteiro, boolean | — | US-172, RN-ANL-82 | servidor |
| *(saída)* Marcos | `milestones { openedAt, dfdApprovedAt, planningCompletedAt, legalConcludedAt, legalOutcome, internalControlOutcome, completedAt, canceledAt }` | objeto | — | RN-ANL-98 | `AnalyticsProcessFact` |
| *(saída)* Passagens | `stages[] { processStageId, stageKey, stageLabel, stageType, branchKey, department, assignee, enteredAt, exitedAt, exitStatus, durationBusinessDays, durationCalendarDays, pausedSeconds, dueAt, wasOverdue, overdueBusinessDays, returnedFrom, escalationLevelReached }` | lista | — | RN-ANL-98 | `AnalyticsStageFact` |
| *(saída)* Indicadores | `indicators { cycleTimeBusinessDays, returnsCount, overdueStagesCount, migrationsCount }` | objeto | — | — | `AnalyticsProcessFact` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `metric` ausente ou não aceito pelo relatório | Front + API (Zod) | "Escolha um número do relatório para ver os processos." | `VALIDATION_ERROR` |
| V-02 | `periodKey` incoerente com a granularidade ou em formato inválido | API | "O período informado é inválido. Volte ao relatório e escolha de novo." | `VALIDATION_ERROR` |
| V-03 | `sort` fora da lista aceita | API | "Ordenação inválida." | `VALIDATION_ERROR` |
| V-04 | `limit` fora de 1 a 100 | API | "Filtro inválido." | `VALIDATION_ERROR` |
| V-05 | `q` fora do formato (1 a 40 caracteres entre dígitos, `/` e `-`) | Front + API | "Digite apenas o número do processo, como 0012/2026." | `VALIDATION_ERROR` |
| V-06 | `cursor` adulterado, expirado ou de outro usuário ou tenant | API | "A lista foi atualizada. Volte ao início." | `VALIDATION_ERROR` |
| V-07 | Filtros de recorte inválidos (como em ANL-06) | API | "Alguns filtros são inválidos. Revise a consulta." | `VALIDATION_ERROR` |
| V-08 | Relatório inexistente ou fora do catálogo da pessoa | API | "Relatório não encontrado." | `REPORT_NOT_FOUND` (404) |
| V-09 | Processo inexistente, de outro tenant, sem fato ou não visível (ANL-10) | API | "Processo não encontrado ou sem permissão de acesso." | `PROCESS_NOT_FOUND` (404) |
| V-10 | `processId` que não é UUID | API | "Processo não encontrado ou sem permissão de acesso." | `PROCESS_NOT_FOUND` (404) |
| V-11 | Tenant sem carga inicial do read model | API | "Os indicadores do órgão ainda estão sendo preparados. Tente novamente mais tarde." | `ANALYTICS_NOT_READY` (409) |

## Permissões
- **Permissão:** `REPORT_VIEW` com escopo que cubra ao menos uma secretaria solicitante (ANL-09 e ANL-10); a visibilidade dos processos vem de `PROCESS_VIEW` e das concessões de `ProcessAccess` (DEC-024), aplicada sempre; `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (risco `H`) ou a custódia atual para ver valor sigiloso na linha.
- **Políticas:** POL-28 (relatórios e sigilo: o detalhamento aplica DEC-024 e POL-09 por linha), POL-09 (orçamento sigiloso), DEC-024 (visibilidade de processos), DEC-025 (auditoria de acesso).
- **MFA:** `REPORT_VIEW` é risco `L`; não exige MFA. O desmascaramento de valor segue a exceção da POL-14: sem MFA onde exigido, o valor sai mascarado, sem 403, com `meta.confidentialStepUpAvailable = true`.
- **Sem permissão:** o link "Ver processos" e o menu "Relatórios" ficam ocultos sem `REPORT_VIEW`; a API responde 403 `PERMISSION_DENIED` e grava `access.denied`; processo de outro tenant ou invisível responde 404 `PROCESS_NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Leitura: nenhum evento de domínio. A auditoria `report.view_detail` é gravada pelo `AuditService`, na mesma requisição. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Relatório detalhado com detalhamento por processo

  Background:
    Given que o tenant "Prefeitura A" está ativo com o read model inicializado
    And a secretaria "Saúde" tem os processos "0012/2026", "0013/2026" e "0014/2026", este último com orçamento sigiloso de "1200000.00"
    And a secretaria "Obras" tem o processo "0020/2026"
    And "Gil" tem "REPORT_VIEW" com escopo "DEPARTMENT" da "Saúde" e "PROCESS_VIEW" da "Saúde", sem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    And "Rita" tem "REPORT_VIEW", "PROCESS_VIEW" e "PROCESS_VIEW_CONFIDENTIAL_BUDGET" com escopo "TENANT"
    And "Ana" tem "REPORT_VIEW" com escopo "TENANT" e "PROCESS_VIEW" só da unidade "Compras", sem concessão sobre os processos da "Saúde" e de "Obras"
    And em abril de 2026 a "Saúde" teve 6 devoluções: 3 no "0012/2026", 2 no "0013/2026" e 1 no "0014/2026"

  Scenario: [Sucesso] Do número aos processos
    When "Gil" chamar "GET /reports/returns/processes" com "fiscalYear" 2026, "periodKey" "2026-04", "secretariatId" da "Saúde" e "metric" "returns"
    Then a API deve responder 200 com os processos "0012/2026", "0013/2026" e "0014/2026"
    And "matched" deve ser 3, 2 e 1 respectivamente
    And "meta.matchedTotal" deve ser 6, igual ao número de "GET /reports/returns" para o mesmo recorte
    And "meta.visibleTotal" deve ser 6 e "meta.hiddenCount" 0
    And "meta.dataAsOf" deve estar presente

  Scenario: [Sucesso] Visibilidade da DEC-024 mesmo com escopo do tenant
    When "Ana" abrir "GET /reports/returns" para o recorte do tenant em abril
    Then o número agregado deve incluir as 6 devoluções da "Saúde"
    When "Ana" chamar "GET /reports/returns/processes" para o mesmo recorte
    Then a API deve responder 200 com lista vazia, "meta.matchedTotal" igual a 6 e "meta.hiddenCount" igual a 3
    And a tela deve avisar que o número inclui 3 processos que ela não tem permissão para abrir em Processos

  Scenario: [Sucesso] Valor sigiloso mascarado por linha
    When "Gil" listar os processos de "volume-value" aberto em abril na "Saúde"
    Then a linha do "0014/2026" deve ter "estimatedValue" nulo e "valueMasked" verdadeiro
    And as linhas dos outros processos devem trazer o valor
    And nenhuma resposta deve conter total monetário
    When "Rita" listar os mesmos processos
    Then a linha do "0014/2026" deve trazer "1200000.00" e "valueMasked" falso

  Scenario: [Sucesso] Custódia atual vê o valor na linha
    Given que "Paulo" não tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET" mas está com a custódia atual do "0014/2026"
    When "Paulo" listar os processos de "volume-value" da "Saúde"
    Then a linha do "0014/2026" deve trazer o valor
    And o agregado de "GET /reports/volume-value" para "Paulo" não deve incluir esse valor nas somas

  Scenario: [Sucesso] Ordenar por valor não revela a ordem dos sigilosos
    When "Gil" listar os processos da "Saúde" com "sort" "-estimatedValue"
    Then as linhas com valor mascarado devem vir ao fim
    And a ordem entre as linhas mascaradas deve ser por "processId", nunca por valor

  Scenario: [Sucesso] Auditoria uma vez por sessão e relatório
    When "Gil" abrir a primeira página, a segunda e uma nova ordenação do detalhamento de "returns" na mesma sessão
    Then deve existir uma única auditoria "report.view_detail" com "metadata.report" "returns", "filtersHash" e "rowsReturned", sem ids nem valores
    When "Gil" abrir o detalhamento de "deadline-compliance" na mesma sessão
    Then deve existir uma segunda auditoria "report.view_detail"
    When "Gil" abrir o detalhamento de "returns" em outra sessão
    Then deve existir uma terceira auditoria "report.view_detail"

  Scenario: [Sucesso] Detalhe analítico do processo
    When "Gil" chamar "GET /reports/detail/{id-do-0012/2026}"
    Then a API deve responder 200 com os marcos, as passagens em ordem de entrada e os indicadores
    And cada passagem deve ter unidade, nome do responsável, entrada, saída, "durationBusinessDays", "pausedSeconds", "dueAt", "wasOverdue" e "returnedFrom"
    And a resposta não deve conter título, objeto, comentários nem documentos
    And deve gerar a auditoria "report.view_detail" com o "processId"

  Scenario: [Sucesso] Busca, ordenação e paginação por cursor
    Given que há 60 processos no recorte
    When "Gil" listar com "limit" 25 e "sort" "-cycleTimeBusinessDays"
    Then a API deve responder 200 com 25 linhas e "meta.nextCursor"
    When "Gil" repetir com o cursor
    Then a segunda página não deve repetir linhas da primeira
    When "Gil" buscar "q" "0012"
    Then só devem constar processos cujo número começa com "0012"

  Scenario: [Sucesso] Passagens abertas vencidas
    Given que o "0013/2026" tem 2 passagens abertas já vencidas
    When "Gil" listar "deadline-compliance" com "metric" "open-overdue"
    Then o "0013/2026" deve constar com "matched" igual a 2
    And "meta.matchedTotal" deve ser igual a "totals.openOverdueCount" de "GET /reports/deadline-compliance"

  Scenario: [Sucesso] Dados atrasados
    Given que "dataAsOf" é de 14 minutos atrás
    When "Gil" abrir o detalhamento
    Then a API deve responder 200 com "meta.stale" verdadeiro
    And a tela deve exibir a faixa "A atualização está atrasada"

  Scenario: [Sucesso] Meta de desempenho (suíte de performance)
    Given um tenant com 50.000 processos e 600.000 passagens e um recorte de 5.000 processos visíveis
    When a suíte de performance chamar "GET /reports/{report}/processes" com "limit" 25
    Then o p95 da primeira página deve ser de até 1,5 segundo
    And o p95 de "GET /reports/detail/{processId}" deve ser de até 800 ms

  Scenario: [Validação] Parâmetros inválidos
    When "Gil" chamar "GET /reports/returns/processes" com "metric" "opened"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Gil" chamar com "periodKey" "2026-Q5"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Gil" chamar com "sort" "title"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Gil" chamar com "q" "saude"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Gil" chamar com "limit" 500
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Gil" chamar com um "cursor" adulterado
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Gil" chamar "GET /reports/relatorio-qualquer/processes"
    Then a API deve responder 404 com código "REPORT_NOT_FOUND"

  Scenario: [Permissão] Sem REPORT_VIEW, sem cobertura e processo invisível
    Given que "Marta" não tem "REPORT_VIEW"
    When "Marta" chamar "GET /reports/returns/processes"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar auditoria "access.denied"
    Given que "Gil" não tem visibilidade sobre o "0020/2026", de "Obras"
    When "Gil" chamar "GET /reports/detail/{id-do-0020/2026}"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"
    And a resposta deve ser idêntica à de um processo inexistente
    Given que "Lia" tem "REPORT_VIEW" de um setor que não é secretaria
    When "Lia" listar os processos de "returns"
    Then a API deve responder 200 com lista vazia e "hiddenCount" 0

  Scenario: [Tenant incorreto] Processo e cursor de outro tenant
    Given que existe o processo "0031/2026" da "Prefeitura B" com fatos de devolução
    When "Rita", da "Prefeitura A", chamar "GET /reports/detail/{id-do-0031/2026}"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"
    When "Rita" listar "returns" com "secretariatId" da "Prefeitura B"
    Then a API deve responder 200 com lista vazia
    When "Rita" usar um cursor emitido para a "Prefeitura B"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    And nenhuma auditoria "report.view_detail" deve citar processo da "Prefeitura B"

  Scenario: [Duplicidade] Reabrir o mesmo processo e repetir a consulta
    Given que "Gil" abriu o detalhe do "0012/2026" e a lista de "returns" nesta sessão
    When "Gil" reabrir o mesmo detalhe e recarregar a mesma lista
    Then não deve haver nova auditoria "report.view_detail" para eles
    And as respostas devem ser iguais, exceto por "meta.lagSeconds"

  Scenario: [Concorrência] Primeiro acesso simultâneo da sessão
    When "Gil" disparar duas chamadas iniciais de "returns" ao mesmo tempo na mesma sessão
    Then exatamente uma auditoria "report.view_detail" deve ser gravada

  Scenario: [Concorrência] Projetor altera fatos durante a paginação
    Given que "Gil" carregou a primeira página
    When o projetor gravar novos fatos antes da segunda página
    Then a segunda página não deve repetir linhas da primeira
    And nenhum processo não visível deve aparecer

  Scenario: [Falha de banco] Falha na consulta ou na auditoria
    Given que o banco fica indisponível durante a consulta de "GET /reports/returns/processes"
    When "Gil" abrir o detalhamento
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhum dado parcial deve ser devolvido
    Given que a gravação de "report.view_detail" falha
    When "Gil" abrir o detalhamento pela primeira vez na sessão
    Then a API deve responder 503 e não devolver nenhuma linha

  Scenario: [Falha de integração] Redis indisponível
    Given que o Redis está indisponível
    When "Gil" abrir duas páginas do detalhamento de "returns" na mesma sessão
    Then a API deve responder 200 nas duas
    And deve gravar "report.view_detail" nas duas (falha segura)
    And registrar o log "warn" "report_detail.audit_dedup_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta "Ver processos"; mensagem se acessado por link |
| Relatório inexistente ou fora do catálogo | 404 | `REPORT_NOT_FOUND` | "Relatório não encontrado." | Volta ao catálogo |
| Processo inexistente, de outro tenant ou não visível | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado ou sem permissão de acesso." | Fecha o painel e atualiza a lista |
| Indicadores ainda não preparados | 409 | `ANALYTICS_NOT_READY` | "Os indicadores do órgão ainda estão sendo preparados. Tente novamente mais tarde." | Estado vazio explicativo |
| Parâmetros, cursor ou ordenação inválidos | 422 | `VALIDATION_ERROR` | "O período informado é inválido. Volte ao relatório e escolha de novo." (conforme o campo) | Volta ao relatório com os filtros padrão |
| Limite de uso excedido | 429 | `RATE_LIMITED` | "Muitas consultas seguidas. Aguarde um instante e tente de novo." | Desabilita a ação até o `Retry-After` |
| Banco ou auditoria indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar os processos agora. Tente novamente em instantes." | "Tentar novamente"; respeita `Retry-After` |

## Dependências
- **Stories:** US-172 (catálogo, filtros, escopo, definições dos indicadores, `dataAsOf` e sigilo agregado; a rota `/relatorios/[relatorio]` complementa SCR-027). Indiretas: US-170 e US-171 (fatos e reconciliação), US-013 (sigilo do orçamento), US-097 (autorização), US-002 (lista de Processos: predicado de visibilidade e mascaramento por linha), US-073 (auditoria), US-174 (exportação do mesmo detalhamento), US-176 e US-177 (outras abas de SCR-028).
- **Decisões/ADRs:** DEC-024, DEC-025, DEC-030, DEC-206, ADR-014, POL-09, POL-14, POL-28.
- **Configurações:** `access.historicalDepartmentsCanView`; as de US-172 (`analytics.fiscalYearStartMonth`).
- **Lacunas nas fontes canônicas:**
  1. **Título do processo no detalhamento:** os fatos não guardam título nem objeto (RN-ANL-40 da US-170, minimização); a lista mostra só o número e o link para SCR-006. Alternativa: copiar `title` (`varchar(200)`) para `AnalyticsProcessFact`, ao custo de replicar texto livre. **Dúvida de produto/segurança; decidir com o piloto.**
  2. **Auditoria por sessão:** `report.view_detail` está no catálogo (events.md §7) como "1×/sessão/relatório"; esta story estende a chave a `(sessão, processo)` em ANL-10 e define `metadata`. **Ajuste em events.md §7 e confirmação com a auditoria.**
  3. **Limite de uso:** o limite de 60 requisições por minuto (RN-ANL-103) é proposta; api.md §1.6 define limites por rota. **Confirmar valores.**
  4. **Predicado de visibilidade sobre fatos:** `buildVisibilityPredicate` hoje é publicado sobre `processes`/`process_access`; é preciso um fragmento SQL que o aplique a `analytics_process_facts` por `process_id`, e outro de mascaramento (permissão ou custódia) por linha. **Registrar em domains.md (módulo `access`) e entities.md §4.11.**
  5. **Sessão e `Redis`:** o identificador de sessão do BFF e a chave de controle por sessão não estão catalogados. **Registrar em architecture/auth.**
  6. **Códigos e rotas novos a consolidar no card de API:** `PROCESS_NOT_FOUND` (já no padrão `<RESOURCE>_NOT_FOUND`), `REPORT_NOT_FOUND`; parâmetros `metric`, `periodKey`, `stageKey`; `meta.matchedTotal`, `visibleTotal`, `hiddenCount`, `totalItemsCapped`; rota `GET /reports/detail/{processId}` (reservar `detail` como chave inválida de relatório).
  7. **Tela de detalhe do processo:** não há SCR entre as 41 para o painel de ANL-10; ele é um painel dentro de SCR-028. **Confirmar no card de telas.**

## Impacto técnico
- A consulta combina três filtros no mesmo SQL (escopo de `REPORT_VIEW`, visibilidade da DEC-024 e recorte do relatório) sobre fatos com RLS; o predicado de visibilidade faz *join* com `process_access` e é o ponto mais sensível à meta de 1,5 s. O índice `(tenant_id, requesting_secretariat_id, opened_at)` e os de passagem (`(tenant_id, stage_key, exited_at)`, `(tenant_id, exited_at) WHERE exited_at IS NULL`) sustentam o recorte.
- A paridade "número × lista" é o principal seguro de qualidade: mesma definição de recorte, mesma função e teste automático por relatório e métrica.
- A contagem `hiddenCount` mostra quantos processos do número a pessoa não vê; é consequência do agregado ter escopo maior que a visibilidade e não vaza nada além do que o agregado já mostra.
- Falhar a auditoria falha a leitura (fail-closed): custa disponibilidade, mas garante que nenhum acesso ao detalhamento ocorra sem trilha.
- Compatibilidade: rotas novas sob `/api/v1/reports`; nenhuma rota do MVP 1 muda; `ReportDetailQuery` é reutilizada pela US-174.

## Backend
- **Módulo(s):** `analytics` (dono), `access` (visibilidade e mascaramento), `organization`, `catalog`, `workflow` (rótulos de etapas), `identity` (nome do responsável), `audit`, `platform` (Redis, limite de uso).
- **Casos de uso:** `ListReportProcessesQuery` (ANL-09), `GetReportProcessDetailQuery` (ANL-10), `RecordReportDetailAccessCommand` (auditoria com deduplicação por sessão).
- **Domínio:** `ReportDetailQuery` (compartilhada com a US-174), `MetricProcessMatcher` (processo × passagem, por relatório e métrica), `VisibilityPredicate` e `ConfidentialValueMasker` (portas do `access`), `DetailCursor` (assinado, preso a tenant e usuário), `ReportDetailAuditPolicy` (chave por sessão, falha segura), `ProcessAnalyticsAssembler`.
- **Integrações internas:** `AccessFacade` (predicado de visibilidade, escopo, sigilo e custódia), `OrganizationFacade`, `CatalogFacade`, `WorkflowFacade` (rótulos de etapa por versão), `IdentityFacade` (nome), `AuditService`, Redis (chave de sessão).
- **Transação:** leitura `READ ONLY` com `app.tenant_id`; a auditoria é gravada na mesma requisição, antes de devolver os dados; falha em qualquer parte devolve 503 sem corpo parcial.

## Frontend
- **Tela(s):** SCR-028 (`/relatorios/[relatorio]`), aba "Processos"; painel lateral "Detalhe do processo".
- **Componentes:** `ReportDetailHeader` (breadcrumb, chips do recorte, `FreshnessBadge` da US-170), `ReportTabs` (contêiner de abas, RN-ANL-109), `ReportProcessesTable` (colunas ordenáveis, coluna "No número"), `ConfidentialValueCell` ("Sigiloso" com cadeado e texto acessível), `HiddenCountNotice`, `ProcessSearchBox`, `ProcessAnalyticsDrawer` (marcos e passagens), `StaleBanner`.
- **Estados:** skeleton da tabela, vazio ("Nenhum processo que você possa ver neste número."), erro com "Tentar novamente", não preparado, atrasado (faixa), sucesso com cursor.
- **Acessibilidade e responsividade:** tabela com cabeçalhos associados e ordenação por teclado (`aria-sort`); sigilo e situação com texto e ícone; painel com foco preso, `Esc` e retorno do foco à linha; abaixo de 768 px a tabela vira lista de cartões e o painel ocupa a tela inteira; datas no fuso do tenant.

## Banco de dados
- **Tabelas:** leitura de `analytics_process_facts`, `analytics_stage_facts` e `analytics_pca_item_facts` (código do item); leitura de `process_access` pelo predicado do `access`; nenhuma escrita além de `audit_logs`.
- **Migrações:** funções de leitura/consulta do detalhamento (`security definer` ou consulta parametrizada do repositório com RLS); índices de apoio ao recorte e à busca por prefixo de `code` (`(tenant_id, code text_pattern_ops)`) em `analytics_process_facts`.
- **Índices/constraints relevantes:** `(tenant_id, code text_pattern_ops)`; os da US-170 nos fatos; chave de ordenação estável com `process_id` para o cursor.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `ANL-09` | GET | `/api/v1/reports/{report}/processes` | filtros do recorte, `periodKey`, `stageKey`, `metric`, `q`, `sort`, `cursor`, `limit` | `200 { data: ProcessRow[], meta { nextCursor, totalItems, totalItemsCapped, matchedTotal, visibleTotal, hiddenCount, dataAsOf, lagSeconds, stale, confidentialStepUpAvailable } }` | 200, 403, 404, 409, 422, 429, 503 |
| `ANL-10` | GET | `/api/v1/reports/detail/{processId}` | path `processId` | `200 { data: { process, milestones, stages[], indicators }, meta { dataAsOf, projectedAt, stale } }` | 200, 403, 404, 409, 429, 503 |

## Logs
- `info` `report_detail.list_served` — `report`, `metric`, `rowsCount`, `visibleTotal`, `hiddenCount`, `durationMs`, `correlationId`.
- `info` `report_detail.process_served` — `processId`, `stagesCount`, `durationMs`.
- `info` `report_detail.audit_recorded` — `report`, `kind` (`LIST`, `PROCESS`).
- `warn` `report_detail.audit_dedup_unavailable` — `fallback` (`AUDIT_EVERY_ACCESS`); `warn` `report_detail.stale_served` — `lagSeconds`.
- `error` `report_detail.audit_failed` — `errorClass`; `error` `report_detail.query_failed` — `report`, `errorClass`.
- **Nunca logar:** valores monetários, números de processo em texto livre, nomes de responsáveis, `q`, filtros com ids, cursor.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `report.view_detail` | `ACCESS` | Primeiro ANL-09 da sessão por relatório; primeiro ANL-10 da sessão por processo | `metadata`: `report`, `metric`, `periodKey`, `filtersHash`, `rowsReturned`, `processId` (só em ANL-10), `sessionHash`; nunca valores nem ids de filtro |
| `access.denied` | `ACCESS` | 403 em qualquer rota da story | `reasonCode`, `route` |

## Testes necessários
- **Unitários:** `MetricProcessMatcher` (cada `metric` por relatório; `matched` de processo e de passagem; período e etapa), `ConfidentialValueMasker` (permissão, custódia, ausência), `DetailCursor` (assinatura, tenant, usuário, expiração), `ReportDetailAuditPolicy` (uma vez por sessão e relatório, por processo, falha segura sem Redis), ordenação com valores mascarados, validação de `periodKey`, `q` e `sort`.
- **Integração (Testcontainers):** listagem e detalhe sobre fatos reais; predicado de visibilidade sobre fatos (processo com e sem `ProcessAccess`); sigilo por linha; paridade número × lista (`matchedTotal` = valor de ANL-06) para cada relatório e métrica; `hiddenCount`; auditoria na mesma requisição e fail-closed.
- **API/contrato:** ANL-09 e ANL-10 (corpo, filtros, cursor, erros, 404 idêntico entre inexistente e invisível); ausência de título, objeto, comentários e totais monetários.
- **RBAC e multi-tenant:** 403 e 404 por papel e tenant; escopos de `REPORT_VIEW` × visibilidade de `PROCESS_VIEW`; sigilo (permissão, custódia, nenhum); teste novo na suíte `test/tenant-leak` (lista, detalhe, cursor e auditoria); teste de arquitetura de que nada lê `ProcessStage`/`ProcessMovement`.
- **Concorrência:** primeiro acesso simultâneo da sessão (uma auditoria); projetor durante a paginação; mesma sessão em duas abas.
- **E2E (Playwright):** do número de SCR-027 ao processo, com aviso de `hiddenCount`, coluna de sigilo, ordenação, busca, painel de detalhe e auditoria verificada; navegação de volta mantém os filtros.
- **Acessibilidade/performance:** axe em SCR-028 (tabela, painel); p95 da primeira página ≤ 1,5 s e do detalhe ≤ 800 ms na suíte de performance, medidos no endurecimento e nunca no card.

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
- [ ] Teste prova que processo não visível nunca é listado, contado em `visibleTotal`, buscado nem detalhado, mesmo com `REPORT_VIEW` de escopo `TENANT`
- [ ] Teste de paridade entre o número de ANL-06 e `matchedTotal` de ANL-09 para todo relatório e métrica
- [ ] Teste prova que `report.view_detail` é gravado uma vez por sessão e relatório (e por processo em ANL-10) e que a falha da auditoria bloqueia a resposta
- [ ] Teste prova que nenhum valor sigiloso sai sem a permissão ou a custódia e que a ordenação por valor não revela a ordem dos mascarados
- [ ] Metas de latência registradas como testes da suíte de performance
- [ ] Lacunas 1 a 7 resolvidas ou registradas nas fontes canônicas

## Estimativa
**M** — duas rotas de leitura sobre fatos já prontos, com o recorte reaproveitado da US-172; o esforço está na combinação de escopo, visibilidade e sigilo no mesmo SQL, no cursor seguro, na auditoria por sessão e no painel de detalhe.

## Prioridade
**P1** — sem o detalhamento, o número do relatório não é rastreável até o processo, exigência da prestação de contas (art. 11, parágrafo único) e do Controle Interno; é também a superfície de maior risco de vazamento do épico e precisa nascer com os testes de visibilidade e sigilo.

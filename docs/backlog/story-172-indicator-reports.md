---
id: US-172
title: "Relatórios de indicadores"
epic: EP-028
feature: FT-081
mvp: 2
priority: P1
estimate: L
status: Especificada
depends_on: [US-013, US-097, US-171]
modules: [analytics, access, organization, catalog, process, platform]
screens: [SCR-027]
endpoints: [ANL-05, ANL-06, ANL-07, ANL-08]
permissions: [REPORT_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: []
---

# US-172 — Relatórios de indicadores

## Título
Consultar os relatórios de tempo de ciclo, devoluções, cumprimento de prazo e volume e valor, por mês, trimestre e exercício

## Descrição
**Como** gestor de contratações (e, com o mesmo recorte, Controle Interno, Auditor e autoridade competente), **quero** abrir a tela de Relatórios e ver quanto, quando e com que atraso as contratações do meu escopo andam, por secretaria, modalidade e tipo de contratação, no mês, no trimestre ou no exercício, com a data da última atualização, **para** prestar contas à alta administração (art. 11, parágrafo único da Lei 14.133/2021) e agir sobre o que atrasa, sem montar planilha.

A story entrega a tela **SCR-027** (`/relatorios`) e a API de relatórios lida do read model (US-170 e US-171): o catálogo de relatórios disponíveis à pessoa (ANL-05), os dados de cada relatório com filtros (ANL-06) e as visões salvas de relatório (ANL-07 e ANL-08). É aqui que as **definições dos indicadores** ficam fixadas (RN-ANL-71 a RN-ANL-78), como fonte única para as demais stories do épico. O detalhamento por processo é da US-173, a exportação da US-174, a execução do PCA da US-175 e a análise de gargalos das US-176 e US-177.

## Contexto
- DEC-206 e [ADR-014](../adr/adr-014-indicators-read-model.md): relatórios leem **só** o read model (tabelas de fatos e visões materializadas), nunca `ProcessStage` ou `ProcessMovement` (RN-ANL-06, RN-ANL-19). O dashboard operacional do MVP 1 (DEC-088, US-076) continua como está; os relatórios servem a séries históricas, o dashboard ao dia a dia.
- Segurança (POL-28, DEC-206): os agregados são recortados pelo escopo de `REPORT_VIEW` (`TENANT`/`ORGANIZATION` veem tudo; `DEPARTMENT`/`OWN_DEPARTMENTS` veem processos cuja **secretaria solicitante** está no escopo — permissions.md §5.2); valores de processos com orçamento sigiloso são mascarados **por linha antes de agregar** e ficam fora das somas de quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` sobre eles, com `confidentialExcluded: true` (DEC-030, US-013).
- As funções de leitura das visões são `security definer` e usam o tenant da sessão; a API não tem `SELECT` direto nas visões (US-170, RN-ANL-01). Consistência eventual assumida: a tela mostra "Dados atualizados em ..." (RN-ANL-09).
- O dashboard do MVP 1 já estabeleceu o padrão de agregado com `confidentialExcluded` por grupo (US-076, RN-DASH-07); aqui a regra é mais restrita (sem a exceção da custódia atual, POL-28) e o resultado traz também o total do recorte.
- Os filtros por mês, trimestre e exercício usam `analytics.fiscalYearStartMonth` (padrão 1, faixa 1 a 12; entities.md §8). As visões são mensais e o exercício é montado na leitura.
- As metas E3 e Q1 do roadmap (§4.8) são medidas com estes relatórios; a meta de latência é p95 ≤ 2 s para o relatório do exercício (feature FT-081), verificada na suíte de performance.
- O padrão de visões salvas, compartilhamento e limite por dono vem da US-003 (`SavedView`, `scope`); o escopo `REPORT` ainda não existe no enum `SavedViewScope` (lacuna 2).

## Objetivo
Entregar quatro relatórios com definições únicas e documentadas, que respondem em até 2 s (p95) no exercício, sempre com a data da última atualização, nunca expõem processo fora do escopo nem valor sigiloso a quem não pode vê-lo, e permitem salvar e reaplicar combinações de filtros.

## Persona
- **Principal:** Gestor de contratações (`GESTOR_CONTRATACOES`) com `REPORT_VIEW`.
- **Secundárias:** Controle Interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`), com `REPORT_VIEW` e, por padrão, `PROCESS_VIEW_CONFIDENTIAL_BUDGET`; Autoridade competente (`AUTORIDADE_COMPETENTE`) — visão do exercício; Administrador do órgão (`ADMIN_ORGAO`) — só se o tenant conceder `REPORT_VIEW` ao perfil.

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`; MFA conforme `security.mfaPolicy` (`REPORT_VIEW` é risco `L`).
- `REPORT_VIEW` com escopo que cubra ao menos uma secretaria solicitante; sem cobertura, a tela abre vazia com orientação (RN-ANL-79).
- Read model inicializado para o tenant (US-171: primeira reconstrução `FULL` concluída); caso contrário a API responde 409 `ANALYTICS_NOT_READY` (RN-ANL-83).
- `analytics.fiscalYearStartMonth` configurado (padrão 1).
- **Visões salvas:** `REPORT_VIEW` (ANL-07 e ANL-08).

## Fluxo principal
1. O gestor abre **Relatórios** (SCR-027, `/relatorios`) pelo menu (item visível só com `REPORT_VIEW`).
2. O front chama `GET /api/v1/reports` (ANL-05) e monta o seletor de relatórios com os disponíveis à pessoa: "Tempo de ciclo", "Devoluções", "Cumprimento de prazo" e "Volume e valor" (e os que as US-175 a US-177 registrarem).
3. A tela aplica, nesta ordem, os parâmetros da URL, a visão padrão do usuário (ANL-07) ou o padrão do sistema (relatório "Volume e valor", exercício corrente, granularidade mensal, sem agrupamento), e chama `GET /api/v1/reports/{report}` (ANL-06) com os filtros.
4. A API valida os filtros; resolve o escopo de `REPORT_VIEW` do vínculo em secretarias solicitantes (RN-ANL-79); resolve em quais secretarias o usuário pode somar valores sigilosos (RN-ANL-81); chama a função de leitura da visão correspondente e, para mediana e p90 de trimestre ou exercício, a função sobre os fatos; monta linhas, totais e `meta`.
5. A tela exibe o cabeçalho com "Dados atualizados em 11/11/2026 14:05", os cartões de totais, o gráfico da série (com a tabela equivalente logo abaixo) e, se o recorte tiver agrupamento, uma linha por grupo.
6. Quando `meta.confidentialExcluded` é verdadeiro, aparece o aviso "Inclui valores sigilosos não exibidos: os totais de valor não somam processos com orçamento sigiloso." junto ao total de valor.
7. O gestor altera o período (exercício, trimestre ou mês), a granularidade, a secretaria, a modalidade, o tipo de contratação e o agrupamento; a URL é atualizada e a tela refaz a chamada.
8. Cada número tem a ação "Ver processos" (US-173): leva a SCR-028 com os mesmos filtros e o recorte clicado.
9. O gestor aciona **"Salvar visão"** (nome, "Usar como padrão", "Compartilhar com a equipe"); o front envia `POST /api/v1/reports/saved-views` (ANL-08) com `Idempotency-Key` e o estado atual dos filtros (RN-ANL-85).
10. O seletor **Visões** lista as próprias e as compartilhadas (ANL-07); escolher uma aplica os filtros à URL e refaz a consulta.
11. Se o gestor tem `REPORT_EXPORT`, o botão **Exportar** (US-174) aparece; esta story só garante que a tela e a exportação usem o mesmo contrato de filtros.

## Fluxos alternativos
- **FA-01 — Projetor atrasado:** `meta.stale = true` (defasagem acima de 10 minutos): faixa "Os números mostram a situação de {dataAsOf}. A atualização está atrasada." (RN-ANL-82). Os dados continuam exibidos.
- **FA-02 — Indicadores ainda sendo preparados:** o tenant não concluiu a carga inicial; a API responde 409 `ANALYTICS_NOT_READY` e a tela mostra "Os indicadores do órgão ainda estão sendo preparados. Isso pode levar algumas horas." (RN-ANL-83).
- **FA-03 — Escopo sem cobertura:** `REPORT_VIEW` limitado a um setor (que não é secretaria) não cobre nenhuma secretaria solicitante; a API responde 200 com linhas vazias e `meta.scope.level = NONE`, e a tela explica "Seu perfil não cobre nenhuma secretaria. Peça ao administrador do órgão que ajuste seu acesso." (RN-ANL-79).
- **FA-04 — Sem dados no recorte:** linhas zeradas por mês e a mensagem "Nenhum processo neste recorte." (RN-ANL-88).
- **FA-05 — Exercício não iniciado em janeiro:** com `analytics.fiscalYearStartMonth = 7`, o "Exercício 2026/2027" vai de julho de 2026 a junho de 2027 e os trimestres seguem esse início (RN-ANL-76).
- **FA-06 — Agrupamento por etapa:** só em "Devoluções" e "Cumprimento de prazo"; em outro relatório, 422 (RN-ANL-78).
- **FA-07 — Muitos grupos:** mais de 200 grupos mostram os 200 primeiros pela ordem da RN-ANL-87 e `meta.groupsTruncated = true`, com o aviso "Mostrando os 200 maiores grupos. Refine os filtros." (RN-ANL-84).
- **FA-08 — Sigilo parcial:** o gestor tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` só sobre a secretaria de Obras; a soma de valor inclui os sigilosos de Obras e exclui os das demais, com `confidentialExcluded: true` nas linhas excluídas e no total (RN-ANL-81).
- **FA-09 — Visão salva com filtro desatualizado:** secretaria, modalidade ou tipo que não existe mais é descartado com o aviso "Alguns filtros desta visão não estão mais disponíveis e foram ignorados." (RN-ANL-85).
- **FA-10 — Visão compartilhada:** o resultado respeita o escopo e o sigilo de quem a aplica; quem não é dono só pode aplicar ou "Salvar como minha" (RN-ANL-85).
- **FA-11 — Limite de visões:** o 21º registro responde 422 "Você atingiu o limite de 20 visões. Exclua uma visão para salvar outra." (RN-ANL-85).
- **FA-12 — Relatório fora do catálogo da pessoa:** a rota direta de um relatório que ela não pode ver responde 404 `REPORT_NOT_FOUND` (RN-ANL-70).

## Regras de negócio
- **RN-ANL-05** — Valores de processos sigilosos ficam gravados, mas as somas das visões os excluem e a soma deles entra em coluna separada, exibida só a quem tem a permissão de sigilo (DEC-206, DEC-030, POL-09). *(regra da feature, adotada)*
- **RN-ANL-06** — Os relatórios nunca consultam `ProcessStage`/`ProcessMovement` diretamente em produção; só o read model (DEC-206). *(regra da feature, adotada)*
- **RN-ANL-09** — A defasagem-alvo é de até 5 minutos e a data da última atualização é exposta às telas (DEC-206). *(regra da feature, adotada)*
- **RN-ANL-11** — Os agregados são recortados pelo escopo de `REPORT_VIEW`: `TENANT` e `ORGANIZATION` veem todo o recorte; `DEPARTMENT` e `OWN_DEPARTMENTS` veem processos cuja secretaria solicitante está no escopo (DEC-206, permissions.md §5.2). *(regra da feature, adotada)*
- **RN-ANL-13** — Processos com orçamento sigiloso ficam fora das somas de quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` sobre eles, com `confidentialExcluded: true`; o mascaramento é por linha **antes** de agregar (DEC-030, POL-28). *(regra da feature, adotada)*
- **RN-ANL-17** — O tempo de ciclo e o cumprimento de prazo usam os fatos em dias úteis, descontadas as pausas de SLA (DEC-206, DEC-205). *(regra da feature, adotada)*
- **RN-ANL-19** — Nenhum relatório consulta `ProcessStage`/`ProcessMovement` em produção; só o read model (DEC-206). *(regra da feature, adotada)*
- **RN-ANL-70** — Catálogo. Chaves de relatório (parte da URL `/relatorios/[relatorio]`): `cycle-time` ("Tempo de ciclo"), `returns` ("Devoluções"), `deadline-compliance` ("Cumprimento de prazo") e `volume-value` ("Volume e valor"). Os relatórios das US-175 a US-177 se registram no mesmo catálogo (`ReportRegistry`) com chave própria. Chaves reservadas que não podem ser de relatório: `detail`, `saved-views`, `exports`. O catálogo devolve só os relatórios que a pessoa pode ver; chave desconhecida ou fora do catálogo da pessoa responde 404 `REPORT_NOT_FOUND`.
- **RN-ANL-71** — **Tempo de ciclo.** Início: `openedAt` do processo (abertura/autuação: criação ou 1º encaminhamento, conforme `numbering.process.assignOn`). Fim: `completedAt` (processo concluído; na v1 do workflow significa "planejamento concluído" e na v2 "fase preparatória concluída", DEC-196). Medida: `cycleTimeBusinessDays`, em dias úteis (RN-ANL-34, US-170), descontadas as pausas de prazo (RN-ANL-35: suspensão do processo e diligência). Atribuído ao mês de `completedAt`. Só processo concluído entra na média, na mediana (percentil 50 contínuo) e no p90 (percentil 90 contínuo); processo ainda aberto aparece como contagem "em andamento".
- **RN-ANL-72** — **Cancelados, suspensos e rascunhos.** Processo `CANCELED` não entra em nenhuma medida de tempo e conta em `canceledCount` no mês de `canceledAt`. Rascunho e processo sem `openedAt` são ignorados. `AWAITING_APPROVAL`, `RETURNED` e `SUSPENDED` são "em andamento" (a suspensão pausa o prazo e é descontada do ciclo). Considera-se **concluído** o processo com `completedAt` preenchido (inclui `COMPLETED` e `PUBLISHED`).
- **RN-ANL-73** — **Devolução.** É a passagem de etapa que fecha com `exitStatus = RETURNED`: devolução por `RETURN` do encaminhamento, por `APPROVAL_RETURNED` e por diligência do jurídico ou do Controle Interno. Não são devolução: `APPROVAL_REJECTED`, passagens `CANCELED` (cancelamento de ramo), `MIGRATED` e `SKIPPED`. Atribuída ao mês de `exitedAt`, à secretaria, modalidade e tipo do processo e à etapa **de origem** da devolução (`stageKey`). `returnRatePct` = `returnsCount ÷ stagesClosedCount × 100` (1 casa), com `stagesClosedCount` = passagens `COMPLETED` + `RETURNED` do mesmo mês e recorte; `null` se o denominador é 0.
- **RN-ANL-74** — **Cumprimento de prazo.** Elegível: passagem fechada (`COMPLETED` ou `RETURNED`) com `dueAt` não nulo. No prazo: `wasOverdue = false` (saída até `dueAt`, que já inclui as extensões por pausa). `onTimePct` = `onTimeCount ÷ eligibleCount × 100` (1 casa); `avgOverdueBusinessDays` = média de `overdueBusinessDays` das atrasadas; `noDueCount` = fechadas sem prazo, mostradas à parte e fora do percentual. `SKIPPED`, `CANCELED` e `MIGRATED` não entram. Atribuído ao mês de `exitedAt`; ramos paralelos contam uma passagem cada. `openOverdueCount` (passagens abertas já vencidas **agora**, do fato aberto) aparece só nos totais, respeita secretaria, modalidade e tipo, ignora o período e não entra no percentual.
- **RN-ANL-75** — **Unidade e formato.** Todos os tempos são em **dias úteis** (sem alternância para dias corridos) e rotulados assim. Dinheiro em reais, texto com 2 casas ("1250000.00"); durações com 2 casas; percentuais com 1 casa; contagens inteiras.
- **RN-ANL-76** — **Granularidade e exercício.** `MONTH` (mês civil), `QUARTER` (trimestre do exercício: o T1 começa no mês `analytics.fiscalYearStartMonth`) e `FISCAL_YEAR` (12 meses a partir desse mês). `fiscalYear` é o ano civil em que o exercício **começa**; o rótulo é "2026" quando o início é janeiro e "2026/2027" nos demais casos. Datas no fuso do tenant. Trimestre e exercício somam as contagens e somas mensais (média = soma ÷ contagem, nunca média de médias); mediana e p90 de trimestre e exercício vêm do cálculo direto sobre os fatos do período. Mudar `fiscalYearStartMonth` regrupa os números sem reconstruir fatos.
- **RN-ANL-77** — **Atribuição temporal.** `openedCount` e valor aberto: `openedAt`; `completedCount`, ciclo e valor concluído: `completedAt`; `canceledCount`: `canceledAt`; devoluções e prazo: `exitedAt` da passagem. `inProgressCount` é o acumulado ao fim de cada período (abertos até o fim menos concluídos e cancelados até o fim).
- **RN-ANL-78** — **Dimensões e filtros.** Filtros: `secretariatId[]` (secretaria solicitante), `modalityCode[]` e `contractingTypeCode[]`, validados contra o catálogo do tenant (códigos inativos valem). Agrupamento `groupBy`: `NONE`, `SECRETARIAT`, `MODALITY`, `CONTRACTING_TYPE` e, só em `returns` e `deadline-compliance`, `STAGE`. Modalidade ausente forma o grupo "Não informada". **Faixa de valor não é dimensão** nesta versão: o valor sigiloso permitiria deduzir valores pela diferença entre faixas, e as visões não a trazem (lacuna 5).
- **RN-ANL-79** — **Escopo.** O escopo de `REPORT_VIEW` de todos os vínculos ativos é resolvido em secretarias solicitantes: `TENANT` = sem filtro; `ORGANIZATION` = secretarias do órgão; `DEPARTMENT` (com ou sem subárvore) e `OWN_DEPARTMENTS` = as secretarias que estão no escopo (um setor que não é secretaria não cobre nenhuma). A união dos vínculos vale. Filtros fora do escopo não geram erro: o resultado é a interseção (possivelmente vazia). Escopo sem cobertura responde 200 vazio com `meta.scope.level = NONE`.
- **RN-ANL-80** — **Sigilo: mascarar antes de agregar.** A função de leitura recebe a lista de secretarias em que o usuário pode somar sigilosos e devolve valor sigiloso **apenas** nessas linhas; nas demais o valor sigiloso nunca sai do banco e a linha vem com `confidentialExcluded = true`. Nenhuma medida derivada de valor (média, mediana, mínimo, máximo) é exposta, nem por linha nem por faixa, e nenhum valor individual de processo aparece em relatório agregado. Contagens incluem os processos sigilosos (a existência não é sigilosa); `processesWithoutValueCount` conta só processos sem valor e não revela sigilosos.
- **RN-ANL-81** — **Cobertura do sigilo.** O valor sigiloso entra na soma de uma secretaria somente se `PROCESS_VIEW_CONFIDENTIAL_BUDGET` do usuário cobre a secretaria inteira (`TENANT`, `ORGANIZATION` que a contém ou `DEPARTMENT` com subárvore sobre ela); cobertura parcial de uma secretaria vale como ausente. O total é a soma das linhas incluídas; `meta.confidentialExcluded` é verdadeiro se qualquer linha do recorte tem sigiloso excluído. Diferente do dashboard (US-076), a custódia atual **não** libera valor em agregado (POL-28).
- **RN-ANL-82** — **Atualização e atraso.** `meta.dataAsOf` é o `dataAsOf` das visões (US-170, RN-ANL-44) e `meta.lagSeconds` é `now − dataAsOf`; `meta.stale = lagSeconds > 600`. Resposta sempre com `Cache-Control: private, no-store`.
- **RN-ANL-83** — Sem execução `REBUILD` concluída do tenant (estado `NOT_INITIALIZED`, US-170), ANL-06 e as rotas de relatório respondem 409 `ANALYTICS_NOT_READY`; o catálogo (ANL-05) continua disponível.
- **RN-ANL-84** — Limites: período de até 60 meses; até 200 grupos por relatório (`meta.groupsTruncated`); até 10 valores por filtro de lista; mais que isso responde 422.
- **RN-ANL-85** — **Visões salvas.** Reusam o `SavedView` da US-003 com `scope = REPORT`: nome de 1 a 80 caracteres, único por dono e escopo sem diferenciar maiúsculas; no máximo 20 por dono; uma padrão por dono; `filters` versionado (`{ "v": 1, report, granularity, fiscalYear | from/to, groupBy, secretariatIds, modalityCodes, contractingTypeCodes }`) validado por `reportViewFiltersSchema`; a visão compartilhada transmite **critérios, nunca dados** (cada um vê o que seu escopo e seu sigilo permitem); só o dono altera ou exclui (alteração e exclusão pelas rotas PRC-37 e PRC-38 com `scope = REPORT`; lacuna 2); filtros de valores que não existem mais são descartados com aviso.
- **RN-ANL-86** — Acesso aos dados: a API consulta o read model **só** por `AnalyticsReadRepository`, que chama as funções `security definer`; teste de arquitetura proíbe a importação de `ProcessStage`/`ProcessMovement` e de repositórios do módulo `process` por `analytics`.
- **RN-ANL-87** — Ordem: linhas por período crescente; dentro do período, grupos pela medida principal decrescente (`openedCount`, `completedCount`, `returnsCount` ou `overdueCount`, conforme o relatório) e depois pelo rótulo.
- **RN-ANL-88** — Vazios: meses sem dado dentro do período aparecem com contagens 0 e medidas `null`; razão com denominador 0 é `null` (a tela mostra "—"); a série é contínua do primeiro ao último período.
- **RN-ANL-89** — Rótulos: o servidor devolve `label` pronto de cada grupo (secretaria, modalidade, tipo, etapa), nunca valores técnicos (DEC-184); os rótulos de período e de exercício seguem a RN-ANL-76.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Relatório | `report` (path) | texto | Sim | `cycle-time`, `returns`, `deadline-compliance`, `volume-value` (RN-ANL-70) | catálogo |
| Granularidade | `granularity` | `MONTH` \| `QUARTER` \| `FISCAL_YEAR` | Não | RN-ANL-76 | `MONTH` |
| Exercício | `fiscalYear` | inteiro | Não | Ano em que o exercício começa; exclui `from`/`to` | exercício corrente |
| De / Até | `from`, `to` | `AAAA-MM` | Não | `from ≤ to`; até 60 meses (RN-ANL-84) | derivado do exercício |
| Secretaria | `secretariatId[]` | uuid (lista) | Não | Até 10; interseção com o escopo (RN-ANL-79) | todas do escopo |
| Modalidade | `modalityCode[]` | texto (lista) | Não | Códigos do catálogo; até 10 | todas |
| Tipo de contratação | `contractingTypeCode[]` | texto (lista) | Não | Códigos do catálogo; até 10 | todos |
| Agrupar por | `groupBy` | `NONE` \| `SECRETARIAT` \| `MODALITY` \| `CONTRACTING_TYPE` \| `STAGE` | Não | `STAGE` só em `returns` e `deadline-compliance` (RN-ANL-78) | `NONE` |
| Nome da visão | `name` | texto curto | Sim (ANL-08) | 1–80; único por dono e escopo | — |
| Usar como padrão | `isDefault` | interruptor | Não | Uma por dono e escopo | `false` |
| Compartilhar | `isShared` | interruptor | Não | RN-ANL-85 | `false` |
| Chave de idempotência | `Idempotency-Key` | texto | Sim (ANL-08) | 24 h | gerada pelo front |
| *(saída)* Linhas | `rows[]` | lista | — | `periodKey`, `periodLabel`, `groupKey?`, `groupLabel?`, `metrics`, `confidentialExcluded` | servidor |
| *(saída)* Totais | `totals`, `groupTotals[]` | objetos | — | Soma das linhas incluídas; medidas por relatório (abaixo) | servidor |
| *(saída)* Atualização | `meta.dataAsOf`, `meta.lagSeconds`, `meta.stale` | timestamptz, inteiro, boolean | — | RN-ANL-82 | servidor |
| *(saída)* Sigilo | `meta.confidentialExcluded` | boolean | — | RN-ANL-81 | servidor |
| *(saída)* Escopo | `meta.scope { level, secretariatsCount }` | objeto | — | `level`: `TENANT`, `ORGANIZATION`, `DEPARTMENTS`, `NONE` | servidor |
| *(saída)* Definição | `meta.definitionVersion` | inteiro | — | `INDICATOR_DEFINITION_VERSION` | código |

Medidas de cada relatório (`metrics`):
- `cycle-time`: `completedCount`, `avgBusinessDays`, `medianBusinessDays`, `p90BusinessDays`, `inProgressCount`.
- `returns`: `returnsCount`, `stagesClosedCount`, `returnRatePct`.
- `deadline-compliance`: `eligibleCount`, `onTimeCount`, `overdueCount`, `onTimePct`, `avgOverdueBusinessDays`, `noDueCount`; nos totais, também `openOverdueCount`.
- `volume-value`: `openedCount`, `completedCount`, `canceledCount`, `inProgressCount`, `openedValue`, `completedValue`, `processesWithoutValueCount`, `confidentialProcessesCount`.

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `granularity` ou `groupBy` fora dos valores aceitos, ou `groupBy = STAGE` em relatório que não o aceita | Front + API (Zod) | "Escolha um agrupamento válido para este relatório." | `VALIDATION_ERROR` |
| V-02 | `fiscalYear` e `from`/`to` informados juntos; `from` posterior a `to`; formato diferente de `AAAA-MM` | Front + API | "Informe o exercício ou o período, não os dois, e com o início antes do fim." | `VALIDATION_ERROR` |
| V-03 | Período acima de 60 meses | Front + API | "O período pode ter até 5 anos. Reduza o intervalo." | `VALIDATION_ERROR` |
| V-04 | Mais de 10 valores em um filtro de lista, ou código de modalidade/tipo inexistente no tenant | API | "Alguns filtros são inválidos. Revise a consulta." | `VALIDATION_ERROR` |
| V-05 | Relatório inexistente ou fora do catálogo da pessoa | API | "Relatório não encontrado." | `REPORT_NOT_FOUND` (404) |
| V-06 | Tenant sem carga inicial do read model | API | "Os indicadores do órgão ainda estão sendo preparados. Tente novamente mais tarde." | `ANALYTICS_NOT_READY` (409) |
| V-07 | Nome da visão ausente ou acima de 80 caracteres | Front + API | "Informe um nome de até 80 caracteres." | `VALIDATION_ERROR` |
| V-08 | Nome de visão repetido para o mesmo dono | API (+ índice único) | "Você já tem uma visão com este nome." | `CONFLICT` (409) |
| V-09 | Limite de 20 visões atingido | API | "Você atingiu o limite de 20 visões. Exclua uma visão para salvar outra." | `VALIDATION_ERROR` |
| V-10 | `filters` da visão fora do contrato (`reportViewFiltersSchema`, versão ausente, relatório desconhecido) | API | "Não foi possível salvar: há filtros inválidos." | `VALIDATION_ERROR` |
| V-11 | Visão compartilhada por outro marcada como padrão | API | "Salve uma cópia da visão para usá-la como padrão." | `VALIDATION_ERROR` |
| V-12 | `Idempotency-Key` ausente ou reutilizada com corpo diferente | API | "Esta chave já foi usada em outra solicitação." | `IDEMPOTENCY_KEY_REUSED` (422) |

## Permissões
- **Permissão:** `REPORT_VIEW` com escopo que cubra ao menos uma secretaria solicitante (ANL-05 a ANL-08); `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (risco `H`) para somar valores sigilosos de secretarias que cobre (RN-ANL-81). Perfis padrão com `REPORT_VIEW` (matriz de permissions.md §3): `GESTOR_CONTRATACOES`, Planejamento, Compras, Licitações, `CONTROLE_INTERNO`, `AUTORIDADE_COMPETENTE` e `AUDITOR`; `ADMIN_ORGAO` não, por padrão (o tenant pode conceder).
- **Políticas:** POL-28 (relatórios e sigilo), POL-09 (orçamento sigiloso estendida a fatos e agregados), DEC-024 (visibilidade — só no detalhamento da US-173).
- **MFA:** `REPORT_VIEW` é risco `L`: não exige MFA. O desmascaramento de valores sigilosos segue a exceção da POL-14: quando `PROCESS_VIEW_CONFIDENTIAL_BUDGET` exigiria MFA e a sessão não tem, os valores sigilosos saem **excluídos** (sem 403) e a resposta traz `meta.confidentialStepUpAvailable = true`, para a UI oferecer o passo de MFA.
- **Sem permissão:** o item de menu "Relatórios" fica oculto sem `REPORT_VIEW`; a API responde 403 `PERMISSION_DENIED` e grava `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Relatórios são leitura; visões salvas são preferência do usuário. Nenhum evento de domínio. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Relatórios de indicadores

  Background:
    Given que o tenant "Prefeitura A" está ativo com o read model inicializado e "dataAsOf" de 2 minutos atrás
    And as secretarias "Saúde", "Obras" e "Educação" têm processos abertos em 2026
    And "Gil" tem "REPORT_VIEW" com escopo "DEPARTMENT" da secretaria "Saúde" (com subárvore) e não tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    And "Rita" tem "REPORT_VIEW" e "PROCESS_VIEW_CONFIDENTIAL_BUDGET" com escopo "TENANT"
    And "Marta" tem o perfil "ADMIN_ORGAO" sem "REPORT_VIEW"
    And "analytics.fiscalYearStartMonth" é 1

  Scenario: [Sucesso] Catálogo de relatórios da pessoa
    When "Gil" chamar "GET /reports"
    Then a API deve responder 200 com "cycle-time", "returns", "deadline-compliance" e "volume-value"
    And cada item deve trazer título, descrição, agrupamentos aceitos e se "Gil" pode exportar

  Scenario: [Sucesso] Volume e valor do exercício por secretaria
    Given que há 120 processos abertos em 2026, 90 deles da "Saúde"
    When "Rita" chamar "GET /reports/volume-value" com "fiscalYear" 2026, "granularity" "MONTH" e "groupBy" "SECRETARIAT"
    Then a API deve responder 200 com 12 períodos mensais e uma linha por secretaria e mês
    And "totals.openedCount" deve ser 120
    And "meta.dataAsOf", "meta.lagSeconds" e "meta.definitionVersion" devem estar presentes
    And a resposta deve ter "Cache-Control" "private, no-store"

  Scenario: [Sucesso] Tempo de ciclo só conta concluídos
    Given que a "Saúde" tem 10 processos concluídos em março, 5 cancelados e 4 em andamento
    When "Gil" abrir o relatório "cycle-time" para 2026 por mês
    Then "completedCount" de março deve ser 10 e os cancelados não devem entrar na média, na mediana nem no p90
    And "inProgressCount" deve incluir os 4 em andamento
    And "avgBusinessDays" deve ser a soma de "cycleTimeBusinessDays" dividida por 10, em dias úteis, descontadas as pausas

  Scenario: [Sucesso] Mediana e p90 de trimestre vêm dos fatos
    When "Gil" abrir "cycle-time" com "granularity" "QUARTER"
    Then "medianBusinessDays" e "p90BusinessDays" do trimestre devem ser os percentis dos processos concluídos no trimestre
    And "avgBusinessDays" deve ser a soma dos meses dividida pela contagem dos meses, nunca a média das médias

  Scenario: [Sucesso] Devoluções por etapa de origem
    Given que 6 passagens da etapa "TERMO_REFERENCIA" e 2 de "JURIDICO" foram devolvidas em abril na "Saúde", e 40 passagens foram fechadas no mês
    When "Gil" abrir "returns" com "groupBy" "STAGE"
    Then "returnsCount" de "TERMO_REFERENCIA" deve ser 6 e o de "JURIDICO" 2
    And "returnRatePct" do mês deve ser 20,0
    And a rejeição de aprovação ("APPROVAL_REJECTED") não deve contar como devolução

  Scenario: [Sucesso] Cumprimento de prazo
    Given que, em maio, 30 passagens fechadas tinham prazo, 24 saíram no prazo, 6 atrasaram em média 3,50 dias úteis e 5 não tinham prazo
    And há 3 passagens abertas já vencidas
    When "Gil" abrir "deadline-compliance" para maio
    Then "eligibleCount" deve ser 30, "onTimePct" 80,0, "avgOverdueBusinessDays" 3,50 e "noDueCount" 5
    And "totals.openOverdueCount" deve ser 3 e não deve entrar no percentual

  Scenario: [Sucesso] Exercício que começa em julho
    Given que "analytics.fiscalYearStartMonth" é 7
    When "Rita" abrir "volume-value" com "granularity" "FISCAL_YEAR" e "fiscalYear" 2026
    Then o período deve ir de 2026-07 a 2027-06, com rótulo "2026/2027"
    When "Rita" abrir o mesmo relatório com "granularity" "QUARTER"
    Then o primeiro trimestre deve ser julho a setembro de 2026

  Scenario: [Sucesso] Escopo de secretaria
    When "Gil" abrir "volume-value" para 2026
    Then só devem constar processos cuja secretaria solicitante é a "Saúde"
    And "meta.scope.level" deve ser "DEPARTMENTS"
    And a soma não deve incluir processos de "Obras" nem de "Educação"

  Scenario: [Sucesso] Sigilo: soma sem sigilosos e total marcado
    Given que o processo "0014/2026" da "Saúde" tem orçamento sigiloso de "1200000.00" e os demais da "Saúde" somam "3000000.00"
    When "Gil" abrir "volume-value" para 2026
    Then "totals.openedValue" deve ser "3000000.00" e "totals.confidentialExcluded" verdadeiro
    And "meta.confidentialExcluded" deve ser verdadeiro e a tela deve avisar "Inclui valores sigilosos não exibidos"
    And a contagem "openedCount" deve incluir o processo "0014/2026"
    When "Rita" abrir o mesmo relatório
    Then "totals.openedValue" da "Saúde" deve ser "4200000.00" e "confidentialExcluded" falso

  Scenario: [Sucesso] Cobertura parcial do sigilo
    Given que "Paulo" tem "REPORT_VIEW" com escopo "TENANT" e "PROCESS_VIEW_CONFIDENTIAL_BUDGET" só sobre a secretaria "Obras"
    When "Paulo" abrir "volume-value" com "groupBy" "SECRETARIAT"
    Then a linha de "Obras" deve incluir o valor sigiloso e a da "Saúde" não
    And a linha da "Saúde" deve ter "confidentialExcluded" verdadeiro
    And nenhuma medida derivada de valor (média, mínimo ou máximo) deve constar na resposta

  Scenario: [Sucesso] Projetor atrasado marca o resultado
    Given que "dataAsOf" é de 14 minutos atrás
    When "Gil" abrir "cycle-time"
    Then a API deve responder 200 com "meta.stale" verdadeiro e "meta.lagSeconds" acima de 600
    And a tela deve exibir a faixa "A atualização está atrasada"

  Scenario: [Sucesso] Salvar, aplicar e compartilhar uma visão
    When "Gil" salvar a visão "Saúde - ciclo 2026" com "Idempotency-Key" "K1" e "Compartilhar" ativado
    Then a API deve responder 201 com "scope" "REPORT"
    When "Dora", também com "REPORT_VIEW" da secretaria "Educação", aplicar a visão compartilhada
    Then o relatório deve mostrar os dados da "Educação" no escopo dela, não os da "Saúde"

  Scenario: [Sucesso] Meta de desempenho (suíte de performance)
    Given um tenant com 50.000 processos e 600.000 passagens
    When a suíte de performance consultar "volume-value", "returns" e "deadline-compliance" do exercício agrupados por secretaria
    Then o p95 da resposta de "GET /reports/{report}" deve ser de até 2 segundos

  Scenario: [Validação] Filtros e parâmetros inválidos
    When "Gil" chamar "GET /reports/volume-value" com "groupBy" "STAGE"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Gil" chamar "GET /reports/cycle-time" com "fiscalYear" 2026 e "from" "2026-01"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Gil" chamar "GET /reports/cycle-time" com "from" "2020-01" e "to" "2026-12"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Gil" chamar "GET /reports/cycle-time" com "modalityCode" "INEXISTENTE"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Gil" chamar "GET /reports/relatorio-qualquer"
    Then a API deve responder 404 com código "REPORT_NOT_FOUND"

  Scenario: [Validação] Visão salva inválida
    Given que "Gil" já tem uma visão chamada "Saúde - ciclo 2026"
    When "Gil" salvar outra visão com o mesmo nome
    Then a API deve responder 409 com código "CONFLICT"
    Given que "Gil" já tem 20 visões de relatório
    When "Gil" salvar a 21ª
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Gil" salvar uma visão com "filters" sem a versão "v"
    Then a API deve responder 422 com código "VALIDATION_ERROR"

  Scenario: [Validação] Indicadores ainda não preparados
    Given que a "Prefeitura C" não concluiu a carga inicial do read model
    When "Gil" da "Prefeitura C" chamar "GET /reports/volume-value"
    Then a API deve responder 409 com código "ANALYTICS_NOT_READY"
    And "GET /reports" deve continuar respondendo 200

  Scenario: [Permissão] Sem REPORT_VIEW, sem cobertura e sem sigilo
    When "Marta" chamar "GET /reports"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar auditoria "access.denied"
    Given que "Lia" tem "REPORT_VIEW" com escopo "DEPARTMENT" de um setor que não é secretaria
    When "Lia" abrir "volume-value"
    Then a API deve responder 200 com linhas vazias e "meta.scope.level" "NONE"
    Given que "Gil" informa "secretariatId" da "Obras" no filtro
    When "Gil" abrir "volume-value"
    Then a API deve responder 200 sem nenhuma linha de "Obras"
    Given que o sigilo exigiria MFA e a sessão de "Rita" não o tem
    When "Rita" abrir "volume-value"
    Then os valores sigilosos devem ficar excluídos e "meta.confidentialStepUpAvailable" deve ser verdadeiro

  Scenario: [Tenant incorreto] Dados e visões de outro tenant
    Given que a "Prefeitura B" tem a secretaria "Saúde B" e a visão salva "V-9" compartilhada
    When "Rita", da "Prefeitura A", chamar "GET /reports/volume-value" com o "secretariatId" da "Saúde B"
    Then a API deve responder 200 sem nenhuma linha
    When "Rita" aplicar ou alterar a visão "V-9"
    Then a API deve responder 404 com código "NOT_FOUND"
    And as visões compartilhadas e os agregados da "Prefeitura A" não devem conter dados da "Prefeitura B"

  Scenario: [Duplicidade] Reenvio ao salvar a visão
    Given que "Gil" salvou a visão com a chave "K1" e recebeu 201
    When a mesma requisição for reenviada com "K1"
    Then a API deve responder com a mesma visão e o cabeçalho "Idempotent-Replayed: true"
    And deve existir uma única visão com esse nome
    When a chave "K1" for reutilizada com outro corpo
    Then a API deve responder 422 com código "IDEMPOTENCY_KEY_REUSED"

  Scenario: [Concorrência] Refresh das visões durante a leitura
    Given que o job "analytics-refresh" está atualizando "mv_analytics_process_monthly"
    When "Gil" abrir "volume-value"
    Then a resposta deve vir inteira de uma versão da visão, sem mistura de versões
    And "meta.dataAsOf" deve corresponder a essa versão

  Scenario: [Concorrência] Duas visões marcadas como padrão ao mesmo tempo
    When "Gil" marcar duas visões como padrão em requisições simultâneas
    Then exatamente uma deve permanecer como padrão

  Scenario: [Falha de banco] Função de leitura indisponível
    Given que o banco fica indisponível durante a consulta de "GET /reports/volume-value"
    When "Gil" abrir o relatório
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhum dado parcial deve ser devolvido
    And a tela deve oferecer "Tentar novamente"

  Scenario: [Falha de integração] Cache de permissões indisponível
    Given que o Redis do cache de permissões está indisponível
    When "Gil" abrir "volume-value"
    Then a API deve resolver o escopo e a cobertura do sigilo direto no banco
    And responder 200 com o mesmo resultado, apenas mais lenta
    And registrar o log "warn" "permission_cache.unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta o menu; mensagem se acessado por link |
| Relatório inexistente ou fora do catálogo | 404 | `REPORT_NOT_FOUND` | "Relatório não encontrado." | Volta ao catálogo |
| Visão inexistente, de outro tenant ou privada de outro | 404 | `NOT_FOUND` | "Visão não encontrada." | Remove a visão do seletor |
| Nome de visão repetido | 409 | `CONFLICT` | "Você já tem uma visão com este nome." | Realça o campo |
| Indicadores ainda não preparados | 409 | `ANALYTICS_NOT_READY` | "Os indicadores do órgão ainda estão sendo preparados. Tente novamente mais tarde." | Estado vazio explicativo, sem filtros |
| Filtros, período ou agrupamento inválidos | 422 | `VALIDATION_ERROR` | "Alguns filtros são inválidos. Revise a consulta." | Restaura os filtros padrão |
| Limite de visões | 422 | `VALIDATION_ERROR` | "Você atingiu o limite de 20 visões. Exclua uma visão para salvar outra." | Abre "Gerenciar visões" |
| Chave de idempotência reutilizada com corpo diferente | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar o relatório agora. Tente novamente em instantes." | "Tentar novamente"; respeita `Retry-After` |

## Dependências
- **Stories:** US-013 (sigilo do orçamento: `isBudgetConfidential` e a permissão de desmascaramento), US-097 (autorização na API e no frontend: escopos e cobertura), US-171 (reconstrução e reconciliação: fatos corretos e carga inicial) e, por ela, US-170 (fatos, visões e `dataAsOf`). Indiretas: US-003 (padrão de visões salvas), US-076 (padrão de `confidentialExcluded`), US-103 (`analytics.fiscalYearStartMonth` em SCR-041), US-106 (calendário útil), US-101/US-102 (secretarias e subárvore), US-104 (catálogos de modalidade e tipo).
- **Decisões/ADRs:** DEC-024, DEC-030, DEC-031, DEC-088, DEC-184, DEC-196, DEC-205, DEC-206, ADR-014, POL-09, POL-28.
- **Configurações:** `analytics.fiscalYearStartMonth`; `numbering.process.assignOn` (define o início do ciclo); matriz de perfis (`REPORT_VIEW`).
- **Lacunas nas fontes canônicas:**
  1. **Definições dos indicadores (a validar com o piloto):** nenhuma fonte fixava início e fim do ciclo, tratamento de cancelados, devolução, "cumprimento de prazo" e granularidade; as RN-ANL-71 a RN-ANL-78 são **propostas desta story**. Pontos a confirmar: (a) o ciclo vai da abertura até a **conclusão do processo**, o que mede o planejamento na v1 e a fase preparatória inteira na v2 — ciclos de versões diferentes não são comparáveis; alternativa: acrescentar `planningCycleTimeBusinessDays` (abertura até `planningCompletedAt`) ao fato do processo; (b) se a diligência do jurídico deve ser descontada do ciclo (adotado: sim, por ser pausa de SLA); (c) se rejeição de aprovação conta como devolução (adotado: não); (d) se passagem aberta já vencida entra no percentual (adotado: não, só como contagem separada); (e) o exercício fiscal rotulado pelo ano de início.
  2. **Visões salvas de relatório:** `SavedViewScope` (entities.md MVP 1 §3) só tem `PROCESS_LIST` e `INBOX`. Propor `REPORT`, com permissão de leitura `REPORT_VIEW` nas rotas genéricas de visões (PRC-35 a PRC-38) ou nas rotas ANL-07 e ANL-08 mais PRC-37 e PRC-38 para alterar e excluir. **Ajuste em entities.md (MVP 2 §2, enums ampliados) e em api.md.**
  3. **Chaves e medidas das visões:** as visões `mv_analytics_stage_monthly` e `mv_analytics_process_monthly` precisam de `requesting_secretariat_id`, `modality_code` e `contracting_type_code` na chave e de somas e contagens aditivas (ver US-170, lacuna 5); sem isso os filtros e os agrupamentos desta story não saem das visões.
  4. **Funções de leitura adicionais:** `analytics_read_open_overdue` (passagens abertas vencidas agora, sobre `analytics_stage_facts`) e `analytics_read_cycle_percentiles` (mediana e p90 de trimestre e exercício, sobre `analytics_process_facts`) além das três da US-170; ambas `security definer`. **Incluir em entities.md §4.11.**
  5. **Faixa de valor:** o prompt do épico cita "faixa de valor" como possível dimensão; fica fora (RN-ANL-78) por risco de dedução do sigilo. **Dúvida de produto; reavaliar com limites mínimos de grupo.**
  6. **Sigilo parcial por secretaria:** a regra de cobertura (RN-ANL-81) é conservadora; a POL-28 diz "cobrindo o processo". **Confirmar com o piloto.** A exceção da custódia atual (POL-09) não vale em agregados, diferente do dashboard.
  7. **Códigos novos a consolidar no card de API:** `REPORT_NOT_FOUND` (404), `ANALYTICS_NOT_READY` (409); parâmetros, `rows`, `totals` e `meta` de ANL-05 e ANL-06; chaves reservadas `detail`, `saved-views` e `exports`.
  8. **Mistura de v1 e v2 no ciclo:** o relatório não separa processos por versão de workflow; pode ser filtro futuro (`workflowVersionId` já está no fato).

## Impacto técnico
- Maior story de leitura do épico: quatro relatórios, escopo por secretaria, cobertura do sigilo por linha, três granularidades e duas famílias de função de leitura (visão mensal e fatos para percentis). Por isso **L**.
- O sigilo é aplicado **no banco**, na função `security definer` que recebe as secretarias liberadas: o valor sigiloso de secretaria não coberta nunca chega à API, o que elimina o vazamento por erro de camada de serialização.
- Mediana e p90 de trimestre e exercício leem os fatos (`analytics_process_facts`, índice `(tenant_id, year, status)` e `(tenant_id, requesting_secretariat_id, opened_at)`), restritos ao período; é a parte mais sensível à meta de p95 de 2 s e deve ser medida na suíte de performance.
- O resultado depende de `FactBuilder` (US-170) e da reconciliação (US-171); qualquer mudança de definição aqui sobe `INDICATOR_DEFINITION_VERSION` e exige reconstrução.
- Compatibilidade: rotas novas sob `/api/v1/reports`; nenhuma rota do MVP 1 muda; o escopo `REPORT` entra em `SavedViewScope` como valor novo do enum (aditivo, DEC-108).

## Backend
- **Módulo(s):** `analytics` (dono), `access` (escopos e cobertura do sigilo), `organization` (secretarias e subárvore), `catalog` (modalidades, tipos e rótulos), `process` (porta de `SavedView`), `platform`.
- **Casos de uso:** `GetReportCatalogQuery` (ANL-05), `GetReportQuery` (ANL-06), `ListReportSavedViewsQuery` (ANL-07), `CreateReportSavedViewCommand` (ANL-08).
- **Domínio:** `ReportRegistry` e `ReportDefinition` (medidas, agrupamentos e função de leitura por relatório), `FiscalCalendar` (exercício, trimestre, rótulos), `ReportFilters` (validação e interseção com o escopo), `ReportScopeResolver`, `ConfidentialCoverageResolver`, `ReportAssembler` (linhas, totais, séries contínuas, vazios), `IndicatorDefinitions` (US-170), `ReportViewFiltersSchema`.
- **Integrações internas:** `AccessFacade` (escopos de `REPORT_VIEW` e de sigilo), `OrganizationFacade`, `CatalogFacade`, `SettingsFacade` (`analytics.fiscalYearStartMonth`), `SavedViewFacade` (módulo `process`), `AnalyticsReadRepository` (funções `security definer`).
- **Transação:** leitura em transação `READ ONLY` com `app.tenant_id`; uma única consulta por relatório (mais a de percentis, quando couber); salvar visão = escrita simples com idempotência.

## Frontend
- **Tela(s):** SCR-027 (`/relatorios`), com o relatório e os filtros na URL; o detalhamento (SCR-028) é aberto pela ação "Ver processos" (US-173).
- **Componentes:** `ReportSelector`, `ReportFiltersBar` (período, granularidade, secretaria, modalidade, tipo, agrupar por), `FreshnessBadge` (reuso da US-170), `ReportKpiCards`, `ReportChart` (barras e linhas), `ReportDataTable` (equivalente textual do gráfico), `ConfidentialNotice`, `ScopeEmptyState`, `SavedViewsMenu` e `SaveViewDialog` (padrão da US-003), `StaleBanner`.
- **Estados:** loading (skeleton dos cartões e do gráfico), vazio (sem dados no recorte; escopo sem cobertura), erro com "Tentar novamente", não preparado (`ANALYTICS_NOT_READY`), atrasado (faixa), sucesso.
- **Acessibilidade e responsividade:** o gráfico tem tabela equivalente e descrição textual; cores de séries com padrão ou rótulo, nunca só cor; filtros e tabela navegáveis por teclado; `aria-live="polite"` ao recarregar; abaixo de 768 px os filtros viram painel recolhível e a tabela, lista de cartões; números formatados em pt-BR (vírgula decimal, milhar com ponto).

## Banco de dados
- **Tabelas:** leitura de `analytics_process_facts`, `analytics_stage_facts` e das visões `mv_analytics_process_monthly` e `mv_analytics_stage_monthly` (só por funções); escrita em `saved_views` (módulo `process`) para visões.
- **Migrações:** funções `analytics_read_open_overdue` e `analytics_read_cycle_percentiles` (`security definer`, `search_path` fixo, tenant da sessão); novo valor `REPORT` no enum `SavedViewScope` (ajuste de `CHECK`/enum e do índice de compartilhadas); `GRANT EXECUTE` a `cf_app`.
- **Índices/constraints relevantes:** os já criados na US-170 para os fatos e as chaves únicas das visões; `saved_views` mantém as unicidades `(tenant_id, owner_id, scope, lower(name))` e a de visão padrão por dono e escopo.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `ANL-05` | GET | `/api/v1/reports` | — | `200 { data: ReportDefinition[] }` (`key`, `title`, `description`, `groupBys[]`, `granularities[]`, `canExport`) | 200, 403 |
| `ANL-06` | GET | `/api/v1/reports/{report}` | `granularity`, `fiscalYear` ou `from`/`to`, `secretariatId[]`, `modalityCode[]`, `contractingTypeCode[]`, `groupBy` | `200 { data: { report, granularity, period, groupBy, rows[], totals, groupTotals[] }, meta { dataAsOf, lagSeconds, stale, confidentialExcluded, confidentialStepUpAvailable, scope, groupsTruncated, definitionVersion } }` | 200, 403, 404, 409, 422, 503 |
| `ANL-07` | GET | `/api/v1/reports/saved-views` | `report?` | `200 { data: SavedView[] }` (próprias e compartilhadas, `scope = REPORT`) | 200, 403 |
| `ANL-08` | POST | `/api/v1/reports/saved-views` | `Idempotency-Key`; `{ name, filters, isDefault, isShared }` | `201 { data: SavedView }` + `ETag` | 201, 403, 409, 422 |

Alteração e exclusão de visão usam PRC-37 e PRC-38 (US-003) com `scope = REPORT` (lacuna 2).

## Logs
- `info` `report.query_served` — `report`, `granularity`, `groupBy`, `rowsCount`, `scopeLevel`, `confidentialExcluded`, `stale`, `durationMs`, `correlationId`.
- `warn` `report.stale_served` — `lagSeconds`; `warn` `permission_cache.unavailable` — `fallback` (`DB`).
- `warn` `report.groups_truncated` — `report`, `groupBy`.
- `info` `report.saved_view_created` — `viewId`, `isShared`.
- `error` `report.query_failed` — `report`, `errorClass`.
- **Nunca logar:** valores monetários, filtros com ids de secretaria em texto livre, nomes de secretaria, conteúdo da visão além do id.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `access.denied` | `ACCESS` | 403 em qualquer rota da story | `reasonCode`, `route` |

A consulta de relatório agregado não gera auditoria própria (a auditoria de acesso `report.view_detail` é do detalhamento, US-173, e `report.export` da exportação, US-174). Criar, alterar e excluir visão salva seguem o padrão da US-003 (preferência do usuário, sem auditoria de dado).

## Testes necessários
- **Unitários:** `FiscalCalendar` (início em janeiro e em julho, trimestres, rótulos, virada de exercício); definições (cada RN-ANL-71 a RN-ANL-77 com casos de borda: cancelado, rascunho, concluído sem pausas, devolução × rejeição, sem prazo, vencida aberta); `ReportAssembler` (série contínua, razão com denominador 0, ordem dos grupos, truncamento em 200); `ConfidentialCoverageResolver` (`TENANT`, `ORGANIZATION`, `DEPARTMENT` com e sem subárvore, cobertura parcial); `ReportFilters` (interseção com o escopo, limites).
- **Integração (Testcontainers):** cada relatório contra fatos e visões reais com refresh; paridade número × soma dos fatos; sigilo por secretaria (valor sigiloso de secretaria não coberta não sai da função); escopo por secretaria; percentis de trimestre; visões salvas com `scope = REPORT`; `ANALYTICS_NOT_READY`; leitura concorrente com refresh.
- **API/contrato:** ANL-05 a ANL-08 (corpo, filtros, erros, `Cache-Control`, `Idempotent-Replayed`); ausência de valores sigilosos e de medidas derivadas de valor em qualquer resposta.
- **RBAC e multi-tenant:** 403 e 404 por papel e tenant; escopos `TENANT`, `ORGANIZATION`, `DEPARTMENT`, `OWN_DEPARTMENTS`; sigilo total, parcial e ausente; teste novo na suíte `test/tenant-leak` (agregados, filtros com ids de outro tenant, visões compartilhadas); teste de arquitetura de que nenhum código de `analytics` lê `ProcessStage`/`ProcessMovement` (RN-ANL-86).
- **Concorrência:** refresh durante leitura; duas visões padrão simultâneas; criação de visão com a mesma chave de idempotência em paralelo.
- **E2E (Playwright):** o gestor abre Relatórios, troca de relatório e de exercício, agrupa por secretaria, vê o aviso de sigilo e a data de atualização, salva e reaplica uma visão; perfil sem cobertura vê o estado vazio.
- **Acessibilidade/performance:** axe em SCR-027 (gráfico, tabela, filtros, diálogo); p95 ≤ 2 s do relatório do exercício na suíte de performance, medido no endurecimento e nunca no card.

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
- [ ] Teste prova que nenhum relatório lê `ProcessStage`/`ProcessMovement` e que a API não tem `SELECT` direto nas visões
- [ ] Teste prova que valor sigiloso de secretaria não coberta nunca sai do banco, inclusive por diferença entre recortes
- [ ] Definições RN-ANL-71 a RN-ANL-78 publicadas no tooltip "Como é calculado" e validadas com o piloto
- [ ] Meta de p95 ≤ 2 s registrada como teste da suíte de performance
- [ ] Lacunas 1 a 8 resolvidas ou registradas nas fontes canônicas

## Estimativa
**L** — quatro relatórios com definições próprias, três granularidades com exercício configurável, escopo por secretaria, cobertura do sigilo aplicada no banco, funções de leitura adicionais, visões salvas e a tela SCR-027 com gráfico, tabela e filtros; o esforço está na fidelidade das definições, no sigilo e na meta de latência.

## Prioridade
**P1** — é a entrega visível do épico e o instrumento de governança do art. 11, parágrafo único; sustenta as metas E3 e Q1 do roadmap e é pré-requisito do detalhamento, da exportação, da execução do PCA e dos gargalos.

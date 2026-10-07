---
id: US-002
title: "Listar, pesquisar, filtrar e ordenar processos"
epic: EP-001
feature: FT-002
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-001, US-097]
modules: [process, access, workflow, catalog, organization, identity]
screens: [SCR-004]
endpoints: [PRC-01, TAG-01, CAT-01, ORG-01, DEP-02, USR-02, ME-02, ME-03]
permissions: [PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: []
---

# US-002 — Listar, pesquisar, filtrar e ordenar processos

## Título
Listar, pesquisar, filtrar e ordenar processos

## Descrição
**Como** gestor de contratações (e qualquer servidor que acompanha processos), **quero** encontrar em segundos os processos que posso ver — combinando busca textual, filtros, atalhos e ordenação —, **para** saber onde cada um está, com quem, o que está atrasado e o que depende de mim, sem planilhas paralelas.

A tela **Processos** (SCR-004) apresenta uma tabela paginada no servidor (TanStack Table em modo manual) com colunas escolhidas pelo usuário, busca por código/título/objeto, painel de filtros, atalhos ("Comigo", "Da minha unidade", "Atrasados", "Devolvidos") e chips dos filtros ativos. O estado da consulta fica na URL (link compartilhável). A API aplica sempre o predicado de visibilidade (permissions.md §5) e o mascaramento do orçamento sigiloso (POL-09) — inclusive no filtro e na ordenação por valor, que nunca podem revelar um valor mascarado.

## Contexto
- Hoje o controle é feito em planilhas desatualizadas: o gestor não sabe onde cada processo parou (persona P02) e o requisitante telefona para saber o andamento (P03).
- Decisões aplicadas: visibilidade por `ProcessAccess` (DEC-024), busca FTS + trigram (DEC-057), paginação/ordenação/filtros (DEC-106), mascaramento central (DEC-030, POL-09), prazos e atrasos (DEC-031), caixa de tarefas como consulta distinta (DEC-026), acessibilidade (DEC-183) e linguagem (DEC-184).
- Os parâmetros desta lista formam o **contrato de filtros** reutilizado pelas visões salvas e pela exportação (US-003), pelos links do dashboard (US-076 — "todo número do dashboard leva à lista filtrada") e por links de notificações.
- Esta story define o DTO calculado de prazo (`deadline`), reutilizado no painel situacional (US-004).

## Objetivo
Entregar uma consulta de processos que responda em **p95 < 800 ms com 100 mil processos por tenant** nas 10 combinações de filtros mais usadas, sem nenhum vazamento de processo não visível ou de valor sigiloso (comprovado por testes de matriz de visibilidade e de mascaramento) e com o estado da consulta 100% reproduzível pela URL.

## Persona
- **Principal:** Gestor de contratações (perfil `GESTOR_CONTRATACOES`, escopo `TENANT`).
- **Secundárias:** Área requisitante (`REQUISITANTE`, `OWN_DEPARTMENTS` — "meus processos"); Planejamento (`PLANEJAMENTO`); Compras (`COMPRAS`); Autoridade competente (`AUTORIDADE_COMPETENTE`); Controle Interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`), com leitura ampla; Usuário somente leitura (`SOMENTE_LEITURA`); Consultoria externa (`CONSULTOR_EXTERNO`), que vê apenas os processos em que participa.

## Pré-condições
- Usuário autenticado (US-087), tenant `ACTIVE`, vínculo `ACTIVE` e não expirado.
- Usuário possui `PROCESS_VIEW` em algum escopo **ou** ao menos uma concessão `ProcessAccess` do tipo `USER` ativa (criador, responsável, participante, aprovador — DEC-024, condição 4).
- Autorização com escopos efetivos disponível (US-097); processos existentes (US-001).
- Catálogos, unidades e etiquetas cadastrados (US-104, US-102, US-007) alimentam as opções dos filtros; a lista funciona sem eles.

## Fluxo principal
1. O usuário acessa **Processos** no menu (ou abre um link com filtros). O front abre SCR-004 (`/processos`).
2. Se a URL não tiver parâmetros, o front aplica a visão padrão do usuário (US-003, quando existir) ou o padrão da tela: status "Em andamento" (RN-PROC-30), ordenação `-updatedAt`, 20 itens por página e as colunas salvas do usuário (RN-PROC-32).
3. O front valida os parâmetros da URL com `processListQuerySchema` (Zod, em `packages/validation`) — descarta os inválidos com aviso — e dispara em paralelo `GET /api/v1/processes` (PRC-01) e as leituras de apoio às opções de filtro: catálogos (`CAT-01` para `CONTRACTING_TYPE`, `MODALITY`, `PROCESS_ORIGIN`), órgãos (`ORG-01`), unidades (`DEP-02`), etiquetas (`TAG-01`), usuários sob demanda no filtro "Responsável" (`USR-02`) e opções de etapa (`includeStageOptions=true` na primeira chamada — ver lacunas).
4. A API, em transação somente leitura com `app.tenant_id` definido:
   1. valida a query string (Zod) e expande os escopos efetivos de `PROCESS_VIEW` do vínculo (subárvores e lotações);
   2. compõe o predicado de visibilidade (RN-PROC-19) com os filtros (RN-PROC-20 a RN-PROC-24) e a busca (RN-PROC-26);
   3. calcula, por linha, se o usuário atende POL-09 e aplica a regra de valor sigiloso em filtro e ordenação (RN-PROC-25);
   4. executa a página e a contagem total no mesmo snapshot;
   5. serializa pelo `ProcessListPresenter` (mascaramento central e DTO `deadline`).
5. A API responde **200** com `data` e `meta { page, pageSize, totalItems, totalPages }`.
6. O front renderiza a tabela com as colunas escolhidas, os chips dos filtros ativos, o total ("137 processos") e a paginação; um `aria-live` anuncia "137 processos encontrados".
7. O usuário digita na busca: após 300 ms sem digitação e com ≥ 2 caracteres, o front atualiza a URL (`replaceState`) e refaz a consulta mantendo os resultados anteriores visíveis com indicador de carregamento.
8. O usuário aciona um atalho (ex.: **Atrasados**), abre o painel **Filtros** e combina critérios, ou clica no cabeçalho de uma coluna ordenável; cada mudança atualiza a URL e volta à página 1.
9. O usuário escolhe colunas em **Colunas**; a escolha é aplicada imediatamente e persistida (RN-PROC-32).
10. O usuário clica em uma linha (link) e abre o detalhe do processo (SCR-006); Ctrl/Cmd+clique abre em nova aba; ao voltar, a lista restaura filtros, página e posição de rolagem.

## Fluxos alternativos
- **FA-01 — Nenhum resultado:** empty state "Nenhum processo encontrado com estes filtros." com os botões "Limpar filtros" e, se houver busca com filtro de status, "Buscar em todos os status".
- **FA-02 — Nenhum processo visível:** "Você ainda não tem processos para acompanhar." + botão "Novo processo" (se `PROCESS_CREATE`); para vínculos `EXTERNAL`: "Você ainda não participa de nenhum processo neste órgão." (sem botão).
- **FA-03 — Link compartilhado:** quem abre um link com filtros vê apenas os processos que **ele** pode ver; IDs que não existem para o tenant ou não são visíveis simplesmente não casam (RN-PROC-20); parâmetros inválidos são descartados pelo front com o aviso "Alguns filtros do link eram inválidos e foram ignorados."
- **FA-04 — Busca por código:** `q = "12/2026"` encontra `0012/2026` por trigram; correspondência exata de `code` ou `internalCode` aparece primeiro e destacada (RN-PROC-26). Não há redirecionamento automático para o processo.
- **FA-05 — Filtro por valor sem POL-09:** processos sigilosos cujo valor o usuário não pode ver ficam **fora** do resultado (RN-PROC-25). A nota "Processos com orçamento sigiloso que você não pode ver não entram no filtro por valor." é exibida sempre que o filtro de valor estiver ativo e o usuário não tiver `PROCESS_VIEW_CONFIDENTIAL_BUDGET` com escopo `TENANT` — sem indicar se algum processo específico foi excluído.
- **FA-06 — Ordenação por valor sem POL-09:** valores mascarados ordenam como nulos (sempre ao final) e são exibidos como "Sigiloso", com ícone de cadeado.
- **FA-07 — Sem responsável:** "Responsável → Sem responsável" (`currentResponsibleId=none`) lista processos na fila da unidade; a coluna mostra "Na fila de {unidade}".
- **FA-08 — Tenant com vários órgãos:** aparecem o filtro "Órgão/entidade" e a coluna "Órgão"; com um único órgão ambos ficam ocultos.
- **FA-09 — Mobile (< 768 px):** a tabela vira lista de cartões (código, título, status, etapa, responsável e badge de prazo); os filtros abrem em painel inferior; a escolha de colunas não se aplica.
- **FA-10 — Sessão expirada:** 401 `SESSION_EXPIRED` → login e retorno à mesma URL, com filtros preservados.
- **FA-11 — "Comigo" × caixa de tarefas:** "Comigo" mostra processos em que sou o responsável atual; aprovações pendentes para mim ficam na caixa de tarefas (US-056). Com o atalho ativo, a tela exibe o link "Ver minhas aprovações pendentes".
- **FA-12 — Step-up de MFA para valores sigilosos:** quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` mas está em sessão sem MFA exigida pela política vê os valores mascarados e o aviso "Confirme sua identidade para ver valores sigilosos." com o botão que inicia o step-up (`/api/auth/step-up`).

## Regras de negócio
- **RN-PROC-19** — Visibilidade: a lista retorna somente processos com `deleted_at IS NULL` que satisfazem o predicado de permissions.md §5 com os escopos efetivos de `PROCESS_VIEW` do vínculo (expandidos com subárvore e lotações) e as concessões `USER` ativas do próprio usuário; o acesso histórico de unidades segue `access.historicalDepartmentsCanView`. Um processo nunca é retornado por ser referenciado em um filtro.
- **RN-PROC-20** — Filtros diferentes combinam-se com **E**; valores múltiplos de um mesmo filtro (separados por vírgula) combinam-se com **OU** (DEC-106). A lista de filtros é fechada (tabela "Campos"); parâmetros desconhecidos são ignorados. IDs inexistentes, de outro tenant ou não visíveis não geram erro — apenas não casam.
- **RN-PROC-21** — Valores reservados: `currentResponsibleId=me` (o próprio usuário) e `none` (sem responsável); `currentDepartmentId=mine` (unidades de lotação ativas do vínculo, sem subárvore); `modalityId=none` (modalidade "A definir"). Podem ser combinados com UUIDs no mesmo parâmetro (OU).
- **RN-PROC-22** — Etapa: `stageKey` casa a etapa atual pela chave (`WorkflowStage.key`) em qualquer versão de workflow (ex.: `ABERTURA` da v1 e da v2); `currentWorkflowStageId` filtra a etapa exata de uma versão.
- **RN-PROC-23** — Atrasado (`overdue=true`): status `DRAFT`, `IN_PROGRESS`, `AWAITING_APPROVAL` ou `RETURNED` **e** (`overdueSince IS NOT NULL` **ou** `currentStageDueAt < agora`). Processos `SUSPENDED` (prazo pausado) e em status final nunca são "atrasados". Prazo alvo vencido (`targetDateOverdue=true`): `targetDate` anterior a hoje no fuso do tenant e status não final (DEC-031).
- **RN-PROC-24** — Atalhos são predefinições de filtros, combináveis entre si e com os demais filtros: **Comigo** = `currentResponsibleId=me`; **Da minha unidade** = `currentDepartmentId=mine`; **Atrasados** = `overdue=true`; **Devolvidos** = `status=RETURNED`. Ativar um atalho substitui o valor do filtro correspondente; desativá-lo remove esse filtro.
- **RN-PROC-25** — Valor estimado × sigilo (POL-09): para processo com `isBudgetConfidential = true` em que o usuário não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo nem detém a custódia atual, (a) o valor é retornado `null` com `estimatedValueMasked = true`; (b) qualquer consulta com `estimatedValueMin`/`estimatedValueMax` **exclui** o processo, independentemente do valor real; (c) na ordenação por `estimatedValue` o valor é tratado como nulo (sempre ao final). O valor real nunca participa de comparação observável (filtro, ordenação ou contagem).
- **RN-PROC-26** — Busca `q`: 2 a 200 caracteres após trim; casa por FTS (`websearch_to_tsquery('portuguese', cf_unaccent(q))` sobre `search_vector`, que cobre código, código interno, título, objeto e descrição) **ou** por similaridade trigram ≥ 0,3 em `code`/`title`. Relevância: correspondência exata de `code`/`internalCode` > `ts_rank_cd` > similaridade.
- **RN-PROC-27** — Ordenação: campos permitidos `updatedAt`, `createdAt`, `openedAt`, `code` (por `year`, `number`; sem número ao final), `title`, `priority` (URGENT > HIGH > MEDIUM > LOW), `status`, `currentStageDueAt`, `targetDate`, `estimatedValue`; prefixo `-` = decrescente; até 3 campos. Padrão `-updatedAt`; com `q` e sem `sort` explícito, relevância. Desempate final sempre por `id` decrescente (paginação determinística).
- **RN-PROC-28** — Paginação: `page ≥ 1` e `pageSize` de 1 a 100 (padrão 20); página além do total retorna `data: []` com `meta` correto.
- **RN-PROC-29** — Etapa, unidade e responsável exibidos são os campos desnormalizados do processo (`currentWorkflowStageId`, `currentDepartmentId`, `currentResponsibleId`, `currentStageDueAt`, `overdueSince`), atualizados na mesma transação de cada tramitação: a lista nunca mostra combinação parcial (ex.: etapa nova com unidade antiga).
- **RN-PROC-30** — Padrão da tela: sem parâmetros na URL e sem visão padrão (US-003), a tela aplica status "Em andamento" = `DRAFT`, `IN_PROGRESS`, `AWAITING_APPROVAL`, `RETURNED`, `SUSPENDED` (chip removível). A API, sem filtro de status, retorna todos os status, inclusive finais.
- **RN-PROC-31** — Datas: `createdFrom`/`createdTo` e `targetDateFrom`/`targetDateTo` são datas `YYYY-MM-DD` inclusivas interpretadas no fuso do tenant (`createdTo = 2026-10-05` inclui até 23:59:59 local).
- **RN-PROC-32** — Colunas: "Código" e "Título" são fixas; as demais são escolhidas pelo usuário e persistidas em `User.preferences` sob a chave `processList.<tenantId>.columns` (via ME-02), com contingência local (`localStorage`) se a gravação falhar. Colunas sem dados aplicáveis ao tenant (ex.: "Órgão" com um único órgão) não são oferecidas.
- **RN-PROC-33** — `isBudgetConfidential` é sempre exibido (badge "Orçamento sigiloso"): o fato de o orçamento ser sigiloso não é sigiloso (art. 24 da Lei 14.133/2021 exige justificativa pública do sigilo); somente os valores são mascarados.

## Campos
**Filtros (query string de PRC-01)**

| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Busca | `q` | texto | Não | 2–200 caracteres; RN-PROC-26 | — |
| Status | `status` | multi (`ProcessStatus`) | Não | enum | "Em andamento" na UI (RN-PROC-30) |
| Etapa | `stageKey` / `currentWorkflowStageId` | multi (chave) / multi (uuid) | Não | RN-PROC-22 | — |
| Unidade atual | `currentDepartmentId` | multi (uuid ou `mine`) | Não | RN-PROC-21 | — |
| Secretaria solicitante | `requestingSecretariatId` | multi (uuid) | Não | rótulo por `labels.secretariat` | — |
| Setor solicitante | `requestingDepartmentId` | multi (uuid) | Não | rótulo por `labels.department` | — |
| Órgão/entidade | `organizationId` | multi (uuid) | Não | exibido só com mais de um órgão | — |
| Responsável | `currentResponsibleId` | multi (uuid, `me`, `none`) | Não | RN-PROC-21; ausente = qualquer | qualquer |
| Prioridade | `priority` | multi (`Priority`) | Não | enum | — |
| Tipo de contratação | `contractingTypeId` | multi (uuid, `CONTRACTING_TYPE`) | Não | itens ativos e inativos | — |
| Modalidade | `modalityId` | multi (uuid ou `none`) | Não | catálogo `MODALITY` | — |
| Origem | `originId` | multi (uuid, `PROCESS_ORIGIN`) | Não | — | — |
| Ano | `year` | multi (int) | Não | 2000–2100 | — |
| Etiquetas | `tagId` | multi (uuid) | Não | OU entre etiquetas | — |
| Atrasados | `overdue` | booleano | Não | RN-PROC-23 | — |
| Prazo alvo vencido | `targetDateOverdue` | booleano | Não | RN-PROC-23 | — |
| Criado entre | `createdFrom`, `createdTo` | data | Não | início ≤ fim; RN-PROC-31 | — |
| Prazo alvo entre | `targetDateFrom`, `targetDateTo` | data | Não | início ≤ fim | — |
| Valor estimado entre | `estimatedValueMin`, `estimatedValueMax` | decimal (string) | Não | ≥ 0; 2 casas; mín. ≤ máx.; RN-PROC-25 | — |
| Ordenação | `sort` | texto | Não | RN-PROC-27 | `-updatedAt` |
| Página / itens por página | `page`, `pageSize` | int | Não | RN-PROC-28 | 1 / 20 |
| *(técnico)* Opções de etapa | `includeStageOptions` | booleano | Não | ver lacunas | `false` |

**Colunas da tabela**

| Coluna | Campo da resposta | Ordenável | Padrão |
|---|---|---|---|
| Código | `code` (ou "Rascunho (sem número)") | sim (`code`) | fixa |
| Título | `title` | sim | fixa |
| Status | `status` (rótulo da terminologia) | sim | visível |
| Etapa | `currentStage.name` | não | visível |
| Unidade atual | `currentDepartment.name` | não | visível |
| Responsável | `currentResponsible.name` ou "Na fila de {unidade}" | não | visível |
| Prazo da etapa | `deadline` (badge) | sim (`currentStageDueAt`) | visível |
| Prioridade | `priority` | sim | visível |
| Secretaria / Setor solicitante | `requestingSecretariat.name` / `requestingDepartment.name` | não | oculta |
| Tipo de contratação / Modalidade / Origem | `contractingType.label` / `modality.label` ("A definir") / `origin.label` | não | oculta |
| Valor estimado | `estimatedValue` ou "Sigiloso" | sim | oculta |
| Prazo alvo | `targetDate` | sim | oculta |
| Etiquetas | `tags[]` | não | oculta |
| Código interno / Órgão | `internalCode` / `organization.shortName` | não | oculta |
| Criado em / Atualizado em | `createdAt` / `updatedAt` | sim | oculta |

**DTO calculado `deadline` (não persistido; reutilizado em US-004)**

| Campo | Tipo | Regra |
|---|---|---|
| `dueAt` | ISO 8601 UTC \| null | `currentStageDueAt` (fim do dia no fuso do tenant) |
| `slaType` | `DayCountType` \| null | snapshot da etapa ativa |
| `daysLeft` | int \| null | dias até `dueAt` na unidade do `slaType` (0 = vence hoje); nulo sem prazo ou se atrasado |
| `overdueDays` | int \| null | dias decorridos após `dueAt` (mesma unidade), contando hoje se for dia útil; nulo se não atrasado |
| `isDueSoon` | boolean | dias úteis restantes entre 0 e `deadlines.warnBeforeBusinessDays` |
| `isOverdue` | boolean | RN-PROC-23 |
| `isPaused` | boolean | etapa ativa com `pausedAt` preenchido (processo suspenso) |

Rótulos do badge (ícone + texto, nunca só cor): "No prazo", "Vence em N dias úteis" (ou "dias" se `CALENDAR`), "Vence hoje", "Atrasado há N dias úteis", "Prazo pausado", "Sem prazo".

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Valor fora do enum em `status`/`priority` | Front (descarta) + API (Zod) | "Alguns filtros eram inválidos e foram ignorados." | `VALIDATION_ERROR` |
| V-02 | UUID malformado em filtro | Front + API | idem | `VALIDATION_ERROR` |
| V-03 | `q` com menos de 2 ou mais de 200 caracteres | Front (não envia) + API | "Digite ao menos 2 caracteres para buscar." | `VALIDATION_ERROR` |
| V-04 | `page < 1` ou `pageSize` fora de 1–100 | API | "Página inválida." | `VALIDATION_ERROR` |
| V-05 | `sort` com campo não permitido ou mais de 3 campos | API | "Ordenação inválida." | `VALIDATION_ERROR` |
| V-06 | Intervalo de datas invertido | Front + API | "A data inicial deve ser anterior ou igual à final." | `VALIDATION_ERROR` |
| V-07 | Valor negativo, com mais de 2 casas ou mínimo > máximo | Front + API | "Informe valores válidos, com até 2 casas decimais." | `VALIDATION_ERROR` |
| V-08 | Mais de 50 valores em um filtro multivalorado | Front + API | "Selecione no máximo 50 opções por filtro." | `VALIDATION_ERROR` |
| V-09 | `year` fora de 2000–2100 | Front + API | "Informe um ano válido." | `VALIDATION_ERROR` |

## Permissões
- **Permissão:** `PROCESS_VIEW` em qualquer escopo **ou** ao menos uma concessão `USER` ativa em `ProcessAccess` (DEC-024, condição 4; permissions.md §7). O resultado é sempre restrito pelo predicado de visibilidade (RN-PROC-19): o escopo define o que aparece, não apenas se a rota abre.
- **Orçamento sigiloso:** `PROCESS_VIEW_CONFIDENTIAL_BUDGET` com escopo que cubra o processo, ou custódia atual, desmascara o valor linha a linha (POL-09, RN-PROC-25).
- **Políticas:** POL-09. Nenhuma política de custódia (consulta).
- **MFA:** `PROCESS_VIEW` (`L`) não exige. `PROCESS_VIEW_CONFIDENTIAL_BUDGET` é `H`: se `security.mfaPolicy` exigir e a sessão não tiver MFA, a permissão **não é considerada** para desmascarar (valores mascarados, sem 403) e a UI oferece o step-up (FA-12).
- **Sem permissão:** menu "Processos" oculto; a rota `/processos` exibe SCR-111 (403); a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Consulta somente leitura: nenhum evento de domínio é emitido. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Listar, pesquisar, filtrar e ordenar processos

  Background:
    Given que o tenant "Prefeitura de São José" está ativo e hoje é "2026-10-05" no fuso "America/Sao_Paulo"
    And existem os processos:
      | código    | título                                       | status            | etapa                | unidade atual       | responsável | prioridade | sigiloso | valor estimado | setor solicitante   |
      | 0012/2026 | Aquisição de cimento para manutenção de vias | IN_PROGRESS       | PESQUISA_PRECOS      | Setor de Cotações   | —           | HIGH       | não      | 85000.00       | Setor de Manutenção |
      | 0031/2026 | Contratação de limpeza hospitalar            | RETURNED          | ESTUDOS_PRELIMINARES | Setor de Manutenção | Ana         | MEDIUM     | sim      | 1200000.00     | Setor de Manutenção |
      | 0045/2026 | Aquisição de medicamentos da farmácia básica | AWAITING_APPROVAL | APROVACAO_DFD        | Secretaria de Saúde | —           | URGENT     | não      | —              | Farmácia Básica     |
    And o prazo da etapa do processo "0045/2026" venceu em "2026-09-30"
    And "Patrícia" possui o perfil "GESTOR_CONTRATACOES" com escopo "TENANT"
    And "Ana" possui o perfil "REQUISITANTE" com escopo "OWN_DEPARTMENTS" e lotação no "Setor de Manutenção"

  Scenario: [Sucesso] Gestor combina filtros e ordenação
    When "Patrícia" filtrar por status "IN_PROGRESS,RETURNED" e ordenar por "-priority"
    Then a API deve responder 200 com os processos "0012/2026" e "0031/2026", nesta ordem
    And "meta.totalItems" deve ser 2
    And o processo "0031/2026" deve exibir o valor estimado "R$ 1.200.000,00" com o badge "Orçamento sigiloso"
    And a URL deve conter "status=IN_PROGRESS%2CRETURNED&sort=-priority"

  Scenario: [Sucesso] Atalho "Atrasados" com badge de prazo
    When "Patrícia" acionar o atalho "Atrasados"
    Then a lista deve conter somente o processo "0045/2026"
    And o processo deve exibir o badge "Atrasado há 3 dias úteis" com ícone e texto
    And o campo "deadline.overdueDays" da resposta deve ser 3

  Scenario: [Sucesso] Atalho "Comigo" e busca por código parcial
    When "Ana" acionar o atalho "Comigo"
    Then a lista deve conter somente o processo "0031/2026"
    When "Ana" remover o atalho e buscar "12/2026"
    Then o primeiro resultado deve ser o processo "0012/2026"

  Scenario: [Validação] Busca curta e ordenação não permitida
    When "Patrícia" digitar "a" no campo de busca
    Then nenhuma consulta deve ser enviada e o sistema deve exibir "Digite ao menos 2 caracteres para buscar."
    When a API receber "GET /api/v1/processes?sort=internalNotes"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro no campo "sort"

  Scenario: [Permissão] Requisitante vê apenas processos visíveis para suas lotações
    When "Ana" abrir a lista de processos sem filtros de status
    Then a lista deve conter "0012/2026" e "0031/2026"
    And não deve conter "0045/2026"
    When "Ana" filtrar por "requestingDepartmentId" do setor "Farmácia Básica"
    Then a API deve responder 200 com "data" vazio e "meta.totalItems" igual a 0

  Scenario: [Permissão] Valor sigiloso não vaza em filtro nem em ordenação
    Given que "Tatiane" possui o perfil "SOMENTE_LEITURA" com escopo "ORGANIZATION" e não possui "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    When "Tatiane" abrir a lista de processos
    Then o processo "0031/2026" deve ter "estimatedValue" nulo e "estimatedValueMasked" verdadeiro e exibir "Sigiloso"
    When "Tatiane" filtrar por valor estimado mínimo "1000000.00"
    Then a lista deve vir vazia e a nota "Processos com orçamento sigiloso que você não pode ver não entram no filtro por valor." deve ser exibida
    When "Tatiane" ordenar por "-estimatedValue"
    Then o processo "0012/2026" deve ser o primeiro e o "0031/2026" deve aparecer entre os últimos, sem valor

  Scenario: [Permissão] Usuário sem PROCESS_VIEW e sem concessões
    Given que o usuário "Carlos" não possui "PROCESS_VIEW" nem concessões "ProcessAccess" do tipo "USER"
    When "Carlos" enviar "GET /api/v1/processes"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "PROCESS_VIEW"

  Scenario: [Permissão] Consultor externo vê somente processos em que participa
    Given que "Bruno" possui vínculo "EXTERNAL", o perfil "CONSULTOR_EXTERNO" e participação "CONSULTANT" ativa apenas no processo "0031/2026"
    When "Bruno" abrir a lista de processos
    Then a lista deve conter somente o processo "0031/2026"
    And o valor estimado deve estar mascarado, pois participação não concede POL-09

  Scenario: [Tenant incorreto] Filtro com unidade de outro tenant
    Given que existe o setor "Setor X" no tenant "Prefeitura B" com processos
    When "Patrícia" filtrar por "currentDepartmentId" do "Setor X"
    Then a API deve responder 200 com "data" vazio
    And a resposta não deve revelar a existência do "Setor X" nem de processos da "Prefeitura B"
    When "Patrícia" enviar a consulta com "X-Tenant-Id" de um tenant em que não possui vínculo
    Then a API deve responder 403 com código "MEMBERSHIP_INACTIVE"

  Scenario: [Duplicidade] Processo com várias concessões e etiquetas aparece uma única vez
    Given que o processo "0012/2026" tem concessões "REQUESTING", "HISTORICAL" e "CREATOR" para "Ana" e 3 etiquetas
    When "Ana" filtrar por duas dessas etiquetas
    Then o processo "0012/2026" deve aparecer exatamente uma vez
    And "meta.totalItems" deve contá-lo uma única vez

  Scenario: [Concorrência] Tramitação concluída entre duas consultas
    Given que "Patrícia" está com a lista aberta mostrando "0012/2026" na etapa "PESQUISA_PRECOS"
    When "Juliana" encaminhar o processo "0012/2026" para a etapa "TERMO_REFERENCIA" no "Setor de Planejamento"
    And a lista de "Patrícia" for consultada novamente
    Then o processo deve aparecer com etapa "Termo de Referência" e unidade "Setor de Planejamento" ao mesmo tempo
    And nenhuma consulta deve exibir a etapa nova com a unidade antiga

  Scenario: [Concorrência] Paginação determinística com empates
    Given que 45 processos visíveis têm o mesmo "updatedAt"
    When "Patrícia" percorrer as páginas 1, 2 e 3 com "pageSize" 20 sem alterações nos dados
    Then os 45 processos devem aparecer exatamente uma vez no conjunto das páginas

  Scenario: [Falha de banco] Banco indisponível durante a consulta
    Given que o banco de dados está indisponível
    When "Patrícia" abrir a lista de processos
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a tela deve manter os filtros e exibir "Não foi possível carregar os processos agora. Tente novamente em instantes." com o correlationId e o botão "Tentar novamente"

  Scenario: [Falha de banco] Consulta excede o tempo limite
    Given que a consulta ultrapassa o "statement_timeout" de 3 segundos
    When "Patrícia" buscar processos
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And deve ser registrado log "warn" "process.list_slow" com as chaves dos filtros usados, sem o texto da busca

  Scenario: [Falha de integração] Cache de permissões no Redis indisponível
    Given que o Redis está indisponível
    When "Ana" abrir a lista de processos
    Then as permissões efetivas devem ser calculadas a partir do banco e a API deve responder 200 com os mesmos processos visíveis
    And deve ser registrado log "warn" "access.cache_unavailable"

  Scenario: [Falha de integração] Falha ao salvar a escolha de colunas
    Given que a gravação de preferências (ME-02) falha
    When "Patrícia" ocultar a coluna "Prioridade"
    Then a coluna deve ser ocultada imediatamente e a escolha guardada localmente
    And a tela deve exibir o aviso discreto "Não foi possível salvar suas colunas neste dispositivo para outros acessos."
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Parâmetro inválido (enum, UUID, datas, valores, sort, paginação) | 422 | `VALIDATION_ERROR` | "Alguns filtros eram inválidos e foram ignorados." | Front remove o parâmetro inválido da URL e refaz a consulta |
| Sem `PROCESS_VIEW` e sem concessões | 403 | `PERMISSION_DENIED` | "Você não tem acesso à lista de processos." | SCR-111 (403) |
| Vínculo inativo / tenant suspenso | 403 | `MEMBERSHIP_INACTIVE` / `TENANT_SUSPENDED` | "Seu acesso a este órgão não está ativo." | Redireciona para SCR-111 |
| Sessão expirada | 401 | `SESSION_EXPIRED` | "Sua sessão expirou. Entre novamente para continuar." | Login e retorno à mesma URL |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas consultas seguidas. Aguarde alguns segundos." | Respeita `Retry-After`; mantém resultados anteriores |
| Banco indisponível ou consulta acima do tempo limite | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar os processos agora. Tente novamente em instantes." | Mantém filtros; botão "Tentar novamente"; exibe correlationId |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-001 (processos e campos desnormalizados), US-097 (escopos efetivos e autorização). Relacionadas: US-055 (`overdueSince`), US-106 (dias úteis do DTO `deadline`), US-007 (etiquetas), US-012 (participações), US-013 (registro central de campos sigilosos), US-003 (visões e exportação reutilizam o contrato), US-004 (reutiliza `deadline`), US-076 (links do dashboard).
- **Decisões/ADRs:** DEC-024, DEC-026, DEC-030, DEC-031, DEC-057, DEC-106, DEC-133, DEC-134, DEC-183, DEC-184; ADR-002.
- **Configurações:** `access.historicalDepartmentsCanView`, `deadlines.warnBeforeBusinessDays`, `labels.secretariat`, `labels.department`, `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:**
  1. **Opções do filtro "Etapa":** não há leitura de etapas acessível sem `WORKFLOW_VIEW` (WF-01/WF-09 exigem essa permissão, que `REQUISITANTE` não tem). Adotado: `includeStageOptions=true` em PRC-01 devolve `meta.stageOptions: [{ key, name, groupLabel }]` (chaves distintas das versões publicadas e aposentadas do tenant). Proposta: formalizar em api.md §4 ou criar um lookup implícito de etapas.
  2. **Índice para filtro por etiqueta:** `process_tags` tem apenas a PK `(tenant_id, process_id, tag_id)`. Proposta: índice `(tenant_id, tag_id, process_id)` em entities.md.
  3. **Menu "Processos" para acesso só por participação:** permissions.md §9 exige `PROCESS_VIEW`, que o `CONSULTOR_EXTERNO` não tem por perfil, e `GET /me/permissions` não informa concessões `USER`. Proposta: incluir `implicit.hasProcessGrants` na resposta de ME-03.
  4. **Contrato de resposta de PRC-01** (objetos resumidos `currentStage`, `currentDepartment`, `currentResponsible` e o DTO calculado `deadline`) a registrar em api.md §4.
  5. **MFA × permissão `H` usada apenas para desmascarar:** POL-14 prevê 403 `MFA_REQUIRED`; adotado o desmascaramento condicionado, sem 403 em listas (FA-12). Proposta: registrar a regra em permissions.md §6.

## Impacto técnico
- Cria o `ProcessVisibilityService` e o `ProcessListQueryBuilder`, reutilizados por US-003, US-004, US-056 e US-076: predicado de visibilidade em SQL parametrizado (fragmentos `Prisma.sql`) dentro da transação com `app.tenant_id`; o RLS permanece como segunda barreira.
- Composição dinâmica sem SQL injection: colunas de filtro e de ordenação mapeadas por lista fechada (nunca interpolar texto do usuário); `q` sempre como parâmetro.
- Desmascaramento por linha em SQL: expressão `can_view_budget` construída com os escopos de `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (`:budgetTenantWide`, `:budgetOrgIds`, `:budgetDeptIds`) + custódia (`current_responsible_id = :userId OR (current_responsible_id IS NULL AND current_department_id = ANY(:lotacoes))`), usada no `CASE` do valor, no filtro e na ordenação (RN-PROC-25).
- Performance: os índices de entities.md cobrem os filtros principais (`status`, `current_department_id`, `current_responsible_id`, `requesting_secretariat_id`, `current_stage_due_at`, `overdue_since`, `target_date`, `created_at`, GIN `search_vector` e trigram em `code`/`title`); `EXISTS` sobre `process_access` usa os índices parciais por unidade e por usuário. `SET LOCAL statement_timeout = '3s'`. Página e contagem no mesmo snapshot (`REPEATABLE READ READ ONLY`).
- Expansão de subárvores pelo `path` das unidades, cacheada junto com as permissões efetivas (5 min, invalidada pelos eventos de permissões e `DepartmentMoved`).
- O DTO `deadline` calcula dias úteis por linha com feriados do tenant cacheados por ano (≤ 100 linhas por página — custo desprezível).
- A função imutável `cf_unaccent` deve ser a mesma usada na coluna gerada `search_vector`, para o índice GIN ser aproveitado.

## Backend
- **Módulo(s):** `process` (dono); `access`, `organization`, `identity`, `workflow`, `catalog` via fachadas.
- **Casos de uso:** `ListProcessesQuery` → `ListProcessesHandler`.
- **Domínio/serviços:** `ProcessVisibilityService.buildPredicate(ctx)`, `BudgetVisibilityService.sqlCanView(ctx)`, `ProcessListQueryBuilder` (filtros, busca, ordenação, paginação), `StageDeadlineCalculator` (DTO `deadline`), `ProcessListPresenter` (aplica o `ConfidentialFieldsInterceptor`).
- **Integrações internas:** `AccessFacade.getEffectiveScopes(membershipId, permission)`, `OrganizationFacade.expandSubtrees(deptIds)`, `IdentityFacade.getActiveLotacoes(membershipId)`, `WorkflowFacade.listStageOptions()`, `BusinessCalendarFacade.businessDaysBetween(from, to)`.
- **Transação:** somente leitura, com `app.tenant_id`; nenhuma escrita (exceto auditoria de acesso a valor sigiloso, regida por US-013).

## Frontend
- **Tela(s):** SCR-004 (`/processos`).
- **Componentes:** `ProcessListPage`, `ProcessSearchInput` (debounce 300 ms), `QuickFilterBar` (Comigo, Da minha unidade, Atrasados, Devolvidos — `aria-pressed`), `ProcessFiltersPanel` (Sheet no desktop, painel inferior no mobile), `ActiveFilterChips`, `ProcessDataTable` (TanStack Table com `manualPagination`, `manualSorting`, `manualFiltering`), `ColumnChooser`, `StatusBadge`, `PriorityBadge`, `DueDateBadge` (compartilhado com US-004), `ConfidentialValue` ("Sigiloso" + cadeado), `TagChips`, `Pagination`, `ProcessCardList` (mobile).
- **Dados:** estado da consulta na URL (`useSearchParams` + `processListQuerySchema`); TanStack Query `['t', tenantId, 'processes', 'list', params]` com `placeholderData: keepPreviousData`, `staleTime` 30 s e refetch ao focar a janela; cancelamento da requisição anterior ao digitar (`AbortSignal`).
- **Estados:** skeleton de 10 linhas; empty states (FA-01, FA-02); erro com correlationId e "Tentar novamente"; barra de carregamento discreta ao refazer a consulta.
- **Acessibilidade:** `<table>` semântica com `aria-sort` nos cabeçalhos; total anunciado por `aria-live`; filtros em formulário rotulado; chips removíveis por teclado; badge de prazo com ícone e texto; foco devolvido ao gatilho ao fechar o painel de filtros.
- **Responsivo:** cartões abaixo de 768 px; ações principais alcançáveis com uma mão; alvos de toque ≥ 44 px.

## Banco de dados
- **Tabelas lidas:** `processes`, `process_access`, `process_tags`, `tags`, `workflow_stages`, `departments`, `organizations`, `users`, `catalog_items`, `membership_departments`, `process_stages` (pausa do prazo).
- **Migrações:** nenhuma obrigatória; índice `(tenant_id, tag_id, process_id)` em `process_tags` depende da atualização da fonte canônica (lacuna 2).
- **Índices/constraints relevantes:** todos os índices de `processes` listados em entities.md §4.4; `process_access (tenant_id, department_id, process_id) WHERE revoked_at IS NULL` e `(tenant_id, user_id, process_id) WHERE revoked_at IS NULL`; `departments (tenant_id, path text_pattern_ops)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-01 | GET | `/api/v1/processes` | Query string da tabela "Campos" | `200 { data: ProcessListItem[], meta: { page, pageSize, totalItems, totalPages, stageOptions? } }` | 200, 401, 403, 422, 429, 500, 503 |
| TAG-01, CAT-01, ORG-01, DEP-02, USR-02 | GET | leituras de apoio aos filtros | — | — | 200 |
| ME-02 / ME-03 | PATCH / GET | `/api/v1/me` / `/api/v1/me/permissions` | preferências de colunas / permissões | — | 200, 412 |

Exemplo: `GET /api/v1/processes?status=IN_PROGRESS,RETURNED&overdue=true&sort=-priority,currentStageDueAt&page=1&pageSize=20`
```json
{
  "data": [
    {
      "id": "01927f1a-6c1e-7c8b-9a2e-3f6d2b1c0a11",
      "code": "0012/2026", "number": 12, "year": 2026, "internalCode": null,
      "title": "Aquisição de cimento para manutenção de vias",
      "status": "IN_PROGRESS", "priority": "HIGH",
      "organization": { "id": "…", "shortName": "PMSJ" },
      "requestingSecretariat": { "id": "…", "name": "Secretaria de Obras" },
      "requestingDepartment": { "id": "…", "name": "Setor de Manutenção" },
      "currentStage": { "key": "PESQUISA_PRECOS", "name": "Pesquisa de preços" },
      "currentDepartment": { "id": "…", "name": "Setor de Cotações" },
      "currentResponsible": null,
      "deadline": { "dueAt": "2026-10-08T02:59:59Z", "slaType": "BUSINESS", "daysLeft": 2, "overdueDays": null, "isDueSoon": true, "isOverdue": false, "isPaused": false },
      "contractingType": { "id": "…", "code": "AQUISICAO_BENS", "label": "Aquisição de bens" },
      "modality": null,
      "origin": { "id": "…", "code": "DEMANDA_NAO_PREVISTA", "label": "Demanda não prevista" },
      "isBudgetConfidential": false,
      "estimatedValue": "85000.00", "estimatedValueMasked": false,
      "targetDate": "2026-11-30", "overdueSince": null,
      "tags": [{ "id": "…", "name": "Obras emergenciais", "color": "#B45309" }],
      "createdAt": "2026-09-14T13:02:11Z", "updatedAt": "2026-10-02T18:40:00Z"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 1, "totalPages": 1 }
}
```

## Logs
- `info` `process.list` — chaves dos filtros usados (sem valores), `qLength`, `page`, `pageSize`, `resultCount`, `totalItems`, `durationMs`, `tenantId`, `userId`, `correlationId`.
- `warn` `process.list_slow` — consulta acima de 800 ms ou interrompida pelo tempo limite, com as chaves dos filtros e a ordenação.
- `warn` `access.cache_unavailable` — cálculo de permissões efetivas sem Redis.
- `error` `process.list_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** o texto de `q`, títulos, objetos, valores estimados e IDs de filtros de valor.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `access.denied` | `ACCESS` | 403 na rota | `reasonCode = PROCESS_VIEW` (amostragem de 1/usuário/rota/minuto) |
| `process.confidential_view` | `ACCESS` | A página devolve valor desmascarado de processo sigiloso (1× por sessão e processo — regra de US-013) | `metadata`: `processCode`, `source = "PRC-01"` |

Consultas comuns não geram auditoria (DEC-025: a auditoria registra acessos sensíveis, exportações e mudanças).

## Testes necessários
- **Unitários:** `ProcessListQueryBuilder` (combinação E/OU, valores reservados `me`/`none`/`mine`, lista fechada de ordenação, desempate por `id`); regra RN-PROC-25 (filtro/ordenação com e sem POL-09, com custódia); `StageDeadlineCalculator` (dias úteis com feriado de 12/10, `CALENDAR`, pausado, vence hoje, atrasado); conversão de datas no fuso do tenant.
- **Integração (Testcontainers PostgreSQL + Redis):** matriz de visibilidade (GESTOR `TENANT`; REQUISITANTE `OWN_DEPARTMENTS` com e sem subárvore; acesso `HISTORICAL` com `access.historicalDepartmentsCanView` verdadeiro e falso; aprovador designado; participante ativo e revogado; consultor externo); RLS com `app.tenant_id` diferente retorna vazio; processo descartado nunca aparece; FTS com acentos ("manutencao" encontra "manutenção").
- **API/contrato:** schema de PRC-01 conforme api.md; `meta` correto em página além do total; 422 por parâmetro.
- **RBAC e multi-tenant:** suíte "tenant leak" com filtros por IDs de outro tenant; `X-Tenant-Id` sem vínculo → 403; usuário sem `PROCESS_VIEW` → 403 + `access.denied`.
- **Segurança:** tentativas de injeção em `q` e `sort` (`sort=updatedAt;DROP TABLE`) → 422 sem execução; valor sigiloso ausente da resposta, dos logs e da ordenação observável.
- **Concorrência:** consulta durante tramitação em andamento não exibe estado parcial; paginação com empates.
- **E2E (Playwright):** filtros e atalhos, busca com debounce, link compartilhado, escolha de colunas persistida, retorno do detalhe com filtros restaurados, cartões em 360 px.
- **Acessibilidade/performance:** axe sem violações sérias em SCR-004; k6 com base de 100 mil processos, 300 unidades e 2.000 usuários, 10 combinações de filtros, 50 usuários virtuais por 5 min → p95 < 800 ms e 0 erros.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] Predicado de visibilidade único (`ProcessVisibilityService`) usado pela lista e coberto pela matriz de visibilidade
- [ ] Mascaramento, filtro e ordenação por valor conforme RN-PROC-25, com teste de não vazamento
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-01 compatível com api.md (incluindo `deadline`)
- [ ] Meta de performance comprovada em k6 (p95 < 800 ms com 100 mil processos)
- [ ] Logs sem o texto da busca e sem valores; métricas de latência por combinação de filtros
- [ ] Tela acessível (axe), navegável por teclado e responsiva (360 px)
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**L** — combina a construção do predicado de visibilidade reutilizável, um construtor de consultas dinâmico e seguro com FTS + trigram, o mascaramento por linha aplicado também a filtro e ordenação, a meta de performance com volume realista e uma tela de tabela server-side com URL como estado, escolha de colunas, atalhos e versão mobile.

## Prioridade
**P0** — sem a lista não há como localizar e acompanhar processos; é a base do contrato de filtros usado pelo dashboard, pela caixa de tarefas e pelas notificações.

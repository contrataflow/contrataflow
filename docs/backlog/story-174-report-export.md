---
id: US-174
title: "Exportar relatórios"
epic: EP-028
feature: FT-081
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-073, US-083, US-172]
modules: [analytics, files, audit, platform, notification, access, organization]
screens: [SCR-027, SCR-028]
endpoints: [ANL-11, ANL-12, ANL-13, ANL-19]
permissions: [REPORT_EXPORT, REPORT_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [ReportExportFinished]
---

# US-174 — Exportar relatórios

## Título
Exportar relatórios

## Descrição
**Como** gestor de contratações (`GESTOR_CONTRATACOES`), controle interno (`CONTROLE_INTERNO`), auditor (`AUDITOR`) ou autoridade competente (`AUTORIDADE_COMPETENTE`) com a permissão de exportar relatórios, **quero** baixar em **CSV** ou **XLSX** exatamente o que estou vendo em um relatório (indicadores, execução do PCA ou tabelas de gargalos), com os mesmos filtros, o mesmo recorte de escopo e o mesmo tratamento do sigilo do orçamento, **para** levar os números à prestação de contas e a planilhas de trabalho sem refazer cálculo à mão e sem expor o que eu não poderia ver na tela.

A exportação é **assíncrona**: a API registra um `ReportExport`, o worker gera o arquivo lendo **somente o read model** (`AnalyticsStageFact`, `AnalyticsProcessFact`, `AnalyticsPcaItemFact` e as visões materializadas), grava no armazenamento como `Attachment` e a tela acompanha o pedido. O arquivo fica disponível por 24 horas, só para quem pediu, e cada exportação e cada download deixam trilha de auditoria (`report.export`, `attachment.download`).

## Contexto
- DEC-206 e ADR-014 (item 7): "Exportação CSV/XLSX pela fila de exportações, auditada (`report.export`)". FT-081 (RN-ANL-15, RN-ANL-16): exige `REPORT_EXPORT`, aplica o mesmo filtro de escopo e de sigilo da tela, roda pela fila no worker e deixa o arquivo disponível por tempo limitado e só a quem pediu.
- POL-28 (permissions.md): "exportação (`REPORT_EXPORT`) aplica o mesmo filtro e é auditada"; valores de processos com orçamento sigiloso só entram em quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo; mascaramento por linha **antes** de agregar.
- MVP 1: as exportações de lista (US-003) e de auditoria (US-075) são síncronas, em *streaming*, com o formato de CSV padronizado (RN-PROC-43/44) e teto de linhas (`EXPORT_TOO_LARGE`). Esta story **reaproveita o formato de CSV** e a política de filas da US-083 (retries com *jitter*, *dead-letter*, contrato de job), mas é assíncrona porque a leitura analítica pode ser longa e porque o XLSX é gerado em lote. Precedente imediato no MVP 2: US-145 (`PcaExport`, padrão B de `queues.md` §2: linha de pedido durável, enfileiramento após o *commit*, reconciliador).
- Armazenamento: `storage.md` reserva `tenants/{tenantId}/exports/{exportId}/…`; o download usa URL assinada de 300 s e a auditoria é gravada **antes** da URL (storage.md §6).
- Relatórios exportáveis: os do catálogo da US-172 (tempo de ciclo, devoluções, cumprimento de prazo, volume e valor), a execução do PCA (US-175: chave `pca-execution`) e as tabelas de gargalos (US-176: `bottlenecks`; US-177: `bottleneck-queues`, `bottleneck-comparison`). Cada relatório registra um **provedor de exportação** (`ReportExportProvider`); esta story entrega o mecanismo e os provedores dos relatórios cuja story já existe no épico (a ordem de entrega vem das dependências).
- O detalhamento por processo (US-173) pode ser exportado (`content = DETAIL`) e **aplica o predicado de visibilidade da DEC-024** como na tela; o resumo (`content = SUMMARY`, padrão) é recortado só pelo escopo de `REPORT_VIEW` (RN-ANL-11).
- Definições dos indicadores (início e fim do ciclo, cancelados, dias úteis descontando pausas, cumprimento de prazo, devolução): fixadas na US-172 (RN-ANL-70..89) e apenas **reproduzidas** no arquivo.
- LGPD: o arquivo de gargalos por responsável contém nomes de pessoas; por isso a exportação por responsável exige o mesmo escopo da tela e fica registrada na auditoria com a dimensão (`ASSIGNEE`). O nome do arquivo nunca leva nome de pessoa nem filtro.

## Objetivo
Entregar, para 100% das exportações, um arquivo idêntico em dados ao da tela (teste de paridade), sem valor sigiloso nem processo fora do escopo para quem não pode vê-los, gerado em até 60 s (p95) para até 50.000 linhas na suíte de performance, auditado de ponta a ponta (pedido, conclusão e download), sem duplicar arquivo em cliques repetidos e com falha de armazenamento, de fila ou de banco tratada sem perder o pedido.

## Persona
- **Principal:** Controle Interno (`CONTROLE_INTERNO`, `REPORT_EXPORT` com escopo `TENANT`) e Gestor de contratações (`GESTOR_CONTRATACOES`, `REPORT_EXPORT`, escopo `TENANT` ou de secretaria quando o órgão restringe).
- **Secundárias:** Auditor (`AUDITOR`, exporta para conferência com rastreabilidade); Autoridade competente (`AUTORIDADE_COMPETENTE`, `REPORT_EXPORT` por matriz padrão, escopo `ORGANIZATION`); Administrador do órgão (`ADMIN_ORGAO`), somente se o tenant lhe conceder `REPORT_VIEW` e `REPORT_EXPORT`; Planejamento (`PLANEJAMENTO`), que tem `REPORT_VIEW` mas não exporta por padrão.

## Pré-condições
- A pessoa tem **as duas** permissões: `REPORT_VIEW` (para o relatório) e `REPORT_EXPORT`; o relatório de origem está aberto com os filtros desejados (SCR-027 ou SCR-028).
- Fila `report-export` configurada no worker; bucket `documents` disponível (sem ele, o pedido fica na fila — FA-05).
- Read model alimentado (US-170/US-171); relatório com provedor de exportação registrado (`exportable = true` no catálogo da US-172).
- Para `content = DETAIL`, o relatório tem detalhamento por processo (US-173) ou drill-down (US-176).

## Fluxo principal
1. Em `/relatorios` (SCR-027) ou `/relatorios/[relatorio]` (SCR-028), a pessoa com `REPORT_EXPORT` vê o botão "Exportar" no cabeçalho do relatório, ao lado de "dados atualizados em …".
2. Ao abrir o diálogo, o front mostra o nome do relatório, o resumo dos **filtros aplicados**, o **escopo** ("Todo o órgão" ou "Secretaria de Saúde"), a quantidade de linhas (`meta.totalRows` do relatório já carregado), a data dos dados e os avisos: "Valores de processos com orçamento sigiloso não estão incluídos" (quando `confidentialExcluded`) e "Dados atualizados há mais de 15 minutos" (quando `stale`).
3. A pessoa escolhe o **formato** (CSV ou XLSX) e, quando o relatório oferece, o **conteúdo** ("Resumo" ou "Detalhamento por processo") e confirma. O front chama `ANL-11` com `Idempotency-Key`.
4. A API autoriza (`REPORT_VIEW` e `REPORT_EXPORT`), resolve o escopo efetivo (interseção dos dois — RN-ANL-110), valida os filtros **com o mesmo schema do relatório**, conta as linhas (limite de RN-ANL-116), confere duplicidade e limites e cria o `ReportExport` em `PENDING`.
5. Depois do *commit*, enfileira o job `report-export` na fila `report-export` e responde `202` com o pedido e `Location`.
6. O front acompanha por `ANL-12` a cada 2 s (até 90 s) e mostra "Gerando arquivo…". Passados 90 s, informa "Estamos gerando o arquivo. Você pode sair desta tela; avisaremos quando estiver pronto." e passa a depender da notificação e da lista "Exportações recentes" (`ANL-19`).
7. O worker (`runJob`, contexto do tenant e do solicitante, DEC-164) marca `PROCESSING`, **revalida** vínculo e permissões do solicitante (RN-ANL-124), abre uma transação `REPEATABLE READ`/`READ ONLY` com `app.tenant_id`, lê a data dos dados (`dataAsOf`) e transmite as linhas do provedor ao gerador do formato (CSV ou XLSX), calculando `sha256`, tamanho e contagem enquanto envia o objeto ao S3.
8. Numa transação, cria o `Attachment` (`targetType = REPORT_EXPORT`, `status = AVAILABLE`), marca o pedido `READY` com `expiresAt` = `finishedAt` + 24 h, grava a auditoria `report.export` (`SUCCESS`) e o evento `ReportExportFinished`.
9. O consumidor de notificações cria `REPORT_EXPORT_READY` (in-app) para o solicitante; o front mostra "Arquivo pronto" com o botão "Baixar".
10. Ao clicar em "Baixar", o front chama `ANL-13`: a API revalida a permissão, grava `attachment.download` **antes** e devolve `{ url, urlExpiresAt }` (300 s). O navegador baixa o arquivo com `Content-Disposition: attachment`.

## Fluxos alternativos
- **FA-01 — Relatório sem exportação:** relatório sem provedor (ou chave inexistente) responde `422 REPORT_NOT_EXPORTABLE` / `404 NOT_FOUND`; o botão "Exportar" só aparece quando o catálogo marca `exportable`.
- **FA-02 — Escopo da exportação menor que o da tela:** se o escopo de `REPORT_EXPORT` for mais estreito que o de `REPORT_VIEW`, o arquivo cobre só a interseção; o diálogo avisa "A exportação inclui apenas: Secretaria de Saúde." e o estado do pedido traz `scopeLabel`.
- **FA-03 — Acima do limite:** mais de 50.000 linhas → `422 EXPORT_TOO_LARGE` com `meta.totalRows` e `meta.limit`; o diálogo orienta "Refine o período ou os filtros." e mantém os filtros.
- **FA-04 — Pedido igual em andamento:** mesma pessoa, mesmo relatório, mesmos filtros, formato e conteúdo com pedido `PENDING`/`PROCESSING` → `409 REPORT_EXPORT_IN_PROGRESS` com `meta.exportId`; o diálogo passa a acompanhar o pedido existente.
- **FA-05 — Armazenamento indisponível:** falha transitória do S3 reentra com *backoff*; esgotadas as tentativas, `FAILED` com `STORAGE_UNAVAILABLE`, sem `Attachment`; a UI oferece "Tentar novamente".
- **FA-06 — Redis indisponível no pedido:** a API não consegue enfileirar; marca o pedido `FAILED` (`ENQUEUE_FAILED`) e responde `503`; nada fica pendente sem job.
- **FA-07 — Reconstrução em andamento:** se há `AnalyticsReconciliationRun` `REBUILD` em `RUNNING`, o job adia a geração (nova tentativa a cada 2 min, até 30 min) para não gravar números parciais; passado o prazo termina `FAILED` com `READ_MODEL_REBUILDING`.
- **FA-08 — Permissão perdida durante a geração:** vínculo desativado ou perfil removido antes do início do trabalho → `FAILED` com `PERMISSION_REVOKED`, sem arquivo.
- **FA-09 — Arquivo expirado:** depois de 24 h, o job `maintenance` marca `EXPIRED` e apaga o objeto; `ANL-13` responde `410 REPORT_EXPORT_EXPIRED` e a UI oferece "Exportar de novo".
- **FA-10 — Baixar de novo:** `ANL-13` pode ser chamado várias vezes enquanto o arquivo existir; cada download gera auditoria e uma nova URL de 300 s.
- **FA-11 — Dados desatualizados:** a exportação segue; o estado do pedido traz `dataAsOf` e `stale`, e o aviso aparece no diálogo, no histórico e na aba "Parâmetros" do XLSX.
- **FA-12 — Sair da tela:** a pessoa pode fechar o diálogo ou a aba; o pedido continua e a notificação (ou `ANL-19`) leva ao arquivo.
- **FA-13 — Mesma consulta por outra pessoa:** o bloqueio de duplicidade é por solicitante; outra pessoa com a mesma consulta gera o seu próprio arquivo (cada arquivo é um ato auditável e depende de quem pede).

## Regras de negócio
- **RN-ANL-110** — Exportar exige `REPORT_EXPORT` **e** `REPORT_VIEW` (a exportação é a "tela em arquivo"). O recorte de dados é a **interseção** dos escopos das duas permissões (RN-ANL-11 e RN-ANL-21 conforme o relatório); o arquivo nunca contém mais do que a tela do solicitante. `ADMIN_ORGAO` só exporta se o tenant lhe conceder as duas permissões. Sem `REPORT_EXPORT` → `403 PERMISSION_DENIED` com `access.denied`; fora do tenant → `404`.
- **RN-ANL-111** — Chaves e conteúdo: `{report}` é a chave do catálogo da US-172 ou uma das chaves registradas por US-175 (`pca-execution`), US-176 (`bottlenecks`) e US-177 (`bottleneck-queues`, `bottleneck-comparison`). `content` ∈ `SUMMARY` (padrão: a tabela agregada do relatório) | `DETAIL` (linhas por processo, só para relatórios com detalhamento — US-173 — ou drill-down de um grupo — US-176). Combinação não suportada → `422 REPORT_NOT_EXPORTABLE`. A chave `exports` é reservada ao recurso `/reports/exports`.
- **RN-ANL-112** — **Mesma consulta da tela:** `filters` é validado pelo **mesmo schema Zod** do endpoint do relatório e executado pelo mesmo manipulador de consulta (`ReportExportProvider` delega ao `Query` do relatório); não há segunda implementação de cálculo. Teste de paridade obrigatório: dados da tela = dados do arquivo.
- **RN-ANL-113** — **Sigilo e visibilidade (POL-28, POL-09, DEC-024):** o mascaramento é por linha **antes** de agregar, com o mesmo `ConfidentialValuePolicy` da tela; quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo recebe totais sem os sigilosos e `confidentialExcluded = true` (gravado no pedido e na aba "Parâmetros"); linhas de `DETAIL` trazem o valor como vazio e a coluna "Valor sigiloso não exibido" = `Sim`. `DETAIL` aplica o predicado da DEC-024 do solicitante. Nenhum valor sigiloso vai para arquivo, log, auditoria, evento ou notificação de quem não o pode ver.
- **RN-ANL-114** — **Fonte:** somente o read model (RN-ANL-06/19/20); nenhum provedor lê `ProcessStage`/`ProcessMovement`. Nomes de secretaria, unidade, etapa e pessoa vêm das fachadas de `organization`, `workflow` e `identity` em lote.
- **RN-ANL-115** — **Assincronia e estados:** `ReportExport.status` (`ReportExportStatus`): `PENDING → PROCESSING → READY | FAILED`; `READY → EXPIRED` pelo job `maintenance`. O job `report-export` roda na fila `report-export` (padrão B: linha durável, enfileiramento após o *commit*, `jobId = exportId`, reconciliador reenfileira pedidos sem job) com o contrato `JobMeta` do tenant e do solicitante (DEC-164) e as tentativas padrão (DEC-163: 5 tentativas, *backoff* com *jitter*, cópia em `dead-letter` na falha final). Concorrência: 2 jobs simultâneos por tenant.
- **RN-ANL-116** — **Limite:** até **50.000 linhas** de dados por arquivo (nas duas formas de conteúdo); a API conta antes de criar o pedido (`SELECT count(*)` do provedor, com `statement_timeout` de 10 s) e responde `422 EXPORT_TOO_LARGE` com `meta.totalRows` e `meta.limit`; o job confere de novo e termina `FAILED` com `EXPORT_TOO_LARGE` se o total passou do limite entre o pedido e a geração. Fixo em código (sem chave de configuração).
- **RN-ANL-117** — **Formato CSV:** o padrão do MVP 1 (RN-PROC-43/44): UTF-8 com BOM, separador `;`, CRLF, cabeçalho em pt-BR com rótulos da terminologia (DEC-184), decimais com vírgula e sem milhar, datas `DD/MM/AAAA` e data-hora `DD/MM/AAAA HH:mm` no fuso do tenant, aspas conforme RFC 4180 e neutralização de injeção de fórmula (célula de texto iniciada por `=`, `+`, `-`, `@`, tabulação ou retorno de carro recebe o prefixo `'`). Percentuais saem como número de 0 a 100 com a unidade no cabeçalho ("% no prazo"). Uma linha de cabeçalho, nenhuma linha de comentário ou de total fora da tabela do relatório.
- **RN-ANL-118** — **Formato XLSX:** gerado em *streaming* (sem carregar 50.000 linhas em memória), duas abas: **Dados** (cabeçalho congelado, tipos numéricos e de data reais, formato numérico pt-BR, largura automática limitada) e **Parâmetros** (relatório, filtros aplicados em texto, escopo (`scopeLabel`), data dos dados (`dataAsOf`), gerado em, `confidentialExcluded` com a frase "Esta exportação não inclui valores de processos com orçamento sigiloso." quando verdadeiro, versão da definição dos indicadores). **Nunca** grava fórmulas, vínculos externos ou macros: todo texto é gravado como *string* e recebe a mesma neutralização do CSV. Propriedades do documento: criador "ContrataFlow", sem nome de pessoa.
- **RN-ANL-119** — **Consistência:** o job lê numa única transação `REPEATABLE READ`/`READ ONLY` com `app.tenant_id`, para que o arquivo represente um instante; `dataAsOf` é a data de atualização do read model lida nessa transação. Se houver `REBUILD` em andamento, aplica FA-07.
- **RN-ANL-120** — **Armazenamento:** o arquivo é um `Attachment` (`targetType = REPORT_EXPORT`, `targetId` = id do pedido, `processId` nulo, `status = AVAILABLE` sem varredura de antivírus por ser conteúdo gerado pelo produto), chave `tenants/{tenantId}/exports/{exportId}/{fileName}` no bucket `documents`, gravado uma vez por pedido (o *retry* reescreve a mesma chave com o mesmo conteúdo). Nome: `relatorio-{chave}-{AAAAMMDD-HHmm}.{csv|xlsx}` (horário do tenant); **nunca** inclui filtros, nomes de pessoa, secretaria ou valores.
- **RN-ANL-121** — **Validade e acesso:** o arquivo vale **24 horas** a partir de `finishedAt` (`expiresAt`). Só o **solicitante** consulta (`ANL-12`, `ANL-19`) e baixa (`ANL-13`) o pedido; para qualquer outra pessoa, mesmo com `REPORT_EXPORT`, a resposta é `404 NOT_FOUND`. O download revalida `REPORT_EXPORT` na hora (permissão perdida → `403`), grava `attachment.download` (`EXPORT`) **antes** da URL e, se a auditoria falhar, responde `503`. A URL vale 300 s. O job `maintenance` marca `EXPIRED`, apaga o objeto, marca o `Attachment` como `DELETED` e remove os registros de pedido com mais de 90 dias.
- **RN-ANL-122** — **Idempotência e limites:** `Idempotency-Key` em `ANL-11` (DEC-105; mesma chave e mesmo corpo em 24 h devolvem o mesmo pedido com `Idempotent-Replayed`); no máximo **um** pedido ativo por (solicitante, relatório, `filtersHash`, formato, conteúdo) — índice único parcial; no máximo **3** pedidos ativos por solicitante; 20 requisições por minuto da classe "Exportações e renderização" (api.md §1.6). Excedentes → `409 REPORT_EXPORT_IN_PROGRESS` ou `429 RATE_LIMITED`.
- **RN-ANL-123** — **Auditoria:** `report.export` (`EXPORT`) é gravada pelo worker na transação que conclui o pedido (`SUCCESS`) ou o encerra com falha (`FAILURE` com `reasonCode`), ator = solicitante, com relatório, formato, conteúdo, filtros, dimensão, contagem de linhas, `confidentialExcluded`, `dataAsOf`, `scopeLabel`, `sha256` e `sizeBytes`; **nunca** com valores nem conteúdo do arquivo. O download grava `attachment.download`.
- **RN-ANL-124** — **Revalidação no job:** ao iniciar, o worker confirma que o solicitante ainda tem vínculo ativo e `REPORT_VIEW` + `REPORT_EXPORT`, e recalcula o escopo e a permissão de sigilo **naquele momento**; o arquivo usa sempre o menor acesso entre o pedido e a execução. Mudança → `FAILED` `PERMISSION_REVOKED` ou arquivo com o recorte menor (e `scopeLabel` atualizado).
- **RN-ANL-125** — **Prazo máximo:** pedido `PENDING`/`PROCESSING` por mais de 15 min é encerrado como `FAILED` (`TIMEOUT`) pelo job `maintenance`, que grava a auditoria `report.export` `FAILURE`.
- **RN-ANL-126** — **Notificação e evento:** a conclusão (`READY` ou `FAILED`) publica `ReportExportFinished` e gera a notificação `REPORT_EXPORT_READY` (in-app; e-mail desligado por padrão) ao solicitante — exceção à regra de "não notificar o próprio ator" por ser trabalho assíncrono pedido por ele (mesmo precedente de `WORKFLOW_MIGRATION_FINISHED`). A mensagem traz o nome do relatório e o formato, nunca valores.
- **RN-ANL-127** — **Metadados do pedido:** o `ReportExport` guarda o que a tela precisa para explicar o arquivo (`scopeLabel`, `confidentialExcluded`, `dataAsOf`, `stale`, `rowsCount`, `filtersSummary` em texto); a lista de filtros é gravada normalizada (`filters` + `filtersHash`).
- **RN-ANL-128** — **Provedor de exportação:** contrato `ReportExportProvider { key; supports(content); validate(filters); count(ctx, filters); columns(ctx, content); rows(ctx, filters): AsyncIterable<Row>; confidentialExcluded(): boolean }`. Provedores de US-172/US-173/US-175/US-176/US-177 se registram no `ReportExportRegistry`; um relatório novo só aparece como exportável se tiver provedor e teste de paridade.
- **RN-ANL-129** — **Encerramento do tenant (`OFFBOARDING`, DEC-132):** exportar é permitido a `AUDITOR` e `ADMIN_ORGAO` com as permissões, por ser leitura e exportação; os demais comandos seguem bloqueados.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Relatório | `{report}` (rota) | texto (chave do catálogo) | Sim | RN-ANL-111; `exportable` | relatório aberto |
| Formato | `format` | `ReportExportFormat` (`CSV`, `XLSX`) | Sim | — | `CSV` |
| Conteúdo | `content` | `ReportExportContent` (`SUMMARY`, `DETAIL`) | Não | RN-ANL-111 | `SUMMARY` |
| Filtros | `filters` | objeto | Não | schema do relatório (RN-ANL-112); ids no escopo da pessoa | filtros da tela |
| Chave de idempotência | `Idempotency-Key` | uuid (cabeçalho) | Sim | RN-ANL-122 | gerada pelo front |
| Situação | `ReportExport.status` | `ReportExportStatus` | — | `PENDING`, `PROCESSING`, `READY`, `FAILED`, `EXPIRED` | `PENDING` |
| Solicitante | `requestedById` | uuid | — | usuário autenticado | sessão |
| Solicitada / concluída em | `requestedAt`, `finishedAt` | data/hora | — | — | `now()` / worker |
| Válido até | `expiresAt` | data/hora | — | `finishedAt` + 24 h | worker |
| Escopo | `scopeLabel` | texto (120) | — | RN-ANL-110 | calculado |
| Data dos dados | `dataAsOf` | data/hora | — | RN-ANL-119 | read model |
| Dados desatualizados | `stale` | booleano | — | defasagem > 15 min (US-176, RN-ANL-168) | calculado |
| Sigilo | `confidentialExcluded` | booleano | — | RN-ANL-113 | calculado |
| Linhas | `rowsCount` | inteiro | — | ≤ 50.000 | worker |
| Arquivo | `attachmentId`, `fileName`, `sizeBytes`, `sha256` | uuid, texto (255), bigint, texto (64) | — | RN-ANL-120 | worker |
| Motivo da falha | `errorCode` | texto (40) | — | `STORAGE_UNAVAILABLE`, `ENQUEUE_FAILED`, `PERMISSION_REVOKED`, `READ_MODEL_REBUILDING`, `EXPORT_TOO_LARGE`, `TIMEOUT`, `RENDER_FAILED` | worker |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `format` ausente ou fora de `CSV`/`XLSX`; `content` fora do domínio | Front + API (Zod) | "Escolha o formato do arquivo: CSV ou XLSX." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-02 | Filtros fora do schema do relatório (período inválido, ids de outro escopo) | Front + API (Zod) | "Os filtros do relatório não são válidos. Ajuste e tente de novo." | `VALIDATION_ERROR` (`INVALID_FORMAT`/`OUT_OF_RANGE`/`REFERENCE_NOT_FOUND`) |
| V-03 | Relatório sem exportação ou combinação conteúdo × relatório não suportada | API | "Este relatório não pode ser exportado nesse formato." | `REPORT_NOT_EXPORTABLE` |
| V-04 | Chave de relatório inexistente | API | "Relatório não encontrado." | `NOT_FOUND` |
| V-05 | Sem `REPORT_EXPORT` ou `REPORT_VIEW` | API | "Você não tem permissão para exportar este relatório." | `PERMISSION_DENIED` |
| V-06 | Mais de 50.000 linhas | API | "O relatório tem {total} linhas. O limite por arquivo é 50.000. Refine o período ou os filtros." | `EXPORT_TOO_LARGE` |
| V-07 | Pedido igual já em andamento | API (+ índice único) | "Já existe uma exportação igual em andamento." | `REPORT_EXPORT_IN_PROGRESS` |
| V-08 | Download de pedido que não está `READY` | API | "O arquivo ainda não está pronto." | `REPORT_EXPORT_NOT_READY` |
| V-09 | Download de pedido `EXPIRED` | API | "O arquivo expirou. Exporte o relatório de novo." | `REPORT_EXPORT_EXPIRED` |
| V-10 | `exportId` de outra pessoa ou de outro tenant | API | "Exportação não encontrada." | `NOT_FOUND` |
| V-11 | Mesma `Idempotency-Key` com corpo diferente | API | "Não foi possível repetir esta ação com os mesmos dados." | `IDEMPOTENCY_KEY_REUSED` |
| V-12 | Mais de 3 pedidos ativos do solicitante ou limite por minuto | API | "Muitas exportações em andamento. Aguarde a conclusão de uma delas." | `RATE_LIMITED` |

## Permissões
- **Permissão:** `REPORT_EXPORT` (risco `M`) para `ANL-11`, `ANL-12`, `ANL-13` e `ANL-19`, **junto com** `REPORT_VIEW` (risco `L`); `PROCESS_VIEW_CONFIDENTIAL_BUDGET` apenas para incluir valores sigilosos (cobrindo o processo).
- **Políticas:** POL-28 (relatórios e sigilo: exportação aplica o mesmo filtro e é auditada), POL-09 (sigilo estendido a fatos e agregados), DEC-024 (visibilidade no `DETAIL`), POL-14 (o desmascaramento em leitura sem MFA não gera `403`: o arquivo sai sem os sigilosos e a UI oferece o *step-up*).
- **MFA:** não exigido por permissão de risco `M`; se a política do tenant for `ALL`, `MFA_REQUIRED` (POL-14).
- **Sem permissão:** o botão "Exportar" fica oculto; a API responde `403 PERMISSION_DENIED` e registra `access.denied` (`reasonCode` = `REPORT_EXPORT`). Pedido de outra pessoa ou de outro tenant: `404 NOT_FOUND`. `CONSULTOR_EXTERNO`: sem `REPORT_VIEW`, `404` nos relatórios.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ReportExportFinished` (novo — lacuna 3) | `analytics.report_export_finished` | Conclusão do pedido (`READY`, `FAILED` ou `EXPIRED` por timeout) | `exportId`, `reportKey`, `format`, `status`, `requestedById`, `errorCode?`; **sem** valores, filtros nem nome do arquivo; consumidor `N` (notificação) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `REPORT_EXPORT_READY` (novo — lacuna 3) | Solicitante do pedido | In-app (obrigatória); e-mail desligado por padrão | `ReportExportFinished` com `READY` ("Seu arquivo do relatório {nome} está pronto. Ele fica disponível por 24 horas.") ou `FAILED` ("Não foi possível gerar o arquivo do relatório {nome}. Tente novamente.") |

## Critérios de aceite em Gherkin
```gherkin
Feature: Exportar relatórios

  Background:
    Given que o tenant "Prefeitura A" está ativo e o read model está atualizado há 2 minutos
    And "Rita" (Controle Interno) tem "REPORT_VIEW" e "REPORT_EXPORT" com escopo "TENANT" e "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    And "Gil" (Gestor) tem "REPORT_VIEW" e "REPORT_EXPORT" com escopo da "Secretaria de Saúde" e não tem a permissão de sigilo
    And existem processos da Saúde e da Educação, e o processo "0012/2026" da Saúde tem orçamento sigiloso

  Scenario: [Sucesso] Exportar o relatório de cumprimento de prazo em XLSX
    When "Rita" solicitar a exportação do relatório "deadline-compliance" em "XLSX" com o exercício 2026
    Then a API deve responder 202 com um pedido "PENDING" e o cabeçalho "Location"
    And o pedido deve terminar "READY" com "expiresAt" 24 horas depois
    And o arquivo deve ter a aba "Dados" com as mesmas linhas e valores do relatório na tela
    And a aba "Parâmetros" deve trazer filtros, escopo "Todo o órgão", data dos dados e "confidentialExcluded" falso
    And deve gerar registro de auditoria "report.export" com formato, relatório, contagem de linhas e hash do arquivo
    And deve gerar o evento ReportExportFinished
    And "Rita" deve receber a notificação "REPORT_EXPORT_READY"

  Scenario: [Sucesso] Exportar em CSV no padrão do MVP 1
    When "Rita" exportar o relatório de volume e valor por modalidade em "CSV"
    Then o CSV deve ter UTF-8 com BOM, separador ";", CRLF, cabeçalho em português e decimais com vírgula
    And o nome do arquivo deve seguir "relatorio-volume-valor-AAAAMMDD-HHmm.csv" sem filtros nem nomes de pessoas

  Scenario: [Sucesso] Baixar o arquivo gerado
    Given que o pedido de "Rita" está "READY"
    When "Rita" solicitar o download
    Then a API deve responder 200 com uma URL assinada válida por 300 segundos
    And deve existir registro de auditoria "attachment.download" gravado antes da URL

  Scenario: [Sucesso] Sigilo respeitado no arquivo de quem não tem a permissão
    When "Gil" exportar o relatório de volume e valor por modalidade em "XLSX"
    Then o arquivo deve conter apenas processos da Secretaria de Saúde
    And os totais devem excluir o processo "0012/2026"
    And a aba "Parâmetros" deve trazer "Esta exportação não inclui valores de processos com orçamento sigiloso."
    And o pedido deve registrar "confidentialExcluded" verdadeiro
    And nenhum valor do processo "0012/2026" deve aparecer no arquivo, na auditoria, nos logs nem na notificação

  Scenario: [Sucesso] Detalhamento por processo respeita a visibilidade
    Given que "Gil" não pode ver o processo restrito "0030/2026" da Saúde
    When "Gil" exportar o detalhamento do relatório de cumprimento de prazo em "CSV"
    Then o arquivo não deve listar o processo "0030/2026"
    And a linha do processo "0012/2026", se visível, deve ter o valor vazio e "Valor sigiloso não exibido" igual a "Sim"

  Scenario: [Sucesso] Paridade entre a tela e o arquivo
    Given que "Rita" aplicou os filtros de secretaria "Saúde" e modalidade "Pregão" no relatório
    When "Rita" exportar o relatório em "CSV"
    Then as linhas e os totais do arquivo devem ser idênticos aos da tela com os mesmos filtros

  Scenario: [Validação] Formato ausente e filtros inválidos
    When "Rita" solicitar a exportação sem informar o formato
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "format"
    When "Rita" solicitar a exportação com período final anterior ao inicial
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo de período
    And nenhum pedido deve ser criado

  Scenario: [Validação] Relatório sem exportação e exportação grande demais
    When "Rita" solicitar a exportação do detalhamento de um relatório que só tem resumo
    Then a API deve responder 422 com código "REPORT_NOT_EXPORTABLE"
    Given que o detalhamento do exercício tem 62.000 linhas
    When "Rita" solicitar a exportação do detalhamento em "CSV"
    Then a API deve responder 422 com código "EXPORT_TOO_LARGE", "meta.totalRows" 62000 e "meta.limit" 50000
    And nenhum pedido deve ser criado

  Scenario: [Validação] Texto com fórmula é neutralizado
    Given que o objeto de um processo começa com "=SOMA(A1:A9)"
    When "Rita" exportar o detalhamento em "XLSX" e em "CSV"
    Then a célula do objeto deve ser texto e começar com um apóstrofo antes do sinal "="
    And o XLSX não deve conter nenhuma fórmula

  Scenario: [Permissão] Sem REPORT_EXPORT ou sem REPORT_VIEW
    Given que "Paula" (Planejamento) tem "REPORT_VIEW" mas não "REPORT_EXPORT"
    And "Davi" tem "REPORT_EXPORT" mas não "REPORT_VIEW"
    When "Paula" e "Davi" solicitarem a exportação
    Then a API deve responder 403 com código "PERMISSION_DENIED" para os dois
    And o botão "Exportar" não deve ser exibido para "Paula"
    And deve gerar registro de auditoria "access.denied" para cada tentativa

  Scenario: [Permissão] Escopo da exportação menor que o da tela
    Given que "Marta" tem "REPORT_VIEW" com escopo "TENANT" e "REPORT_EXPORT" apenas da "Secretaria de Educação"
    When "Marta" exportar o relatório de volume e valor
    Then o arquivo deve conter apenas a Secretaria de Educação
    And o diálogo deve ter avisado "A exportação inclui apenas: Secretaria de Educação."

  Scenario: [Permissão] Outra pessoa não acessa o pedido
    Given que o pedido de "Rita" está "READY"
    When "Gil" consultar ou baixar o pedido de "Rita"
    Then a API deve responder 404 com código "NOT_FOUND" nas duas chamadas
    And nenhum nome de arquivo ou URL deve ser revelado

  Scenario: [Permissão] Permissão revogada durante a geração
    Given que o pedido de "Gil" está "PENDING"
    And o administrador remove "REPORT_EXPORT" de "Gil" antes do início do trabalho
    When o worker iniciar o pedido
    Then o pedido deve terminar "FAILED" com "errorCode" "PERMISSION_REVOKED" e nenhum arquivo deve ser gerado
    And a auditoria "report.export" deve registrar falha com "reasonCode" "PERMISSION_REVOKED"

  Scenario: [Tenant incorreto] Pedido ou relatório de outro tenant
    Given que existe um pedido pronto no tenant "Prefeitura B"
    When "Rita", no tenant "Prefeitura A", consultar ou baixar esse pedido
    Then a API deve responder 404 com código "NOT_FOUND" nos dois casos
    And nenhum dado, nome de arquivo ou URL de "Prefeitura B" deve ser revelado

  Scenario: [Tenant incorreto] O arquivo só contém dados do tenant
    Given que existem fatos em "Prefeitura A" e em "Prefeitura B" com a mesma secretaria e modalidade
    When "Rita" exportar o relatório de volume e valor
    Then o arquivo não deve conter nenhuma linha de "Prefeitura B"

  Scenario: [Duplicidade] Clique repetido com a mesma chave de idempotência
    Given que "Rita" solicitou o CSV com a "Idempotency-Key" "k-174"
    When a mesma requisição for reenviada com o mesmo corpo
    Then a API deve responder com "Idempotent-Replayed" verdadeiro e o mesmo "exportId"
    And deve existir um único pedido e um único arquivo

  Scenario: [Duplicidade] Segundo pedido igual enquanto o primeiro está em andamento
    Given que existe um pedido de CSV "PROCESSING" de "Rita" para o mesmo relatório e os mesmos filtros
    When "Rita" solicitar outro CSV igual com outra chave de idempotência
    Then a API deve responder 409 com código "REPORT_EXPORT_IN_PROGRESS" e "meta.exportId" do pedido existente

  Scenario: [Concorrência] Dois pedidos iguais ao mesmo tempo
    When "Rita" enviar duas requisições idênticas simultâneas com chaves diferentes
    Then exatamente uma deve criar o pedido e a outra deve receber 409 "REPORT_EXPORT_IN_PROGRESS"

  Scenario: [Concorrência] Fatos mudam durante a geração
    Given que o worker está lendo o relatório de "Rita"
    When o projetor gravar novos fatos e o refresh das visões ocorrer no meio da leitura
    Then o arquivo deve refletir um único instante, o da transação de leitura
    And "dataAsOf" do pedido deve ser a data do read model nesse instante

  Scenario: [Concorrência] Reconstrução do read model em andamento
    Given que existe uma reconstrução "REBUILD" em andamento no tenant
    When o worker iniciar o pedido de "Rita"
    Then o job deve adiar a geração e tentar de novo em 2 minutos
    And ao fim da reconstrução o arquivo deve ser gerado normalmente
    And se a reconstrução passar de 30 minutos o pedido deve terminar "FAILED" com "errorCode" "READ_MODEL_REBUILDING"

  Scenario: [Falha de banco] Banco falha ao registrar o pedido
    Given que o banco de dados falha ao inserir o pedido
    When "Rita" solicitar a exportação
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum pedido, job ou auditoria deve ser criado

  Scenario: [Falha de banco] Banco falha ao concluir o pedido no worker
    Given que o arquivo já foi gravado no S3 e o banco falha ao criar o "Attachment"
    When o worker tentar concluir o pedido
    Then a transação deve ser desfeita sem "Attachment", sem auditoria de sucesso e sem evento
    And o job deve ser repetido e, ao concluir, reutilizar a mesma chave do objeto sem duplicar arquivo

  Scenario: [Falha de integração] S3 indisponível ao gravar o arquivo
    Given que o S3 recusa a gravação
    When o worker gerar o arquivo
    Then o job deve ser repetido com intervalo crescente
    And esgotadas as tentativas o pedido deve terminar "FAILED" com "errorCode" "STORAGE_UNAVAILABLE" sem "Attachment"
    And "Rita" deve receber a notificação de falha com a orientação de tentar de novo

  Scenario: [Falha de integração] Redis indisponível no pedido
    Given que o Redis das filas está indisponível
    When "Rita" solicitar o CSV
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o pedido criado deve ficar "FAILED" com "errorCode" "ENQUEUE_FAILED" e permitir novo pedido

  Scenario: [Falha de integração] Auditoria indisponível no download
    Given que o pedido de "Rita" está "READY" e a gravação da auditoria falha
    When "Rita" solicitar o download
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" sem devolver URL

  Scenario: [Sucesso] Arquivo expira depois de 24 horas
    Given que o pedido de "Rita" ficou "READY" há 25 horas
    When o job de manutenção rodar
    Then o pedido deve ficar "EXPIRED" e o objeto deve ser apagado
    When "Rita" solicitar o download
    Then a API deve responder 410 com código "REPORT_EXPORT_EXPIRED"

  Scenario: [Sucesso] Dados desatualizados são informados no arquivo
    Given que o read model está atualizado há 40 minutos
    When "Rita" exportar o relatório
    Then o pedido deve ter "stale" verdadeiro e a data dos dados da última atualização
    And o diálogo e a aba "Parâmetros" devem avisar que os dados estão desatualizados
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Formato ou conteúdo inválido | 422 | `VALIDATION_ERROR` | "Escolha o formato do arquivo: CSV ou XLSX." | Erro no campo |
| Filtros inválidos | 422 | `VALIDATION_ERROR` | "Os filtros do relatório não são válidos. Ajuste e tente de novo." | Volta ao relatório com os campos destacados |
| Relatório não exportável | 422 | `REPORT_NOT_EXPORTABLE` | "Este relatório não pode ser exportado nesse formato." | Oculta a opção |
| Relatório inexistente | 404 | `NOT_FOUND` | "Relatório não encontrado." | Volta ao catálogo |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para exportar este relatório." | Oculta o botão |
| Exportação grande demais | 422 | `EXPORT_TOO_LARGE` | "O relatório tem {total} linhas. O limite por arquivo é 50.000. Refine o período ou os filtros." | Mensagem no diálogo, filtros mantidos |
| Pedido igual em andamento | 409 | `REPORT_EXPORT_IN_PROGRESS` | "Já existe uma exportação igual em andamento." | Passa a acompanhar o pedido existente |
| Arquivo ainda não pronto | 409 | `REPORT_EXPORT_NOT_READY` | "O arquivo ainda não está pronto." | Mantém o indicador de progresso |
| Arquivo expirado | 410 | `REPORT_EXPORT_EXPIRED` | "O arquivo expirou. Exporte o relatório de novo." | Botão "Exportar de novo" |
| Pedido de outra pessoa ou tenant | 404 | `NOT_FOUND` | "Exportação não encontrada." | Volta ao relatório |
| Falha na geração | — | `errorCode` do pedido | "Não foi possível gerar o arquivo. Tente novamente." (para `PERMISSION_REVOKED`: "Você não tem mais permissão para exportar este relatório."; para `READ_MODEL_REBUILDING`: "Os dados estão sendo reconstruídos. Tente novamente em alguns minutos.") | Botão "Tentar novamente" |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Não foi possível repetir esta ação com os mesmos dados." | Recarrega a lista de exportações |
| Muitas exportações | 429 | `RATE_LIMITED` | "Muitas exportações em andamento. Aguarde a conclusão de uma delas." | Reabilita após `Retry-After` |
| Banco, fila ou auditoria indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-073 (gravação da auditoria: `report.export`, `attachment.download`, `access.denied`), US-083 (worker, filas, *retries*, *dead-letter*, contrato de job, reconciliador), US-172 (catálogo de relatórios, schema de filtros, escopo e cabeçalho "dados atualizados em …"). Indiretas: US-068 (armazenamento seguro e URL assinada), US-003/US-075 (padrão de CSV), US-145 (precedente de pedido assíncrono), US-173 (detalhamento), US-175, US-176, US-177 (provedores de exportação), US-170/US-171 (read model), US-113 (preferências de notificação).
- **Decisões/ADRs:** DEC-206, ADR-014, DEC-105, DEC-163, DEC-164, DEC-024, DEC-030, DEC-132, DEC-184; POL-28, POL-09, POL-14; storage.md §4 e §6; queues.md §2.
- **Configurações:** nenhuma chave nova; limite de 50.000 linhas, validade de 24 h, retenção de 90 dias do registro e prazo de 15 min fixados em código.
- **Lacunas nas fontes canônicas:**
  1. Não existe entidade de pedido de exportação de relatório: proposta **`ReportExport`** (`report_exports`, módulo `analytics`) e os enums `ReportExportFormat` (`CSV`, `XLSX`), `ReportExportContent` (`SUMMARY`, `DETAIL`) e `ReportExportStatus` (`PENDING`, `PROCESSING`, `READY`, `FAILED`, `EXPIRED`); índice único parcial `(tenant_id, requested_by_id, report_key, filters_hash, format, content) WHERE status IN ('PENDING','PROCESSING')`. Incluir em entities.md §4.11 e na migração M2-19 (ou nova M2-24).
  2. `AttachmentTargetType` ganha `REPORT_EXPORT` (M2-01); o *check* de `attachments` (`target_type IN ('TENANT_ASSET','TEMPLATE_VERSION') OR process_id IS NOT NULL`) precisa admitir `REPORT_EXPORT` (como previsto para `PCA` na US-145); arquivos gerados pelo sistema entram `AVAILABLE` sem varredura; prefixo `exports/` no bucket `documents`.
  3. Evento `ReportExportFinished` (`analytics.report_export_finished`; `exportId`, `reportKey`, `format`, `status`, `requestedById`, `errorCode?`; consumidor `N`) e `NotificationType` `REPORT_EXPORT_READY` (in-app obrigatória; e-mail desligado) — a feature FT-081 diz "nenhum evento de domínio novo" e a notificação "se a fila de exportações a oferecer"; registrar em events.md §4 e §6.
  4. A fila de exportações citada por DEC-206/ADR-014 **não existe** em `queues.md` §4: proposta a fila `report-export` (padrão B, job `report-export`, 2 simultâneos por tenant, 5 tentativas, tempo máximo 15 min, `jobId = exportId`), mais a tarefa de expiração no `maintenance` (§4.8) e o reconciliador cobrindo `ReportExport`. Alternativa aceitável: reutilizar `document-render` como na US-145.
  5. Endpoints `ANL-11`, `ANL-12`, `ANL-13` e `ANL-19` (esta story acrescenta a lista de exportações do solicitante) em `/reports/{report}/exports`, `/reports/exports/{id}`, `/reports/exports/{id}/download` e `/reports/exports`; a feature lista só as três primeiras. Códigos novos: `REPORT_EXPORT_IN_PROGRESS` (409), `REPORT_EXPORT_NOT_READY` (409), `REPORT_EXPORT_EXPIRED` (410), `REPORT_NOT_EXPORTABLE` (422). Reutilizados: `EXPORT_TOO_LARGE`, `RATE_LIMITED`, `IDEMPOTENCY_KEY_REUSED`, `PERMISSION_DENIED`, `NOT_FOUND`.
  6. A feature e DEC-206 falam em exportação do "relatório"; esta story define dois conteúdos (`SUMMARY` e `DETAIL`) e a interseção de escopo entre `REPORT_VIEW` e `REPORT_EXPORT` (RN-ANL-110): confirmar com o produto. `AUTORIDADE_COMPETENTE` tem `REPORT_EXPORT` na matriz padrão (permissions.md §3), embora FT-081 não a liste entre os exportadores.
  7. `OFFBOARDING` (DEC-132): incluir `ANL-11` a `ANL-13` e `ANL-19` na lista de rotas de exportação liberadas (`@OffboardingExport()`).
  8. O CSV não carrega aviso de sigilo (formato de dados puro); o aviso fica no XLSX, no diálogo e no estado do pedido. Decisão de produto a confirmar (pergunta aberta 1 do relatório).

## Impacto técnico
- **Performance:** a contagem prévia usa o mesmo manipulador do relatório, apenas com `count(*)`; a geração é *streaming* (cursor em lotes de 1.000 linhas, *backpressure*) com memória constante, inclusive no XLSX (escritor em fluxo). Meta p95 ≤ 60 s para 50.000 linhas e ≤ 10 s para resumo agregado, medida na suíte de performance (endurecimento); não é medida no card.
- **Segurança e LGPD:** o mascaramento ocorre no servidor antes de gerar; escopo e permissão revalidados no job; arquivo só do solicitante, com URL de 300 s e auditoria antes dela; nome de arquivo sem dado pessoal; XLSX sem fórmulas, vínculos ou macros; neutralização de injeção de fórmula no CSV e no XLSX; logs sem conteúdo.
- **Integridade:** `sha256`, contagem e `dataAsOf` guardados no pedido; leitura em transação única; escrita idempotente do objeto (mesma chave).
- **Operação:** jobs seguem a política de filas (tentativas com *jitter*, cópia em `dead-letter` na falha final); pedidos órfãos encerrados pela manutenção; objetos S3 órfãos de transações desfeitas são sobrescritos no *retry* ou removidos pelo ciclo de vida do prefixo `exports/` (7 dias).
- **Compatibilidade:** sem alteração de endpoints do MVP 1; o `Attachment` ganha um valor de alvo (M2-01).
- **Acoplamento:** o contrato `ReportExportProvider` é a única fronteira entre relatórios e exportação; relatórios novos entram sem mexer no job.

## Backend
- **Módulo(s):** `analytics` (dono de `ReportExport`, registro de provedores, geração e regras), `files` (`Attachment`, `StorageService`, URL assinada), `audit`, `platform` (fila e job), `notification` (consumidor), `access` (escopo, interseção, permissão de sigilo, predicado de visibilidade), `organization`, `workflow` e `identity` (rótulos em lote).
- **Casos de uso:** `RequestReportExportCommand` (`ANL-11`), `GetReportExportQuery` (`ANL-12`), `DownloadReportExportQuery` (`ANL-13`), `ListMyReportExportsQuery` (`ANL-19`), job `ReportExportHandler` (`report-export`), `ReportExportExpirySweeper` e `ReportExportTimeoutSweeper` (em `maintenance`), consumidor `ReportExportNotificationConsumer`.
- **Domínio:** `ReportExport` (estados e transições), `ReportExportProvider` e `ReportExportRegistry` (RN-ANL-128), `ExportScopeResolver` (interseção `REPORT_VIEW` × `REPORT_EXPORT`), `ConfidentialValuePolicy` (a mesma da tela), `CsvWriter` (RN-ANL-117), `XlsxStreamWriter` (RN-ANL-118), `ExportFileNamer` (RN-ANL-120).
- **Integrações internas:** `AccessScopeResolver`, `VisibilityPredicate` (DEC-024) para `DETAIL`, `ReportFreshness` (`dataAsOf`, `stale`) da US-172, `StorageService`, `AttachmentService`, `AuditService`, `enqueue()`, `NotificationService`.
- **Transação:** `ANL-11`: validações → contagem → inserção do `ReportExport` → *commit* → enfileiramento (falha → `FAILED ENQUEUE_FAILED`). Job: `PROCESSING` → revalidação → leitura `READ ONLY` consistente → geração e envio ao S3 → transação única (`Attachment`, `ReportExport READY`, `report.export`, evento no *outbox*).

## Frontend
- **Tela(s):** SCR-027 (`/relatorios`) e SCR-028 (`/relatorios/[relatorio]`): botão "Exportar" no cabeçalho do relatório e painel "Exportações recentes".
- **Componentes:** `ExportButton`, `ExportDialog` (resumo dos filtros, escopo, avisos de sigilo e de dados desatualizados, escolha de formato e conteúdo), `ExportProgress` (consulta a cada 2 s, `aria-live`), `RecentExportsPanel` (formato, relatório, quando, situação, validade, "Baixar", "Exportar de novo"), `ConfidentialExcludedNotice`.
- **Estados:** loading (skeleton), vazio ("Você ainda não exportou nenhum relatório"), erro com "Tentar novamente", sucesso (toast "Arquivo pronto para download.").
- **Acessibilidade e responsividade:** andamento anunciado por `aria-live="polite"`; situação do pedido por texto e ícone (nunca só cor); foco devolvido ao botão "Exportar" ao fechar o diálogo; painel de exportações recentes em cartões abaixo de 768 px; botão "Baixar" desabilitado com texto explicativo quando `EXPIRED`.

## Banco de dados
- **Tabelas:** `report_exports` (nova), `attachments` (`target_type = REPORT_EXPORT`), `audit_logs`, `outbox_events`.
- **Migrações:** criar `report_exports` e os enums de formato, conteúdo e situação, junto com o valor `REPORT_EXPORT` de `AttachmentTargetType` (M2-01) e o ajuste do *check* de `attachments`; reversível (a tabela é nova; o valor de enum não é removível).
- **Índices/constraints relevantes:** único parcial `(tenant_id, requested_by_id, report_key, filters_hash, format, content) WHERE status IN ('PENDING','PROCESSING')`; `(tenant_id, requested_by_id, requested_at DESC)`; `(tenant_id, status, expires_at)` para a expiração; *check* `status <> 'READY' OR (attachment_id IS NOT NULL AND sha256 IS NOT NULL AND expires_at IS NOT NULL)`; FK composta com o tenant e RLS como nas demais tabelas; `filters` em `jsonb` normalizado e `filters_hash` (sha256 do JSON canônico + escopo).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `ANL-11` | POST | `/reports/{report}/exports` | `{ format, content?, filters }` · `Idempotency-Key` | `202 { data: ReportExport (PENDING) }` · `Location` | 202, 403, 404, 409, 422, 429, 503 |
| `ANL-12` | GET | `/reports/exports/{id}` | — | `200 { data: ReportExport }` (estado, `scopeLabel`, `confidentialExcluded`, `dataAsOf`, `stale`, `rowsCount`, `fileExpiresAt`, `errorCode`) | 200, 403, 404 |
| `ANL-13` | GET | `/reports/exports/{id}/download` | — | `200 { data: { url, urlExpiresAt } }` (300 s) | 200, 403, 404, 409, 410, 503 |
| `ANL-19` | GET | `/reports/exports?page=&pageSize=` | paginação (≤ 50) | `200 { data: ReportExport[], meta }` mais recentes primeiro, só do solicitante | 200, 403 |

## Logs
- `info` `report.export.requested` — `exportId`, `reportKey`, `format`, `content`, `rowsEstimate`.
- `info` `report.export.ready` — `exportId`, `format`, `durationMs`, `rowsCount`, `sizeBytes`, `confidentialExcluded`.
- `warn` `report.export.deferred` — `exportId`, motivo `REBUILD_RUNNING`.
- `warn` `report.export.permission_revoked` — `exportId`, `requestedById`.
- `error` `report.export.failed` — `exportId`, `errorCode`, `attempt`.
- **Nunca logar:** linhas, valores e códigos de processo, nomes de pessoas, filtros por responsável, nome do arquivo e URLs assinadas.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `report.export` | `EXPORT` | Conclusão do pedido (`SUCCESS` ou `FAILURE`) | `metadata`: `exportId`, `reportKey`, `format`, `content`, `filters` (normalizados, sem valores), `dimension?`, `rowsCount`, `confidentialExcluded`, `dataAsOf`, `scopeLabel`, `attachmentId`, `sha256`, `sizeBytes`, `outcome`, `reasonCode?` |
| `attachment.download` | `EXPORT` | Antes de devolver a URL de `ANL-13` | `metadata`: `attachmentId`, `exportId`, `reportKey` |
| `access.denied` | `ACCESS` | Tentativa sem `REPORT_EXPORT`/`REPORT_VIEW` | `reasonCode` = `REPORT_EXPORT` |

## Testes necessários
- **Unitários:** `ExportScopeResolver` (interseção); `CsvWriter` (BOM, `;`, CRLF, decimais, aspas, injeção de fórmula); `XlsxStreamWriter` (abas, tipos, ausência de fórmulas, propriedades); `ExportFileNamer`; `ReportExport` (transições e expiração); `ReportExportRegistry`.
- **Integração (Testcontainers PostgreSQL + Redis + MinIO):** fluxo completo CSV e XLSX; leitura consistente; índice único de pedido ativo; *retry* e *dead-letter*; falha de S3 e de banco no meio do job; adiamento por `REBUILD`; permissão revogada; auditoria antes da URL; expiração e remoção do objeto; reconciliador de pedido órfão.
- **API/contrato:** `ANL-11`, `ANL-12`, `ANL-13`, `ANL-19`; `202` + `Location`; idempotência; códigos novos; URL de 300 s.
- **Paridade (obrigatória):** para cada provedor, dados da tela (`GET` do relatório) = linhas do arquivo, com e sem permissão de sigilo, com escopo de órgão e de secretaria.
- **RBAC e multi-tenant:** `REPORT_EXPORT` × `REPORT_VIEW` por escopo; pedido de outra pessoa e de outro tenant → 404 (suíte `test/tenant-leak`); **teste de sigilo**: arquivo sem valor sigiloso para quem não tem a permissão (arquivo, auditoria, logs, notificação e evento), inclusive por diferença entre recortes.
- **Concorrência:** dois pedidos idênticos simultâneos; exportar × refresh das visões; exportar × `REBUILD`.
- **E2E (Playwright):** abrir o diálogo, exportar CSV e XLSX, ver o andamento, baixar, ver "Exportações recentes", mensagem de falha com "Tentar novamente".
- **Acessibilidade/performance:** axe no diálogo e no painel; exportação de 50.000 linhas (CSV e XLSX) com p95 ≤ 60 s na suíte de performance (medida no endurecimento).

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
- [ ] Teste de paridade tela × arquivo verde para cada provedor registrado
- [ ] Teste de sigilo e de dados pessoais no arquivo (CSV e XLSX) verde
- [ ] Métricas `cf_report_export_duration_seconds{format,content}` e `cf_report_export_total{status}` e alerta de pedidos `FAILED` publicados

## Estimativa
**M** — reaproveita fila, armazenamento, auditoria, CSV padrão e o precedente da US-145; o trabalho é o registro do pedido, o contrato de provedores, o escritor XLSX em fluxo, a revalidação no job, a expiração e o diálogo. Sem tela nova.

## Prioridade
**P1** — a exportação auditada é critério de aceite da FT-081 e da prestação de contas da gestão; vem depois dos relatórios (US-172), sem bloquear a leitura em tela.

---
id: US-145
title: "Exportar o PCA para divulgação"
epic: EP-023
feature: FT-071
mvp: 2
priority: P1
estimate: S
status: Especificada
depends_on: [US-083, US-140]
modules: [pca, files, organization, catalog, process, audit, platform]
screens: [SCR-018]
endpoints: [PCA-32, PCA-33, PCA-34, PCA-35, PCA-36]
permissions: [PCA_EXPORT, PCA_VIEW]
events: []
---

# US-145 — Exportar o PCA para divulgação

## Título
Exportar o PCA para divulgação

## Descrição
**Como** planejamento do órgão (`PLANEJAMENTO`), controle interno (`CONTROLE_INTERNO`) ou auditor (`AUDITOR`) com a permissão de exportar o PCA, **quero** gerar, a partir do plano vigente já aprovado, um arquivo **CSV** (dados abertos) e um **PDF** (documento para leitura) apenas com os campos públicos, com cabeçalho de órgão, exercício, versão e data de aprovação, **para** cumprir a divulgação do plano em sítio oficial (Lei 14.133/2021, art. 12, § 1º) até a publicação automática do MVP 3, sem montar planilha à mão e sem expor dado sigiloso.

A geração é assíncrona (fila `document-render`, Gotenberg para o PDF, S3 para o arquivo), registrada em um `PcaExport` por pedido, com o arquivo salvo como `Attachment` de alvo `PCA`, auditoria `pca.export` e atualização de `Pca.exportedAt` (data do último arquivo gerado para divulgação).

## Contexto
- DEC-197: "exportação para divulgação em sítio oficial (art. 12, § 1º) até a publicação automatizada do MVP 3". Roadmap §4.2: divulgação por exportação; publicação no PNCP e em sítio oficial é do MVP 3 (PEND-16, DEC-210).
- FT-071 / RN-PCA-26: só o plano `APPROVED` é exportado, com `PCA_EXPORT`, auditado (`pca.export`) e atualizando `exportedAt`. A feature fala em CSV e XLSX; **esta story entrega CSV e PDF** (decisão desta especificação, lacuna 1).
- MVP 1: exportações de lista/auditoria são síncronas em *streaming* (US-003, US-075) com formato de CSV já padronizado (RN-PROC-43/44); a geração de PDF usa o Gotenberg pela fila `document-render` (US-067, ADR-007). Esta story reutiliza o formato de CSV, a fila e o disjuntor do Gotenberg e a política de filas da US-083 (retries com *jitter*, *dead-letter*, tentativas por *breaker*).
- Armazenamento: `storage.md` reserva `tenants/{tenantId}/exports/{exportId}/…` para exportações; o download usa URL assinada de 300 s e auditoria antes da URL (storage.md §6).
- Sigilo (DEC-030, POL-09): o arquivo é de divulgação pública; por isso a mesma saída vale para quem o gera, tenha ou não `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (RN-PCA-334).
- Lacuna L-07: `CONSULTOR_EXTERNO` não acessa o PCA. LGPD: o arquivo não inclui o responsável pelo item (dado de pessoa), apenas a secretaria.

## Objetivo
Gerar, em até 30 s (p95) para plano de 500 itens, um CSV e um PDF fiéis ao plano vigente, com 0 dado sigiloso ou pessoal vazado, rastreáveis (quem, quando, qual versão, hash do arquivo), sem duplicar arquivos em cliques repetidos e com falha de Gotenberg ou S3 tratada sem perder o pedido.

## Persona
- **Principal:** Planejamento (`PLANEJAMENTO`, `PCA_EXPORT` com escopo `ORGANIZATION`/`TENANT`).
- **Secundárias:** Controle Interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`), que exportam para conferência; Gestor de contratações (`GESTOR_CONTRATACOES`), que exporta o plano para a mesma finalidade; Autoridade competente (`AUTORIDADE_COMPETENTE`), que consulta o plano mas não exporta (sem `PCA_EXPORT`).

## Pré-condições
- Plano do órgão e exercício em `APPROVED` (versão vigente, US-140).
- `PCA_EXPORT` com escopo que cubra o órgão inteiro do plano (`ORGANIZATION` ou `TENANT`).
- Fila `document-render` configurada; Gotenberg e bucket `documents` disponíveis para o PDF e o CSV (sem eles, o pedido fica na fila — FA-06).
- `Organization` com nome e CNPJ; logotipo opcional em `branding.logoAttachmentId`.

## Fluxo principal
1. Em `/pca/[pcaId]` (SCR-018), aba "Divulgação", a pessoa vê a versão vigente, a data de aprovação, a data da última exportação e o botão "Exportar para divulgação".
2. Ao abrir o diálogo, o front chama `PCA-36` e mostra a prévia: órgão, exercício, versão, aprovação, "116 itens serão divulgados", "4 itens com valor sigiloso sairão como Sigiloso", "2 itens cancelados não aparecem" e as colunas incluídas.
3. A pessoa escolhe o formato (CSV ou PDF) e confirma. O front chama `PCA-32` com `format` e `Idempotency-Key`.
4. A API autoriza (`PCA_EXPORT`, escopo de órgão), valida que o plano está `APPROVED` e dentro do limite de itens e cria o `PcaExport` em `PENDING`. Se já houver exportação ativa do mesmo plano e formato, devolve `409 PCA_EXPORT_IN_PROGRESS` com o `exportId`.
5. Depois do *commit*, enfileira o job `pca-export` em `document-render` e responde `202` com `exportId` e `Location`.
6. O front acompanha por `PCA-33` (a cada 2 s, até 90 s) e mostra "Gerando arquivo…".
7. O worker (`runJob`, contexto do tenant e do solicitante) marca `PROCESSING`, revalida o plano e lê os itens públicos numa transação `READ ONLY` consistente, aplica o mascaramento do sigilo (RN-PCA-334) e monta o arquivo: CSV pelo gerador de linhas; PDF por HTML de layout fixo convertido no Gotenberg.
8. Grava o arquivo no S3 (`tenants/{tenantId}/exports/{exportId}/…`) e, numa transação: cria o `Attachment` (`targetType = PCA`, `targetId` = id do pedido, `status = AVAILABLE`, `sha256`), marca o `PcaExport` `READY` com tamanho, hash e contagens, atualiza `Pca.exportedAt` e grava a auditoria `pca.export` (`SUCCESS`).
9. O front mostra "Arquivo pronto" com o botão "Baixar" (`PCA-34`: devolve `{ url, expiresAt }` de 300 s depois de gravar a auditoria de download). O histórico das exportações fica em "Exportações anteriores" (`PCA-35`).

## Fluxos alternativos
- **FA-01 — Plano não vigente:** plano `DRAFT`, `AWAITING_APPROVAL` ou `SUPERSEDED` responde `409 INVALID_STATE`; a aba "Divulgação" só aparece no plano `APPROVED`.
- **FA-02 — Escopo insuficiente:** `PCA_EXPORT` com escopo de unidade responde `403 PERMISSION_DENIED`: o arquivo cobre o plano inteiro e uma divulgação parcial induziria erro.
- **FA-03 — Exportação já em andamento:** clique repetido, outra aba ou outra pessoa para o mesmo plano e formato recebe `409 PCA_EXPORT_IN_PROGRESS` com `meta.exportId`; o diálogo passa a acompanhar o pedido existente.
- **FA-04 — Plano substituído durante a geração:** se a revisão for aprovada entre o pedido e a geração, o job termina `FAILED` com `errorCode = PLAN_CHANGED`; a UI diz "O plano foi substituído por uma nova versão. Exporte novamente." e nenhum arquivo é publicado.
- **FA-05 — Plano grande:** acima de 5.000 itens o pedido é recusado com `422 EXPORT_TOO_LARGE` e `meta.totalItems`.
- **FA-06 — Gotenberg indisponível:** o disjuntor pausa a fila sem consumir tentativa; o pedido segue `PENDING`/`PROCESSING`; a UI mostra "A geração do PDF está demorando. O CSV continua disponível." Passados 15 min, o pedido termina `FAILED` (`TIMEOUT`) e a UI oferece "Tentar novamente".
- **FA-07 — S3 indisponível:** falha transitória reentra com *backoff*; esgotadas as tentativas, `FAILED` com `STORAGE_UNAVAILABLE`, sem `Attachment`, sem atualização de `exportedAt`.
- **FA-08 — Redis indisponível no pedido:** a API não consegue enfileirar; marca o pedido `FAILED` (`ENQUEUE_FAILED`) e responde `503`; nada fica pendente sem job.
- **FA-09 — Itens com valor sigiloso:** saem com "Sigiloso" no valor e ficam fora do total divulgado (RN-PCA-334); a prévia informa a quantidade.
- **FA-10 — Baixar de novo:** `PCA-34` pode ser chamado enquanto o arquivo existir; cada download gera sua auditoria e uma nova URL.
- **FA-11 — Nova exportação:** cada pedido gera arquivo e registro próprios; não há reaproveitamento do anterior (cada divulgação é um ato auditável).

## Regras de negócio
- **RN-PCA-330** — Só o plano `APPROVED` (vigente) é exportável (refina RN-PCA-26); `SUPERSEDED`, `DRAFT` e `AWAITING_APPROVAL` → `409 INVALID_STATE`. O job revalida o estado no início e dentro da transação de leitura; se mudou, termina `FAILED` com `PLAN_CHANGED`.
- **RN-PCA-331** — Exige `PCA_EXPORT` com escopo `ORGANIZATION`/`TENANT` cobrindo o órgão do plano (o arquivo é o plano inteiro). Matriz padrão: `GESTOR_CONTRATACOES`, `PLANEJAMENTO`, `CONTROLE_INTERNO` e `AUDITOR`. `PCA-35` (histórico) exige o mesmo; `PCA-33`/`PCA-34` só atendem ao solicitante ou a quem tem `PCA_EXPORT` no escopo do órgão.
- **RN-PCA-332** — Formatos: `CSV` e `PDF` (enum `PcaExportFormat`). Não há XLSX nesta story.
- **RN-PCA-333** — Conteúdo público: por item, **Código do item**, **Secretaria** (nome do `Department`), **Objeto**, **Categoria** (`CatalogItem`), **Classe do catálogo** e **Código do catálogo** (quando houver), **Tipo de contratação**, **Quantidade**, **Unidade de medida**, **Mês previsto** (`MM/AAAA` do exercício), **Valor previsto (R$)**, **Prioridade** e **Situação** (rótulos da terminologia, DEC-184). Ficam de fora: responsável (pessoa), `notes`, `statusReason`, identificadores internos, `importRowNumber`, vínculos e processos, valores estimados de processos e nomes de aprovadores. Itens `CANCELED` e excluídos não aparecem. Ordem: nome da secretaria (ordenação do idioma pt-BR) e código natural. O PDF traz um subconjunto: código, secretaria, objeto, categoria, mês previsto, valor previsto e situação.
- **RN-PCA-334** — Sigilo: o valor previsto de item com ao menos um vínculo `Process.pcaItemId` (ou, na janela de revisão, `previousItemId` — RN-PCA-208) com `isBudgetConfidential = true` e processo diferente de `CANCELED` sai como `Sigiloso`, **para qualquer pessoa que exporte**, e não entra no total. O total divulgado é a soma dos valores exibidos; o PDF e a prévia trazem "N itens com valor sigiloso (art. 24 da Lei 14.133/2021) não incluídos no total". A leitura do sigilo passa pela porta de leitura de vínculos, sem filtro de visibilidade do solicitante (lacuna 3). Nenhum valor mascarado vai para arquivo, log, auditoria ou prévia.
- **RN-PCA-335** — Identificação: o **PDF** traz, no cabeçalho de todas as páginas, `{Órgão} — CNPJ — PCA {exercício} — versão {n} — aprovado em {DD/MM/AAAA}` e, no rodapé, "Gerado em {DD/MM/AAAA HH:mm}" e "Página x de y"; na primeira página, o logotipo do órgão quando houver. No **CSV**, cada linha repete as colunas **Órgão**, **CNPJ do órgão**, **Exercício**, **Versão do plano** e **Data de aprovação**, para que o arquivo seja autossuficiente como dado aberto. Datas no fuso do tenant.
- **RN-PCA-336** — CSV: UTF-8 com BOM, separador `;`, fim de linha CRLF, cabeçalho em pt-BR, decimais com vírgula e sem milhar, datas `DD/MM/AAAA`, aspas e quebras conforme RFC 4180, e proteção contra injeção de fórmula (RN-PROC-43): célula de texto iniciada por `=`, `+`, `-`, `@`, tabulação ou retorno de carro recebe o prefixo `'`.
- **RN-PCA-337** — PDF: HTML do layout fixo `pca-disclosure` (não é um `DocumentTemplate`), A4 paisagem, tabela com cabeçalho repetido a cada página, texto pesquisável (nunca imagem), convertido pelo Gotenberg (Chromium). Falha 4xx do Gotenberg é permanente; 5xx, *timeout* e conexão são transitórios; disjuntor aberto pausa a fila sem consumir tentativa (queues.md §10.3).
- **RN-PCA-338** — Assincronia e estados: `PcaExport.status` (`PcaExportStatus`) `PENDING → PROCESSING → READY | FAILED`. O job `pca-export` roda na fila `document-render` com o contrato comum (`JobMeta` do tenant e do solicitante, DEC-164) e as tentativas padrão (DEC-163). Pedido `PENDING`/`PROCESSING` por mais de 15 min é encerrado como `FAILED` (`TIMEOUT`) pelo job `maintenance`.
- **RN-PCA-339** — Registro: o `PcaExport` guarda `pcaId`, `format`, `requestedById`, `requestedAt`, `startedAt`, `finishedAt`, `attachmentId`, `fileName`, `sizeBytes`, `sha256`, `versionNumber`, `itemsCount`, `maskedItemsCount`, `attempts`, `errorCode` e `errorMessage` (sanitizada). O arquivo é um `Attachment` (`targetType = PCA`, `processId` nulo), chave `tenants/{tenantId}/exports/{exportId}/pca-{ano}-v{n}-{AAAAMMDD}.{ext}` (nome sanitizado conforme storage.md §4), gravado uma vez por pedido (retry reescreve a mesma chave com o mesmo conteúdo).
- **RN-PCA-340** — `Pca.exportedAt` recebe o `finishedAt` do último pedido `READY`; a atualização não incrementa `Pca.version` (para não gerar `412` em ações concorrentes sobre o plano, como criar revisão).
- **RN-PCA-341** — Idempotência e frequência: `Idempotency-Key` em `PCA-32` (DEC-105; mesma chave e mesmo corpo em 24 h devolvem o mesmo pedido, com `Idempotent-Replayed`); no máximo **uma exportação ativa** (`PENDING`/`PROCESSING`) por plano e formato (índice único parcial); limite de 20 requisições por minuto da classe "Exportações e renderização" (api.md §1.6) → `429 RATE_LIMITED`.
- **RN-PCA-342** — Limite: até 5.000 itens por arquivo; acima → `422 EXPORT_TOO_LARGE` sem criar pedido.
- **RN-PCA-343** — Auditoria: `pca.export` (`EXPORT`) é gravada pelo worker na transação que conclui o pedido (`SUCCESS` em `READY`, `FAILURE` com `reasonCode` em `FAILED`), com ator = solicitante; o download grava `attachment.download` (`EXPORT`) **antes** de devolver a URL e, se a auditoria falhar, a resposta é `503` (storage.md §6).
- **RN-PCA-344** — Consistência dos dados: o job lê plano, itens e vínculos numa única transação `REPEATABLE READ`/`READ ONLY` com `app.tenant_id`, para que o arquivo represente um instante do plano.
- **RN-PCA-345** — Prévia (`PCA-36`): somente leitura, devolve os mesmos números que o arquivo terá (itens divulgados, cancelados omitidos, sigilosos mascarados, total divulgado, colunas) e avisos (`ITEMS_WITH_CONFIDENTIAL_VALUE`, `PREVIOUSLY_EXPORTED` com a data); não grava nada.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Formato | `format` | `PcaExportFormat` (`CSV`, `PDF`) | Sim | RN-PCA-332 | — |
| Plano | `{pcaId}` (rota) | uuid | Sim | `APPROVED` (RN-PCA-330) | plano aberto |
| Situação do pedido | `PcaExport.status` | `PcaExportStatus` | — | `PENDING`, `PROCESSING`, `READY`, `FAILED` | `PENDING` |
| Solicitante | `PcaExport.requestedById` | uuid | — | usuário autenticado | sessão |
| Solicitada em | `PcaExport.requestedAt` | data/hora | — | — | `now()` |
| Concluída em | `PcaExport.finishedAt` | data/hora | — | — | worker |
| Versão exportada | `PcaExport.versionNumber` | inteiro | — | congelado no pedido | plano |
| Itens divulgados | `PcaExport.itemsCount` | inteiro | — | sem cancelados | worker |
| Itens com valor sigiloso | `PcaExport.maskedItemsCount` | inteiro | — | RN-PCA-334 | worker |
| Arquivo | `PcaExport.attachmentId` | uuid | — | `Attachment` `PCA` | worker |
| Nome do arquivo | `PcaExport.fileName` | texto (255) | — | RN-PCA-339 | gerado |
| Tamanho / hash | `sizeBytes`, `sha256` | bigint / texto (64) | — | do arquivo gravado | worker |
| Motivo da falha | `errorCode` | texto (40) | — | `PLAN_CHANGED`, `RENDER_FAILED`, `STORAGE_UNAVAILABLE`, `TIMEOUT`, `ENQUEUE_FAILED` | worker |
| Última divulgação | `Pca.exportedAt` | data/hora | — | RN-PCA-340 | worker |
| Colunas do CSV | — | lista fixa | — | RN-PCA-333 e RN-PCA-335 | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `format` ausente ou fora de `CSV`/`PDF` | Front + API (Zod) | "Escolha o formato do arquivo: CSV ou PDF." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-02 | Plano fora de `APPROVED` | API | "Só o plano vigente, já aprovado, pode ser exportado." | `INVALID_STATE` |
| V-03 | Escopo de `PCA_EXPORT` não cobre o órgão do plano | API | "Você não tem permissão para exportar o plano do órgão." | `PERMISSION_DENIED` |
| V-04 | Plano com mais de 5.000 itens | API | "O plano tem {total} itens. O limite por arquivo é 5.000." | `EXPORT_TOO_LARGE` |
| V-05 | Já existe exportação ativa do mesmo plano e formato | API (+ índice único) | "Já existe uma exportação em andamento para este plano." | `PCA_EXPORT_IN_PROGRESS` |
| V-06 | Download de pedido que não está `READY` | API | "O arquivo ainda não está pronto." | `PCA_EXPORT_NOT_READY` |
| V-07 | `exportId` de outro plano ou de outro tenant | API | "Exportação não encontrada." | `NOT_FOUND` |
| V-08 | Mesma `Idempotency-Key` com corpo diferente | API | "Não foi possível repetir esta ação com os mesmos dados." | `IDEMPOTENCY_KEY_REUSED` |
| V-09 | Limite de requisições de exportação | API | "Muitas exportações em pouco tempo. Aguarde alguns instantes." | `RATE_LIMITED` |

## Permissões
- **Permissão:** `PCA_EXPORT` (risco `M`) com escopo `ORGANIZATION`/`TENANT` cobrindo o órgão do plano, para `PCA-32` a `PCA-36`; `PCA_VIEW` apenas para ver o plano e a data da última exportação.
- **Políticas:** POL-22 (administração do PCA), POL-09 (sigilo — o arquivo é sempre gerado na visão pública, RN-PCA-334), DEC-024 não se aplica (o arquivo não lista processos).
- **MFA:** não exigido por permissão de risco `M`; se a política do tenant for `ALL`, `MFA_REQUIRED` (POL-14).
- **Sem permissão:** a aba "Divulgação" e o botão ficam ocultos; a API responde `403 PERMISSION_DENIED` e registra `access.denied` (`reasonCode` = `PCA_EXPORT`). Plano ou pedido de outro tenant: `404 NOT_FOUND`. `CONSULTOR_EXTERNO`: `404` em todo o PCA (L-07).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio (FT-071). O ato fica na auditoria `pca.export` e no registro `PcaExport`. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | Nenhuma | — | A tela acompanha o pedido; o histórico guarda o resultado. Aviso de conclusão por e-mail não faz parte desta story (lacuna 6). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Exportar o PCA para divulgação

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o plano "PCA 2027" do órgão "Prefeitura A" está "APPROVED" na versão 2, aprovado em 12/03/2027, com 120 itens
    And 2 itens estão "CANCELED" e 4 itens estão vinculados a processos com orçamento sigiloso
    And "Roberto" tem "PCA_EXPORT" com escopo "ORGANIZATION"

  Scenario: [Sucesso] Exportar o plano em CSV
    When "Roberto" solicitar a exportação do plano em "CSV"
    Then a API deve responder 202 com um pedido "PENDING"
    And o pedido deve terminar "READY" com 118 itens divulgados e 4 itens com valor sigiloso
    And o CSV deve ter UTF-8 com BOM, separador ";" e as colunas de órgão, exercício, versão e data de aprovação em todas as linhas
    And os itens "CANCELED" e a coluna de responsável não devem constar do arquivo
    And a data "exportedAt" do plano deve ser atualizada
    And deve gerar registro de auditoria "pca.export" com o formato, a versão, a contagem e o hash do arquivo

  Scenario: [Sucesso] Exportar o plano em PDF com cabeçalho e rodapé
    When "Roberto" solicitar a exportação do plano em "PDF"
    Then o pedido deve terminar "READY" e o PDF deve ser pesquisável
    And cada página deve trazer "Prefeitura A — PCA 2027 — versão 2 — aprovado em 12/03/2027" e "Página x de y"
    And o total deve somar apenas os itens sem valor sigiloso e informar "4 itens com valor sigiloso"

  Scenario: [Sucesso] Valor sigiloso sai mascarado mesmo para quem tem a permissão de sigilo
    Given que "Roberto" também tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    When "Roberto" exportar o plano em "CSV"
    Then os 4 itens com processo sigiloso devem sair com o valor "Sigiloso"
    And nenhum valor desses itens deve aparecer no arquivo, na auditoria nem nos logs

  Scenario: [Sucesso] Baixar o arquivo gerado
    Given que o pedido está "READY"
    When "Roberto" solicitar o download
    Then a API deve responder 200 com uma URL assinada válida por 300 segundos
    And deve existir registro de auditoria "attachment.download" gravado antes da URL

  Scenario: [Validação] Formato ausente e plano não vigente
    When "Roberto" solicitar a exportação sem informar o formato
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "format"
    Given que o plano "PCA 2026" está "SUPERSEDED"
    When "Roberto" solicitar a exportação do plano "PCA 2026"
    Then a API deve responder 409 com código "INVALID_STATE"
    And nenhum pedido deve ser criado

  Scenario: [Validação] Texto com fórmula é neutralizado no CSV
    Given que o objeto do item "PCA-050" começa com "=SOMA(A1:A9)"
    When "Roberto" exportar o plano em "CSV"
    Then a célula do objeto do item "PCA-050" deve começar com um apóstrofo antes do sinal "="

  Scenario: [Validação] Plano com mais de 5.000 itens
    Given que o plano "PCA 2028" vigente tem 5.200 itens
    When "Roberto" solicitar a exportação do plano "PCA 2028"
    Then a API deve responder 422 com código "EXPORT_TOO_LARGE" e "meta.totalItems" 5200

  Scenario: [Permissão] Sem PCA_EXPORT ou com escopo de unidade
    Given que "Clara" tem "PCA_VIEW" mas não "PCA_EXPORT"
    And "Marta" tem "PCA_EXPORT" com escopo apenas da "Secretaria de Educação"
    When "Clara" e "Marta" solicitarem a exportação
    Then a API deve responder 403 com código "PERMISSION_DENIED" para as duas
    And o botão "Exportar para divulgação" não deve ser exibido para elas
    And deve gerar registro de auditoria "access.denied" para cada tentativa

  Scenario: [Tenant incorreto] Exportar plano ou baixar pedido de outro tenant
    Given que existe o plano "PCA 2027" e um pedido pronto no tenant "Prefeitura B"
    When "Roberto", no tenant "Prefeitura A", pedir a exportação ou o download desses recursos
    Then a API deve responder 404 com código "NOT_FOUND" nos dois casos
    And nenhum dado, nome de arquivo ou URL do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Clique repetido com a mesma chave de idempotência
    Given que "Roberto" solicitou o CSV com a "Idempotency-Key" "k-145"
    When a mesma requisição for reenviada com o mesmo corpo
    Then a API deve responder com "Idempotent-Replayed" verdadeiro e o mesmo "exportId"
    And deve existir um único pedido e um único arquivo

  Scenario: [Duplicidade] Segundo pedido enquanto o primeiro está em andamento
    Given que existe um pedido de CSV "PROCESSING" do plano
    When "Paula" solicitar outro CSV do mesmo plano
    Then a API deve responder 409 com código "PCA_EXPORT_IN_PROGRESS" e "meta.exportId" do pedido existente

  Scenario: [Concorrência] Revisão aprovada durante a geração
    Given que o pedido de PDF está "PROCESSING" e "Paulo" aprova a revisão que substitui a versão 2
    When o worker revalidar o plano
    Then o pedido deve terminar "FAILED" com "errorCode" "PLAN_CHANGED"
    And nenhum arquivo deve ser publicado, "exportedAt" não deve mudar e a auditoria "pca.export" deve registrar falha

  Scenario: [Concorrência] Exportar e criar revisão ao mesmo tempo
    When "Roberto" concluir uma exportação enquanto "Helena" cria uma revisão com "If-Match" da versão 2
    Then a criação da revisão não deve receber 412 por causa da atualização de "exportedAt"

  Scenario: [Falha de banco] Banco falha ao registrar o pedido
    Given que o banco de dados falha ao inserir o pedido
    When "Roberto" solicitar a exportação
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum pedido, job ou auditoria deve ser criado

  Scenario: [Falha de banco] Banco falha ao concluir o pedido no worker
    Given que o arquivo já foi gravado no S3 e o banco falha ao criar o "Attachment"
    When o worker tentar concluir o pedido
    Then a transação deve ser desfeita sem "Attachment", sem "exportedAt" e sem auditoria de sucesso
    And o job deve ser repetido e, ao concluir, reutilizar a mesma chave do objeto sem duplicar arquivo

  Scenario: [Falha de integração] Gotenberg indisponível para o PDF
    Given que o Gotenberg está indisponível
    When "Roberto" solicitar o PDF
    Then o pedido deve permanecer "PENDING" ou "PROCESSING" sem consumir tentativas
    And a tela deve informar que o PDF está demorando e que o CSV continua disponível
    When "Roberto" solicitar o CSV
    Then o CSV deve ser gerado normalmente
    And passados 15 minutos sem recuperação o pedido de PDF deve terminar "FAILED" com "errorCode" "TIMEOUT"

  Scenario: [Falha de integração] S3 indisponível ao gravar o arquivo
    Given que o S3 recusa a gravação
    When o worker gerar o CSV
    Then o job deve ser repetido com intervalo crescente
    And esgotadas as tentativas o pedido deve terminar "FAILED" com "errorCode" "STORAGE_UNAVAILABLE" sem "Attachment"

  Scenario: [Falha de integração] Redis indisponível no pedido
    Given que o Redis das filas está indisponível
    When "Roberto" solicitar o CSV
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o pedido criado deve ficar "FAILED" com "errorCode" "ENQUEUE_FAILED" e permitir novo pedido
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Formato inválido | 422 | `VALIDATION_ERROR` | "Escolha o formato do arquivo: CSV ou PDF." | Erro no campo |
| Plano não vigente | 409 | `INVALID_STATE` | "Só o plano vigente, já aprovado, pode ser exportado." | Recarrega o plano |
| Plano grande demais | 422 | `EXPORT_TOO_LARGE` | "O plano tem {total} itens. O limite por arquivo é 5.000." | Mensagem no diálogo |
| Exportação já em andamento | 409 | `PCA_EXPORT_IN_PROGRESS` | "Já existe uma exportação em andamento para este plano." | Passa a acompanhar o pedido existente |
| Arquivo ainda não pronto | 409 | `PCA_EXPORT_NOT_READY` | "O arquivo ainda não está pronto." | Mantém o indicador de progresso |
| Falha na geração | — | `errorCode` do pedido (`RENDER_FAILED`, `STORAGE_UNAVAILABLE`, `PLAN_CHANGED`, `TIMEOUT`, `ENQUEUE_FAILED`) | "Não foi possível gerar o arquivo. Tente novamente." (para `PLAN_CHANGED`: "O plano foi substituído por uma nova versão. Exporte novamente.") | Botão "Tentar novamente" |
| Sem permissão ou escopo | 403 | `PERMISSION_DENIED` | "Você não tem permissão para exportar o plano do órgão." | Oculta a ação |
| Plano ou pedido de outro tenant | 404 | `NOT_FOUND` | "Exportação não encontrada." | Volta à lista de planos |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Não foi possível repetir esta ação com os mesmos dados." | Recarrega o histórico |
| Muitas requisições | 429 | `RATE_LIMITED` | "Muitas exportações em pouco tempo. Aguarde alguns instantes." | Reabilita após `Retry-After` |
| Banco, fila ou auditoria indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-083 (worker, filas, *retries*, *dead-letter*, contrato de job e disjuntor), US-140 (plano `APPROVED`, `approvedAt`). Indiretas: US-067 (Gotenberg/PDF), US-068 (armazenamento seguro), US-003/US-075 (padrão de exportação e CSV), US-141 (revisão — RN-PCA-334/110), US-142 (vínculos, para o sigilo), US-144 (porta de leitura de vínculos).
- **Decisões/ADRs:** DEC-197, DEC-030, DEC-105, DEC-163, DEC-164, DEC-052, DEC-184, DEC-210; ADR-007 (PDF), storage.md §4 e §6.
- **Configurações:** `branding.logoAttachmentId` (logotipo opcional). Nenhuma chave nova: limite de 5.000 itens, prazo de 15 min e tamanho do PDF fixados em código.
- **Lacunas nas fontes canônicas:**
  1. FT-071 e DEC-197 falam em CSV/XLSX; adotado **CSV e PDF** por decisão desta especificação. XLSX não é entregue.
  2. Não há entidade `Export` nas fontes (a US-083 entrega a infraestrutura de filas, não um registro de exportação): proposta a entidade **`PcaExport`** (`pca_exports`, módulo `pca`) e os enums `PcaExportFormat` (`CSV`, `PDF`) e `PcaExportStatus` (`PENDING`, `PROCESSING`, `READY`, `FAILED`); índice único parcial `(tenant_id, pca_id, format) WHERE status IN ('PENDING','PROCESSING')`.
  3. Porta de leitura de vínculos (US-144, lacuna 2) ganha `hasConfidentialLinks(itemIds)`: retorna os itens com processo sigiloso vinculado, sem filtro de visibilidade do solicitante.
  4. Códigos de erro novos: `PCA_EXPORT_IN_PROGRESS` (409) e `PCA_EXPORT_NOT_READY` (409). Reutilizados: `INVALID_STATE`, `EXPORT_TOO_LARGE`, `RATE_LIMITED`, `IDEMPOTENCY_KEY_REUSED`.
  5. Endpoints `PCA-32` a `PCA-36` e rotas `/pcas/{pcaId}/exports…` e `/disclosure-preview` (a feature indica `POST /pca/{id}/exports` e `GET /pca/{id}/exports/{exportId}`; `PCA-34` download, `PCA-35` histórico e `PCA-36` prévia são novos). Job `pca-export` na fila `document-render` e layout `pca-disclosure` são nomes novos.
  6. Sem notificação de conclusão (nenhum `NotificationType` para exportação no registro); avaliar `PCA_EXPORT_READY` se o produto quiser aviso por e-mail.
  7. `Attachment`: o check `target_type IN ('TENANT_ASSET','TEMPLATE_VERSION') OR process_id IS NOT NULL` (entities.md MVP 1) precisa admitir `PCA`; arquivos gerados pelo sistema entram `AVAILABLE` sem varredura de antivírus (conteúdo gerado pelo próprio produto); bucket `documents` e prefixo `exports/` (storage.md reserva o prefixo sem bucket).
  8. `Pca.exportedAt` muda sem incrementar `version` (RN-PCA-340). Verificar o trigger de integridade de `pcas`.
  9. `OFFBOARDING` (DEC-132): a lista de rotas de exportação liberadas não inclui `PCA-32`/`PCA-34`; proposto incluí-las (leitura e exportação por `AUDITOR`).
  10. Divulgação de `Situação` e exclusão do responsável são decisões de produto desta story (RN-PCA-333); confirmar com o piloto. Texto do aviso "art. 24" a validar com o jurídico.

## Impacto técnico
- **Performance:** CSV de 500 itens em milissegundos; PDF dominado pelo Chromium do Gotenberg (concorrência serializada por processo, queues.md §12): meta p95 ≤ 30 s para 500 itens, na suíte de performance (endurecimento). Leitura única por job, sem N+1 (nomes de secretaria, categoria e tipo carregados em lote).
- **Segurança e LGPD:** lista fechada de colunas públicas (nada herdado automaticamente de `PcaItem`); sigilo decidido no servidor, antes de gerar; nomes de arquivo sem dado pessoal; URL assinada curta; logs sem conteúdo do plano.
- **Integridade:** `sha256` e contagens guardados no pedido permitem conferir o arquivo publicado; a leitura em transação única evita arquivo com estado misto.
- **Operação:** jobs `pca-export` seguem a política de filas (tentativas com *jitter*, cópia em `dead-letter` na falha final); pedidos órfãos encerrados pela manutenção; objetos S3 órfãos de transações desfeitas são sobrescritos no *retry* (mesma chave).
- **Compatibilidade:** sem alteração de endpoints do MVP 1; `Attachment` ganha um valor de alvo já previsto no MVP 2 (M2-01).

## Backend
- **Módulo(s):** `pca` (dono de `PcaExport`, prévia, geração e regras), `files` (`Attachment`, `StorageService`, URL assinada), `organization` (órgão, CNPJ, secretaria), `catalog` (categoria, tipo, unidade), `process` (leitura do sigilo pela porta), `audit`, `platform` (fila e disjuntor).
- **Casos de uso:** `RequestPcaExportCommand` (`PCA-32`), `GetPcaExportQuery` (`PCA-33`), `DownloadPcaExportQuery` (`PCA-34`), `ListPcaExportsQuery` (`PCA-35`), `PreviewPcaDisclosureQuery` (`PCA-36`), job `PcaExportHandler` (`pca-export`), `PcaExportTimeoutSweeper` (em `maintenance`).
- **Domínio:** `PcaDisclosureView` (colunas públicas, ordem, rótulos), `ConfidentialValuePolicy` (RN-PCA-334), `CsvWriter` (RN-PCA-336), `PcaDisclosureHtmlRenderer` (layout `pca-disclosure`), `PcaExport` (estados e transições).
- **Integrações internas:** `PcaLinkTarget` (`hasConfidentialLinks`), `GotenbergClient` com disjuntor (via `RenderPort`), `StorageService`, `AttachmentService`, `AuditService`, `enqueue()`.
- **Transação:** `PCA-32`: validações → inserção do `PcaExport` → *commit* → enfileiramento (falha → `FAILED ENQUEUE_FAILED`). Job: `PROCESSING` → leitura `READ ONLY` consistente → geração → `PutObject` → transação única (`Attachment`, `PcaExport READY`, `exportedAt`, `pca.export`).

## Frontend
- **Tela(s):** SCR-018 (`/pca/[pcaId]`, aba "Divulgação").
- **Componentes:** `DisclosureSummary` (versão, aprovação, última exportação), `ExportDialog` (prévia, escolha de formato, aviso de dados públicos), `ExportProgress` (consulta a cada 2 s, `aria-live`), `ExportHistoryTable` (formato, versão, quem, quando, tamanho, situação, "Baixar"), `ConfidentialItemsNotice`.
- **Estados:** loading (skeleton), vazio ("Nenhuma exportação ainda"), erro com "Tentar novamente", sucesso (toast "Arquivo pronto para download.").
- **Acessibilidade e responsividade:** andamento anunciado por `aria-live="polite"`; situação do pedido por texto e ícone; tabela de histórico em cartões abaixo de 768 px; foco devolvido ao botão após fechar o diálogo.

## Banco de dados
- **Tabelas:** `pca_exports` (nova), `attachments` (`target_type = PCA`), `pcas` (`exported_at`), `audit_logs`.
- **Migrações:** criar `pca_exports` e o enum de formato/situação junto com o valor `PCA` de `AttachmentTargetType` (M2-01) e o ajuste do check de `attachments`; reversível.
- **Índices/constraints relevantes:** único parcial `(tenant_id, pca_id, format) WHERE status IN ('PENDING','PROCESSING')`; `(tenant_id, pca_id, requested_at DESC)`; check `status <> 'READY' OR (attachment_id IS NOT NULL AND sha256 IS NOT NULL)`; FK composta com tenant e RLS como nas demais tabelas.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PCA-32` | POST | `/pcas/{pcaId}/exports` | `{ format }` · `Idempotency-Key` | `202 { data: PcaExport (PENDING) }` · `Location` | 202, 403, 404, 409, 422, 429, 503 |
| `PCA-33` | GET | `/pcas/{pcaId}/exports/{exportId}` | — | `200 { data: PcaExport }` (estado, contagens, `errorCode`) | 200, 403, 404 |
| `PCA-34` | GET | `/pcas/{pcaId}/exports/{exportId}/download` | — | `200 { data: { url, expiresAt } }` (300 s) | 200, 403, 404, 409, 503 |
| `PCA-35` | GET | `/pcas/{pcaId}/exports?page=&pageSize=` | paginação | `200 { data: PcaExport[], meta }` mais recentes primeiro | 200, 403, 404 |
| `PCA-36` | GET | `/pcas/{pcaId}/disclosure-preview` | — | `200 { data: { organization { name, cnpj }, year, versionNumber, approvedAt, lastExportedAt, itemsCount, canceledOmittedCount, maskedItemsCount, publishedTotal, columns[], warnings[] } }` | 200, 403, 404, 409 |

## Logs
- `info` `pca.export.requested` — `exportId`, `pcaId`, `format`, `itemsCount`.
- `info` `pca.export.ready` — `exportId`, `format`, `durationMs`, `sizeBytes`, `maskedItemsCount`.
- `warn` `pca.export.render_deferred` — `exportId`, disjuntor do Gotenberg aberto.
- `warn` `pca.export.plan_changed` — `exportId`, `pcaId`.
- `error` `pca.export.failed` — `exportId`, `errorCode`, `attempt`.
- **Nunca logar:** conteúdo do arquivo, objeto, valores e códigos dos itens, nomes de pessoas, nome do arquivo e URLs assinadas.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `pca.export` | `EXPORT` | Conclusão do pedido (`SUCCESS` ou `FAILURE`) | `metadata`: `pcaId`, `exportId`, `format`, `versionNumber`, `itemsCount`, `maskedItemsCount`, `attachmentId`, `sha256`, `sizeBytes`, `outcome`, `reasonCode?` |
| `attachment.download` | `EXPORT` | Antes de devolver a URL de `PCA-34` | `metadata`: `attachmentId`, `exportId`, `pcaId` |
| `access.denied` | `ACCESS` | Tentativa sem `PCA_EXPORT` ou sem escopo | `reasonCode` = `PCA_EXPORT` |

## Testes necessários
- **Unitários:** `PcaDisclosureView` (colunas, exclusões, ordem); `ConfidentialValuePolicy`; `CsvWriter` (BOM, `;`, CRLF, decimais, injeção de fórmula, aspas); montagem do HTML (cabeçalho, rodapé, total e nota de sigilosos); transições de `PcaExport`.
- **Integração (Testcontainers PostgreSQL + Redis + MinIO; Gotenberg em contêiner ou duplo via `RenderPort`):** fluxo completo CSV e PDF; leitura consistente; índice único de exportação ativa; *retry* e *dead-letter*; disjuntor do Gotenberg; falha de S3 e de banco no meio do job; `PLAN_CHANGED`; `exportedAt` sem incrementar `version`; auditoria antes da URL.
- **API/contrato:** `PCA-32` a `PCA-36`; `202` + `Location`; idempotência; códigos novos; URL de download expira em 300 s.
- **RBAC e multi-tenant:** `PCA_EXPORT` por escopo; autoridade sem exportação; pedido, plano e arquivo de outro tenant → 404 (suíte `test/tenant-leak`); **teste de sigilo**: arquivo idêntico com e sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`, sem valor sigiloso em arquivo, prévia, log e auditoria; ausência de responsável e de `notes` no arquivo.
- **Concorrência:** dois pedidos simultâneos do mesmo formato; exportação × criação de revisão; exportação × aprovação da revisão.
- **E2E (Playwright):** abrir a prévia, gerar CSV e PDF, ver o histórico, baixar; mensagem de falha com "Tentar novamente".
- **Acessibilidade/performance:** axe no diálogo e no histórico; exportação de 500 itens (CSV e PDF) com p95 ≤ 30 s na suíte de performance (medida no endurecimento).

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
- [ ] Teste de sigilo e de dados pessoais no arquivo (CSV e PDF) verde
- [ ] Métrica `cf_pca_export_duration_seconds{format}` e alerta de pedidos `FAILED` publicados

## Estimativa
**S** — reaproveita a fila, o Gotenberg, o armazenamento, o CSV padrão e a auditoria do MVP 1; o trabalho é o registro do pedido, a visão pública com sigilo, o layout do PDF e a aba de divulgação. Sem tela nova além da aba.

## Prioridade
**P1** — a divulgação do plano em sítio oficial (art. 12, § 1º) é obrigação legal e compõe o critério de saída do MVP 2; vem depois da aprovação do plano, sem bloquear elaboração, vínculo ou acompanhamento.

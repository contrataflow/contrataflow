---
id: US-164
title: "Importar itens, critérios e condições do TR para o edital"
epic: EP-027
feature: FT-078
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-037, US-038, US-163]
modules: [tender, document, term, process, catalog, access, timeline, audit, platform]
screens: [SCR-021]
endpoints: [TND-05, TND-06, TND-03, DOC-17, DOC-18]
permissions: [TENDER_UPDATE, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [TenderImportedFromTerm, TenderLotsChanged, DocumentVersionCreated]
---

# US-164 — Importar itens, critérios e condições do TR para o edital

## Título
Importar itens, critérios e condições do TR para o edital

## Descrição
**Como** servidor de Licitações que elabora a minuta do edital, **quero** importar do Termo de Referência concluído os itens, os critérios de julgamento e as condições de execução, escolhendo seção por seção e campo por campo o que entra, **para** que o edital nasça fiel ao TR, sem redigitar e sem divergir do que o Planejamento definiu, e para que eu saiba, a qualquer momento, de qual versão do TR a minuta veio.

A importação acontece em dois passos, como a do ETP para o TR (US-037): uma prévia somente leitura (TND-05) que mostra, por seção, por campo do cabeçalho e por item, o que seria alterado a partir da **versão vigente do TR** conforme o mapeamento semeado no template do `EDITAL` (`importMappings`), e a aplicação (TND-06), seletiva, rastreável e idempotente, que grava as escolhas, registra a versão de origem (`importedFromTermVersionId`, `importedAt`) e cria uma nova versão do documento. O TR nunca é alterado. Se o TR ganhar versão nova depois da importação, a tela avisa e permite reimportar apenas o que a pessoa escolher.

## Contexto
- O TR decorre do ETP; o edital decorre do TR (art. 25, c/c arts. 6º, XXIII, e 18). A redação manual do edital copia trechos do TR e produz divergências (objeto, critério, prazos) que só aparecem na fase externa. A DEC-201 prevê que o `EDITAL` seja gerado de template **importando itens, lotes, critérios e condições do TR** (`importMappings`, "como TR ← ETP"), e a RN-TND-04 exige importação seletiva por seção, versão de origem registrada e TR intocado.
- Mecânica herdada da US-037 (`TRM-05`/`TRM-06`): prévia sem gravação com `importToken` assinado e sem estado (api.md §1.3), válido por 15 minutos; aplicação com `If-Match`, `Idempotency-Key` e invalidação do token se a origem ou o destino mudarem (`IMPORT_PREVIEW_EXPIRED`, 410); `VersionReason.IMPORT` para a versão criada.
- A origem é um **snapshot imutável**: a versão do TR (`DocumentVersion`, DEC-017) lida pela fachada `DocumentFacade.getVersionSnapshot`, não o rascunho. Por isso só um TR `FINALIZED` ou `APPROVED` com versão vigente é importável: o campo `importedFromTermVersionId` é uma FK para `document_versions`.
- O que o edital tem do TR: **critérios** (critério de julgamento e adjudicação, seção de seleção do fornecedor), **condições** (vigência, prazo de execução, garantia, pagamento, entrega, fiscalização, sanções) e **itens** (descrição, unidade, quantidade, especificação e critérios de aceitação). Valores de itens vêm do `ProcessItem`/pesquisa de preços e **não** são importados (sigilo do orçamento, art. 24, POL-09).
- Itens e lotes: os `ProcessItem` continuam sendo os itens canônicos (DEC-019); o edital não duplica itens, ele os agrupa em lotes (`TenderLot`/`TenderLotItem`, US-165). A importação gera a seção de itens do texto do edital e, quando o edital ainda não tem lotes, semeia os lotes a partir de `ProcessItem.lotNumber`/`lotName` (`entities.md` §4.5).
- A edição do edital segue o ciclo de vida do documento (DEC-018) e a POL-02 com `TENDER_UPDATE`. A posição da etapa `MINUTA_EDITAL` é padrão semeado (DEC-196).

## Objetivo
Garantir que a minuta do edital possa ser preenchida a partir do TR em uma só ação revisável (≥ 90% das minutas com importação — KPI do épico), que cada importação deixe registrada a versão do TR de origem e o que foi aplicado, que o TR nunca seja modificado e que nenhum valor sigiloso do orçamento seja copiado para o edital.

## Persona
- **Principal:** Licitações (`LICITACOES`), redator da minuta.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`); Consultoria externa (`CONSULTOR_EXTERNO`) como participante com `TENDER_UPDATE` (quando o TR não é restrito); Planejamento (`PLANEJAMENTO`) e Compras (`COMPRAS`), que conferem a fidelidade ao TR lendo o resultado e o aviso de defasagem.

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`, MFA conforme `security.mfaPolicy` (`TENDER_UPDATE` é risco `M`: MFA só com política `ALL`).
- Minuta criada (US-163): `Tender` e documento `EDITAL` em `DRAFT` ou `RETURNED`.
- `TENDER_UPDATE` cobrindo o processo; custódia ou participação `COLLABORATOR`/`CONSULTANT` (POL-02); tipo `EDITAL` permitido na etapa; processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`.
- Processo com TR não cancelado em `FINALIZED` ou `APPROVED` e com versão vigente (`currentVersionId`).
- Se o TR é `RESTRICTED` (orçamento sigiloso): o usuário tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo ou a custódia atual (POL-09).
- Template do `EDITAL` com `importMappings` na versão fixada no documento (padrão semeado — US-110).

## Fluxo principal
1. Na SCR-021 (`/processos/[id]/edital/[tenderId]`), a pessoa aciona **"Importar do TR"**. Se o TR ganhou versão depois da última importação, o botão vem destacado com o aviso "O TR foi atualizado (v4) desde a última importação (v3)".
2. O front chama TND-05. A API localiza o TR do processo, lê o snapshot da versão vigente, aplica o `importMappings` do template fixado no `EDITAL` e devolve a prévia: por seção (conteúdo proposto, conteúdo atual e modo `REPLACE`/`APPEND`), por campo do cabeçalho (valor atual e valor proposto) e por item (número, descrição, unidade, quantidade), além do resumo dos lotes que seriam criados, avisos e o `importToken` (validade de 15 minutos).
3. O painel mostra três grupos, todos pré-marcados: **Itens** (lista de itens e lotes), **Critérios** (critério de julgamento, adjudicação, seção de critérios) e **Condições** (vigência, prazo, garantia, pagamento, entrega, fiscalização, sanções). Itens que a regra não permite importar aparecem desabilitados com o motivo.
4. A pessoa desmarca o que não quer importar. Para seção do edital que já tem texto e será substituída, o painel pede a confirmação **"Substituir o texto atual da seção"** (uma por seção).
5. Ao clicar em **"Aplicar importação"**, o front envia TND-06 com `importToken`, a seleção, as confirmações, `If-Match` (ETag do `Tender`) e `Idempotency-Key`.
6. A API, em uma transação com `SELECT … FOR UPDATE` no `Tender` e no documento: revalida o token (TR, `Tender` e revisões das seções inalterados desde a prévia); aplica as seções (substituição ou acréscimo); aplica os campos do cabeçalho validando o estado resultante com as regras da US-163; gera a seção de itens a partir do snapshot; semeia os lotes, quando o edital não tem lotes e a pessoa marcou os itens; grava `importedFromTermVersionId` e `importedAt`; incrementa a `version` do `Tender`; cria a `DocumentVersion` (`reason = IMPORT`) — precedida de uma versão `SYSTEM` com o estado anterior quando algum texto foi substituído; audita `tender.import_term`; grava no outbox `TenderImportedFromTerm`, `DocumentVersionCreated` (e `TenderLotsChanged`, se houve lotes semeados); projeta `TENDER_IMPORTED_FROM_TERM` na timeline.
7. A API responde 200 com o `Tender` atualizado, o resumo (`sectionsImported[]`, `fieldsImported[]`, `itemsImported`, `lotsCreated`) e a versão criada.
8. O front fecha o painel, atualiza o cabeçalho e o editor, mostra o toast "Importação aplicada: 5 seções, 3 campos e 8 itens (TR v3)" e remove o aviso de defasagem.
9. Mais tarde o TR é reaberto e finalizado de novo (v4). TND-03 passa a devolver `termChangedSinceImport = true`; a tela mostra o aviso com os atalhos **"Comparar versões do TR"** (DOC-18, v3 para v4) e **"Reimportar"**, e a pessoa repete o fluxo escolhendo apenas o que mudou.

## Fluxos alternativos
- **FA-01 — Nenhuma seleção:** o botão "Aplicar importação" fica desabilitado com "Selecione ao menos uma seção, um campo ou os itens".
- **FA-02 — Processo sem TR importável:** sem TR, ou com TR em `DRAFT`, `IN_REVIEW`, `RETURNED`, `REJECTED` ou `CANCELED`, TND-05 e TND-06 respondem 422 `TERM_REQUIRED_FOR_IMPORT` com `meta.reason` (`NO_TERM` ou `TERM_NOT_CONCLUDED`); o botão aparece desabilitado com a dica "Conclua o TR para importar" e o link para o TR.
- **FA-03 — Prévia expirada ou origem alterada:** ao aplicar, o token passou de 15 minutos, o TR ganhou versão, o `Tender` mudou ou uma seção do edital foi editada desde a prévia; 410 `IMPORT_PREVIEW_EXPIRED`; o painel recarrega a prévia e mantém a seleção quando possível.
- **FA-04 — Seção do edital já tem texto:** a seção só é substituída com a confirmação da pessoa (`confirmReplaceSections`); sem ela, 422 `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) na seção; o texto anterior fica recuperável na versão `SYSTEM` criada antes da importação.
- **FA-05 — Orçamento sigiloso:** a seção `ESTIMATED_VALUE` do TR não é proposta nem importada quando `estimatedValueDisclosed = false`; a prévia mostra "Não importada: o orçamento é sigiloso (art. 24)" (RN-TND-50).
- **FA-06 — Prazo do TR em dias úteis:** `executionDeadline` com `executionDeadlineType = BUSINESS` não é importado para `executionTermDays` (o edital registra dias corridos); a prévia mostra o campo desabilitado com a orientação de informar o prazo em dias corridos no cabeçalho (RN-TND-47).
- **FA-07 — Garantia com mais casas decimais:** `contractGuaranteePercent` com mais de duas casas é arredondada a duas casas e a prévia exibe o aviso `ROUNDED` com o valor original (RN-TND-47).
- **FA-08 — Itens do processo fora do TR:** itens do processo que o TR não traz entram no aviso `ITEMS_NOT_IN_TERM` (contagem e números), sem bloquear (RN-TND-48).
- **FA-09 — Edital já tem lotes:** os lotes existentes nunca são sobrescritos pela importação; a opção "Semear lotes" fica desabilitada com "O edital já tem lotes" (RN-TND-49).
- **FA-10 — Reimportação da mesma versão:** reimportar a versão já importada com a mesma seleção reproduz o mesmo conteúdo, sem duplicar seções, itens ou lotes, e responde 200 (RN-TND-53).
- **FA-11 — Documento não editável:** com o `EDITAL` fora de `DRAFT`/`RETURNED`, 409 `DOCUMENT_NOT_EDITABLE`; a ação some da tela.
- **FA-12 — TR restrito sem direito de leitura:** participante consultor sem a condição da POL-09 recebe 403 `PERMISSION_DENIED` (`reasonCode = POL-09`); o botão fica oculto.
- **FA-13 — Estado resultante inválido:** o campo importado viola a regra do cabeçalho (por exemplo, critério inativo no catálogo); 422 `VALIDATION_ERROR` com o erro no campo; nada é gravado.

## Regras de negócio
- **RN-TND-04** — A importação do TR é seletiva por seção, registra a versão do TR e a data (`importedFromTermVersionId`, `importedAt`) e nunca altera o TR (DEC-201). *(regra da feature, adotada)*
- **RN-TND-08** — A `MINUTA_CONTRATO` é gerada a partir de template e importa do TR; o `Tender` aponta para ela. *(regra da feature; a minuta do contrato é da US-167)*
- **RN-TND-10** — A edição segue o ciclo de vida do documento (DEC-018) e a POL-02 com `TENDER_UPDATE`; valores seguem o sigilo do orçamento (DEC-030). *(regra da feature, adotada)*
- **RN-TND-40** *(nova)* — Pré-requisitos (TND-05 e TND-06): `TENDER_UPDATE` cobrindo o processo, POL-02 completa (custódia ou participação, `EDITAL` em `DRAFT`/`RETURNED`, tipo permitido na etapa, processo editável) e um TR do processo (documento `TR` não cancelado) em `FINALIZED` ou `APPROVED` com `currentVersionId` preenchido; caso contrário, 422 `TERM_REQUIRED_FOR_IMPORT`. A prévia (TND-05) exige as mesmas permissões, porque revela conteúdo do TR.
- **RN-TND-41** *(nova)* — Fonte imutável e determinística: a origem é o snapshot da versão vigente do TR (cabeçalho, seções e itens, com `contentHash`), lido por `DocumentFacade.getVersionSnapshot`; o rascunho do TR nunca é lido, e a importação **nunca escreve** no TR, nas suas versões, nos itens do processo nem no mapa de riscos (verificado por teste: `version` e `contentHash` do TR iguais antes e depois). Duas prévias da mesma versão produzem o mesmo resultado.
- **RN-TND-42** *(nova)* — Mapeamento: vem de `DocumentTemplateVersion.importMappings` da versão do template fixada no `EDITAL`, com `fromDocumentType = 'TR'`: `sections[]` (`target`, `sources`, `mode` `REPLACE`/`APPEND`), `fields[]` (`target` com prefixo `tender.`, `source`) e `items` (`renderIntoSection`, `seedLots`). O padrão semeado (US-110, a confirmar na lacuna 1) é: seções `OBJECT` ← `OBJECT`; `ITEMS` ← `SPECIFICATIONS` + `ACCEPTANCE_CRITERIA` mais a lista de itens; `JUDGMENT_CRITERIA` ← `SELECTION_CRITERIA`; `EXECUTION_CONDITIONS` ← `DEADLINES` + `DELIVERY` + `OVERSIGHT`; `PAYMENT` ← `PAYMENT`; `GUARANTEES` ← `GUARANTEES`; `SANCTIONS` ← `SANCTIONS`; `ESTIMATED_VALUE` ← `ESTIMATED_VALUE`; todas em `REPLACE`; campos `tender.judgmentCriterionId` ← `selectionCriterionId`, `tender.awardType` ← `awardType`, `tender.contractTermMonths` ← `contractDurationMonths`, `tender.executionTermDays` ← `executionDeadline`, `tender.guaranteePercent` ← `contractGuaranteePercent`; itens em `ITEMS` com `seedLots = true`. Só entram na prévia as seções do mapeamento presentes no template e com conteúdo na origem, e os campos com valor na origem. Sem `importMappings` na versão do template, a prévia traz apenas os itens; sem nada a importar, 422 `BUSINESS_RULE_VIOLATION` com a violação `TENDER_IMPORT_EMPTY`.
- **RN-TND-43** *(nova)* — Prévia (TND-05): somente leitura, não grava nada (nem auditoria de dado, nem versão); emite `importToken` assinado e sem estado (HMAC), com `termVersionId`, `version` do `Tender`, as revisões das seções do edital e a seleção padrão, válido por 15 minutos; devolve `warnings[]` e o motivo de cada item desabilitado (`skippedReason`).
- **RN-TND-44** *(nova)* — Invalidação: na aplicação, qualquer mudança desde a prévia invalida o token com 410 `IMPORT_PREVIEW_EXPIRED`: nova versão do TR (ou TR reaberto), alteração do `Tender` (cabeçalho, lotes, matriz ou outra importação — a `version` mudou) ou nova revisão de seção do `EDITAL` (autosave). O vencimento por tempo tem o mesmo efeito.
- **RN-TND-45** *(nova)* — Seleção: `sections[]` e `fields[]` listam chaves da prévia (chave fora da prévia, 422 `VALIDATION_ERROR` com `NOT_ALLOWED`); `copyItems` controla a seção de itens e a semente de lotes; ao menos uma seção, um campo ou os itens (`REQUIRED`); só o que está marcado é alterado, o restante permanece como estava.
- **RN-TND-46** *(nova)* — Seções: `REPLACE` substitui o conteúdo da seção do edital pelo conteúdo importado; `APPEND` acrescenta ao final com a referência "Importado do TR v{n} em {data}". Substituir seção que já tem conteúdo exige `confirmReplaceSections` com a chave da seção (`CONDITIONAL_REQUIRED`). Quando alguma substituição de texto existente é aplicada, a API cria **antes** uma `DocumentVersion` `reason = SYSTEM` com o estado anterior ("Antes da importação do TR v{n}") e **depois** a versão `IMPORT`, de modo que o texto anterior fica recuperável (DOC-17, DOC-18). O conteúdo de cada seção respeita o limite de 1 MB (`TOO_LONG`) e o schema do rich text (`RICH_TEXT_INVALID`).
- **RN-TND-47** *(nova)* — Campos do cabeçalho: `judgmentCriterionId` ← critério de seleção do TR (precisa estar ativo no catálogo `JUDGMENT_CRITERION`); `awardType` ← adjudicação do TR; `contractTermMonths` ← vigência; `guaranteePercent` ← garantia contratual, arredondada a duas casas (`ROUNDED` na prévia) e respeitando a faixa de RN-TND-27; `executionTermDays` ← prazo de execução **somente** quando `executionDeadlineType = CALENDAR` (em `BUSINESS`, `skippedReason = DAY_COUNT_BUSINESS`). Campo sem valor na origem fica `SOURCE_EMPTY` e não é proposto. A aplicação valida o **estado resultante** do cabeçalho com as regras da US-163 (RN-TND-25 a RN-TND-29); falha, nada é gravado (422 `VALIDATION_ERROR`). Os campos que a importação não toca: `modalityId`, `disputeMode`, `executionRegime`, `smallBusinessBenefit`, forma eletrônica, habilitação, visita técnica e divulgação do valor.
- **RN-TND-48** *(nova)* — Itens: a seção de itens do edital é gerada, de forma determinística, a partir do snapshot do TR: para cada item do TR, em ordem de `sequence` do `ProcessItem`, uma entrada com número, descrição, unidade de medida, quantidade (formato pt-BR) e, quando existem, a especificação e os critérios de aceitação do TR (rich text preservado). **Preços e valores não são importados**. Itens do processo ausentes do snapshot do TR geram o aviso `ITEMS_NOT_IN_TERM`. `itemsImported` é a quantidade de itens do TR renderizados.
- **RN-TND-49** *(nova)* — Lotes: com `copyItems` e `seedLots`, e **somente se o edital não tem nenhum `TenderLot`**, o `TenderLotSeeder` cria um lote por `ProcessItem.lotNumber` (`name` = `lotName`) com os respectivos `TenderLotItem`; itens sem `lotNumber` ficam sem lote. A importação nunca altera, remove nem recompõe lotes existentes e nunca altera `ProcessItem`. `lotsCreated` conta os lotes criados e, se maior que zero, publica `TenderLotsChanged`.
- **RN-TND-50** *(nova)* — Sigilo (art. 24, POL-09, DEC-030): com `estimatedValueDisclosed = false`, a seção `ESTIMATED_VALUE` não é proposta (`skippedReason = BUDGET_CONFIDENTIAL`) e nenhum valor do TR (valor estimado, preço unitário, total) entra no edital; TR `RESTRICTED` só é lido por quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo ou a custódia atual (`PERMISSION_DENIED`, `reasonCode = POL-09`); eventos, logs, auditoria e a timeline carregam só ids, chaves de seção e contagens.
- **RN-TND-51** *(nova)* — Rastreabilidade: a aplicação grava `Tender.importedFromTermVersionId` (versão do TR lida) e `Tender.importedAt`, sempre a **última** importação; o histórico completo está na auditoria `tender.import_term`, nas versões do documento (`IMPORT` e `SYSTEM`) e na timeline (`TENDER_IMPORTED_FROM_TERM`, parâmetros `termVersion`, `sectionsCount`, `lotsCreated`). A reimportação parcial atualiza a versão de origem registrada para a versão lida, mesmo que só parte do conteúdo tenha sido reimportada (lacuna 6).
- **RN-TND-52** *(nova)* — Defasagem: TND-03 devolve `termChangedSinceImport = true` quando há importação e a versão vigente do TR (`Document.currentVersionId`) é outra que `importedFromTermVersionId`, e `termImportAvailable = true` quando há TR importável e nunca houve importação; ambos são calculados e apenas informativos (nunca bloqueiam edição, finalização nem aprovação). O aviso oferece "Comparar versões do TR" (DOC-18 entre a versão importada e a vigente) e "Reimportar".
- **RN-TND-53** *(nova)* — Reimportação e idempotência: pode ser repetida enquanto o `EDITAL` está em `DRAFT`/`RETURNED`; só o que for marcado é tocado; reimportar a mesma versão com a mesma seleção reproduz o mesmo conteúdo (sem duplicar blocos, itens ou lotes) e ainda assim cria nova versão `IMPORT` apenas se algo mudou; sem mudança efetiva, responde 200 sem versão, sem evento e com `sectionsImported = []`. A seção `APPEND` repete a referência a cada importação (como no TR) e por isso o padrão semeado usa `REPLACE`.
- **RN-TND-54** *(nova)* — Aplicação e documento: `Tender.version + 1` e `Document.draftRevision` por seção alterada; `riskMatrixRequired` é recalculado (RN-TND-30). A importação não conclui, não aprova e não cria a `MINUTA_CONTRATO`.
- **RN-TND-55** *(nova)* — Concorrência e idempotência: TND-06 exige `If-Match` (ETag do `Tender`, 412 `VERSION_CONFLICT`; ausente, 428) e `Idempotency-Key` (mesma chave e corpo em 24 h devolvem a mesma resposta com `Idempotent-Replayed: true`; corpo diferente, 422 `IDEMPOTENCY_KEY_REUSED`; em andamento, 409 `IDEMPOTENCY_IN_PROGRESS`); duas aplicações simultâneas com o mesmo token resultam em uma gravação e a outra recebe 410 ou o resultado já gravado, nunca duas versões duplicadas.
- **RN-TND-56** *(nova)* — Eventos e notificação: `TenderImportedFromTerm` (`tenderId`, `termDocumentVersionId`, `sectionsImported[]`, `itemsImported`, `lotsCreated`), o genérico `DocumentVersionCreated` (`document.version_created.edital`, `reason = IMPORT`, e `SYSTEM` quando aplicável) e `TenderLotsChanged` quando há lotes semeados; o evento de importação cobre também os campos do cabeçalho (não se publica `TenderUpdated` junto). Nenhuma notificação; a timeline recebe `TENDER_IMPORTED_FROM_TERM`.
- **RN-TND-57** *(nova)* — Limites e desempenho: até 1.000 itens (limite de itens do processo) e seções de até 1 MB; a prévia e a aplicação rodam sobre o snapshot, sem varrer o rascunho do TR; metas de p95 de TND-05 < 800 ms e TND-06 < 1.200 ms para 300 itens, na suíte de performance.
- **RN-TND-58** *(nova)* — Métrica de uso: o contador `cf_tender_term_import_total{result}` (`APPLIED`, `EXPIRED`, `REJECTED`) e a razão `TenderImportedFromTerm ÷ TenderCreated` alimentam o KPI "minutas criadas com importação do TR ≥ 90%" do épico; a métrica não leva valores nem texto.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Token da prévia | `importToken` (TND-06) | texto opaco assinado | Sim (aplicar) | RN-TND-43, RN-TND-44; 15 min | `TND-05` |
| Seções a importar | `sections[]` | lista de chaves | Não (mín. 1 entre seções, campos e itens) | RN-TND-45 | todas marcadas na prévia |
| Campos a importar | `fields[]` | lista de chaves | Não | RN-TND-45, RN-TND-47 | todas marcadas, exceto as desabilitadas |
| Importar itens | `copyItems` | booleano | Não | RN-TND-48 | `true` |
| Semear lotes | `seedLots` | booleano | Não | só com `copyItems` e sem lotes (RN-TND-49) | `true` quando permitido |
| Substituir texto atual | `confirmReplaceSections[]` | lista de chaves | Condicional | seção com conteúdo e modo `REPLACE` (RN-TND-46) | vazio |
| Versão da minuta | `If-Match` (ETag) | texto | Sim (TND-06) | `Tender.version` | `GET` TND-03 |
| Chave de idempotência | `Idempotency-Key` | texto | Sim (TND-06) | 24 h | gerada pelo front |
| *(saída)* Versão do TR lida | `term` (`documentId`, `code`, `versionId`, `versionNumber`) | objeto | — | RN-TND-41 | TR |
| *(saída)* Prévia por seção | `sections[]` (`target`, `sources`, `mode`, `before`, `after`, `hasContent`, `skippedReason?`) | lista | — | RN-TND-42 | mapeamento |
| *(saída)* Prévia por campo | `fields[]` (`target`, `source`, `current`, `proposed`, `skippedReason?`) | lista | — | RN-TND-47 | TR e `Tender` |
| *(saída)* Prévia de itens | `items` (`count`, `preview[]`, `lotSeeding`) | objeto | — | RN-TND-48, RN-TND-49 | snapshot do TR e `ProcessItem` |
| *(saída)* Avisos | `warnings[]` (`ROUNDED`, `ITEMS_NOT_IN_TERM`, `TERM_NOT_APPROVED`) | lista | — | RN-TND-43 | calculado |
| *(saída)* Resultado | `sectionsImported[]`, `fieldsImported[]`, `itemsImported`, `lotsCreated`, `documentVersion` | objeto | — | RN-TND-56 | aplicação |
| *(saída)* Origem registrada | `importedFromTermVersionId`, `importedAt` | uuid / data | — | RN-TND-51 | `Tender` |
| *(saída)* Defasagem | `termChangedSinceImport`, `termImportAvailable` | booleanos (calculados) | — | RN-TND-52 | TND-03 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Nenhuma seleção enviada | Front + API (Zod) | "Selecione ao menos uma seção, um campo ou os itens." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-02 | Processo sem TR ou TR não concluído | API | "Conclua o TR para importar os dados no edital." | `TERM_REQUIRED_FOR_IMPORT` (422) |
| V-03 | `importToken` ausente, inválido ou de outra minuta | API | "Gere a prévia novamente." | `VALIDATION_ERROR` |
| V-04 | Token expirado, TR, minuta ou seção alterados desde a prévia | API | "O TR ou a minuta foram alterados. Atualizando a prévia…" | `IMPORT_PREVIEW_EXPIRED` (410) |
| V-05 | Chave de seção ou de campo fora da prévia | API | "Revise a seleção: há itens que não podem ser importados." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-06 | Substituição de seção com texto sem confirmação | Front + API | "Confirme a substituição do texto atual da seção {seção}." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-07 | Conteúdo importado acima do limite da seção | API | "O conteúdo da seção {seção} excede o limite de 1 MB." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-08 | Estado resultante do cabeçalho inválido | API | "Algum dado importado viola uma regra do cabeçalho. Revise o campo indicado." | `VALIDATION_ERROR` (campo) |
| V-09 | Nada a importar (sem mapeamento, sem itens) | API | "O TR não tem dados importáveis para este modelo de edital." | `BUSINESS_RULE_VIOLATION` (`TENDER_IMPORT_EMPTY`) |
| V-10 | Documento fora de `DRAFT`/`RETURNED` | API | "A minuta não pode ser editada no status atual." | `DOCUMENT_NOT_EDITABLE` (409) |
| V-11 | Tipo não permitido na etapa | API | "O edital é elaborado na etapa Minuta do edital." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` (422) |
| V-12 | TR restrito sem direito de leitura | API | "O TR tem orçamento sigiloso e você não tem acesso ao conteúdo." | `PERMISSION_DENIED` (`reasonCode = POL-09`, 403) |
| V-13 | `If-Match` ausente ou divergente | API | "Atualize a página e tente de novo." / "A minuta foi alterada por outra pessoa." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-14 | Chave de idempotência reutilizada com corpo diferente | API | "Esta chave já foi usada em outra solicitação." | `IDEMPOTENCY_KEY_REUSED` (422) |

## Permissões
- **Permissão:** `TENDER_UPDATE` com escopo que cubra o processo, para a prévia e para a aplicação; `PROCESS_VIEW` para ler `termChangedSinceImport` (TND-03), DOC-17 e DOC-18; `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo (ou custódia) quando o TR é restrito.
- **Políticas:** POL-02 (edição: `EDITAL` ← `TENDER_UPDATE`, custódia ou participação, `DRAFT`/`RETURNED`, etapa, status do processo), POL-09 (sigilo do orçamento), DEC-024 (visibilidade).
- **MFA:** `TENDER_UPDATE` é risco `M`: exigido apenas com `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão "Importar do TR" fica oculto; a API responde 403 `PERMISSION_DENIED` ou `NOT_PROCESS_CUSTODIAN` e grava `access.denied`; minuta ou TR de outro tenant ou de processo invisível responde 404 (`TENDER_NOT_FOUND`).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TenderImportedFromTerm` | `tender.imported_from_term` | Commit de TND-06 com mudança efetiva | `tenderId`, `termDocumentVersionId`, `sectionsImported[]`, `itemsImported`, `lotsCreated`; consumidor T (timeline `TENDER_IMPORTED_FROM_TERM`) |
| `DocumentVersionCreated` | `document.version_created.edital` | Mesmo commit | `reason = IMPORT`; antes dele, uma versão `reason = SYSTEM` quando houve substituição de texto existente |
| `TenderLotsChanged` | `tender.lots_changed` | Mesmo commit, só se `lotsCreated > 0` | `tenderId`, `lotsCount`, `itemsUnassigned` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação: `events.md` §6 não prevê tipo para a importação; apenas a entrada `TENDER_IMPORTED_FROM_TERM` na timeline |

## Critérios de aceite em Gherkin
```gherkin
Feature: Importar itens, critérios e condições do TR para o edital

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o processo "0012/2026" está "IN_PROGRESS" na etapa "MINUTA_EDITAL" e tem 8 itens, 5 no lote 1 "Material de expediente" e 3 no lote 2 "Informática"
    And o TR "TR 0001/2026" está "FINALIZED" na versão 3, com critério de seleção "MENOR_PRECO", adjudicação "BY_LOT", vigência de 12 meses, prazo de execução de 30 dias corridos e garantia de 5%
    And a minuta "ED 0001/2026" está "DRAFT" sem lotes, criada por "Lia Moreira", e o modelo do "EDITAL" tem o mapeamento padrão de importação do TR
    And "Lia Moreira" tem o perfil "LICITACOES" com "TENDER_UPDATE" e a custódia do processo
    And "Paulo Reis", da consultoria externa, é participante "CONSULTANT" com "TENDER_UPDATE" e "Marcos Ribeiro", de Compras, tem apenas "PROCESS_VIEW"

  Scenario: [Sucesso] Pré-visualizar a importação sem gravar nada
    When "Lia Moreira" chamar "POST /tenders/{id}/import-term/preview"
    Then a API deve responder 200 com o TR "TR 0001/2026" na versão 3 e um "importToken" com validade de 15 minutos
    And a prévia deve trazer as seções "OBJECT", "ITEMS", "JUDGMENT_CRITERIA", "EXECUTION_CONDITIONS", "PAYMENT", "GUARANTEES" e "SANCTIONS"
    And a prévia deve trazer os campos "judgmentCriterionId", "awardType", "contractTermMonths", "executionTermDays" e "guaranteePercent" com o valor atual e o proposto
    And a prévia deve trazer 8 itens e a semente de 2 lotes
    And nenhuma versão, auditoria de dado ou evento deve ter sido gerado

  Scenario: [Sucesso] Aplicar a importação completa
    Given que "Lia Moreira" gerou a prévia
    When "Lia Moreira" chamar "POST /tenders/{id}/import-term" com o token, todas as seções, todos os campos, "copyItems" e "seedLots", a ETag atual e a chave "K1"
    Then a API deve responder 200 com "sectionsImported" de 7 seções, "itemsImported" 8 e "lotsCreated" 2
    And o "Tender" deve ter "importedFromTermVersionId" igual à versão 3 do TR e "importedAt" preenchido
    And o cabeçalho deve ter critério "MENOR_PRECO", adjudicação "BY_LOT", vigência de 12 meses, prazo de 30 dias e garantia de 5%
    And devem existir os lotes 1 e 2 com 5 e 3 itens
    And deve existir uma nova versão do documento com "reason" igual a "IMPORT"
    And devem ser publicados "TenderImportedFromTerm", "DocumentVersionCreated" e "TenderLotsChanged"
    And a timeline deve exibir "Lia Moreira importou dados do TR (v3) para o edital"
    And deve gerar a auditoria "tender.import_term" sem o texto das seções
    And o TR deve continuar na versão 3 com o mesmo "contentHash"

  Scenario: [Sucesso] Importação seletiva só de critérios e condições
    Given que "Lia Moreira" gerou a prévia
    When "Lia Moreira" aplicar apenas os campos "judgmentCriterionId" e "guaranteePercent" e a seção "JUDGMENT_CRITERIA", sem itens
    Then a API deve responder 200 com "itemsImported" 0 e "lotsCreated" 0
    And as demais seções, os campos e os lotes devem permanecer como estavam

  Scenario: [Sucesso] Reimportar depois que o TR ganhou versão nova
    Given que a importação da versão 3 foi aplicada e a seção "PAYMENT" do edital foi editada à mão
    And o TR foi reaberto e finalizado de novo na versão 4 com pagamento em 20 dias
    When "Lia Moreira" chamar "GET /tenders/{id}"
    Then a API deve responder 200 com "termChangedSinceImport" verdadeiro
    When "Lia Moreira" gerar a prévia e aplicar apenas a seção "PAYMENT" confirmando a substituição
    Then a API deve responder 200 com "sectionsImported" igual a "PAYMENT"
    And "importedFromTermVersionId" deve apontar para a versão 4
    And devem existir uma versão "SYSTEM" com o texto anterior da seção e, em seguida, a versão "IMPORT"
    And "termChangedSinceImport" deve voltar a ser falso

  Scenario: [Sucesso] Orçamento sigiloso não leva valor ao edital
    Given que o orçamento do processo é sigiloso e o edital tem "estimatedValueDisclosed" falso
    When "Lia Moreira" gerar a prévia
    Then a seção "ESTIMATED_VALUE" deve aparecer com "skippedReason" "BUDGET_CONFIDENTIAL"
    And nenhum valor, preço unitário ou total do TR deve aparecer na prévia, no edital, nos eventos, nos logs ou na auditoria

  Scenario: [Sucesso] Prazo em dias úteis e garantia com muitas casas
    Given que o TR tem prazo de execução de 20 dias úteis e garantia de "4,3333" por cento
    When "Lia Moreira" gerar a prévia
    Then o campo "executionTermDays" deve aparecer desabilitado com "skippedReason" "DAY_COUNT_BUSINESS"
    And o campo "guaranteePercent" deve propor "4,33" com o aviso "ROUNDED"

  Scenario: [Validação] TR ausente ou não concluído
    Given que o processo não tem TR
    When "Lia Moreira" chamar "POST /tenders/{id}/import-term/preview"
    Then a API deve responder 422 com código "TERM_REQUIRED_FOR_IMPORT" e "meta.reason" "NO_TERM"
    Given que o TR está "DRAFT"
    When "Lia Moreira" chamar "POST /tenders/{id}/import-term/preview"
    Then a API deve responder 422 com código "TERM_REQUIRED_FOR_IMPORT" e "meta.reason" "TERM_NOT_CONCLUDED"

  Scenario: [Validação] Seleção inválida, substituição sem confirmação e estado resultante
    When "Lia Moreira" aplicar a importação sem nenhuma seção, campo ou item
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REQUIRED"
    When "Lia Moreira" aplicar a seção "DOCUMENT_FOOTER", que não consta na prévia
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED"
    Given que a seção "OBJECT" do edital já tem texto
    When "Lia Moreira" aplicar a seção "OBJECT" sem confirmar a substituição
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" na seção "OBJECT"
    Given que o critério "MENOR_PRECO" foi inativado no catálogo
    When "Lia Moreira" aplicar o campo "judgmentCriterionId"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_INACTIVE"
    And nenhuma seção, campo, lote ou versão deve ter sido gravado

  Scenario: [Validação] Etapa fora de MINUTA_EDITAL e edital já finalizado
    Given que o processo está na etapa "JURIDICO", que não permite o tipo "EDITAL"
    When "Lia Moreira" chamar "POST /tenders/{id}/import-term"
    Then a API deve responder 422 com código "DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE"
    Given que o documento "EDITAL" está "FINALIZED"
    When "Lia Moreira" chamar "POST /tenders/{id}/import-term/preview"
    Then a API deve responder 409 com código "DOCUMENT_NOT_EDITABLE"

  Scenario: [Permissão] Sem TENDER_UPDATE, consultor com TR restrito e leitor
    Given que "Marcos Ribeiro" não tem "TENDER_UPDATE"
    When "Marcos Ribeiro" chamar "POST /tenders/{id}/import-term/preview"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar a auditoria "access.denied"
    Given que o TR é "RESTRICTED" por orçamento sigiloso e "Paulo Reis" não tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    When "Paulo Reis" chamar "POST /tenders/{id}/import-term/preview"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e "reasonCode" "POL-09"
    When "Marcos Ribeiro" chamar "GET /tenders/{id}"
    Then a API deve responder 200 com "termChangedSinceImport" e sem nenhuma ação de importação

  Scenario: [Tenant incorreto] Minuta e TR de outro órgão
    Given que a minuta "ED 0002/2026" e o TR "TR 0004/2026" pertencem ao tenant "Prefeitura B"
    When "Lia Moreira" chamar a prévia e a aplicação da importação para "ED 0002/2026"
    Then a API deve responder 404 com código "TENDER_NOT_FOUND" nas duas chamadas
    And nenhum dado, nem a existência do TR da "Prefeitura B", deve ser revelado na resposta, nos logs ou na auditoria

  Scenario: [Duplicidade] Reenvio, reimportação da mesma versão e lotes existentes
    Given que "Lia Moreira" aplicou a importação com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o cabeçalho "Idempotent-Replayed: true"
    And não deve existir segunda versão "IMPORT", seção duplicada, item duplicado nem lote duplicado
    When "Lia Moreira" gerar nova prévia da mesma versão e aplicar a mesma seleção com a chave "K2"
    Then a API deve responder 200 com "sectionsImported" vazio e nenhuma versão nova
    Given que o edital já tem 3 lotes criados à mão
    When "Lia Moreira" gerar a prévia
    Then a semente de lotes deve vir desabilitada e os 3 lotes não devem ser alterados por nenhuma importação

  Scenario: [Concorrência] TR muda entre a prévia e a aplicação, edições simultâneas e dupla aplicação
    Given que "Lia Moreira" gerou a prévia
    When o TR for finalizado na versão 4 antes de "Lia Moreira" aplicar
    Then a aplicação deve responder 410 com código "IMPORT_PREVIEW_EXPIRED"
    Given que "Lia Moreira" gerou outra prévia com a ETag "T5"
    When "Paulo Reis" editar o cabeçalho, levando a ETag a "T6", antes da aplicação
    Then a aplicação com "If-Match" "T5" deve responder 412 com código "VERSION_CONFLICT" ou 410 com código "IMPORT_PREVIEW_EXPIRED"
    Given que "Lia Moreira" gerou outra prévia
    When "Paulo Reis" salvar a seção "OBJECT" do edital antes da aplicação
    Then a aplicação deve responder 410 com código "IMPORT_PREVIEW_EXPIRED"
    When "Lia Moreira" aplicar o mesmo token duas vezes ao mesmo tempo
    Then exatamente uma aplicação deve gravar e a outra deve responder 410 ou devolver o resultado já gravado
    And deve existir um único evento "TenderImportedFromTerm" para o token

  Scenario: [Falha de banco] Banco indisponível durante a aplicação
    Given que o banco de dados fica indisponível durante a transação de "POST /tenders/{id}/import-term"
    When "Lia Moreira" confirmar a importação
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhuma seção, campo, lote, versão, auditoria ou evento deve ter sido gravado
    And "importedFromTermVersionId" deve continuar nulo

  Scenario: [Falha de integração] Redis e relay do outbox indisponíveis
    Given que o Redis está indisponível
    When "Lia Moreira" aplicar a importação
    Then a API deve responder 200 sem consultar o cache de idempotência
    And deve ser registrado log "warn" "idempotency.store_unavailable"
    Given que o relay do outbox está indisponível
    When "Lia Moreira" aplicar a importação com sucesso
    Then a minuta deve ser atualizada e a API deve responder 200
    And o evento "TenderImportedFromTerm" deve permanecer "PENDING" no outbox até o relay voltar

  Scenario: [Sucesso] Desempenho da prévia e da aplicação (teste de suíte, sem benchmark no card)
    Given a suíte de desempenho com um TR de 300 itens
    When forem executadas 50 prévias e 50 aplicações em minutas distintas
    Then o p95 de "TND-05" deve ser menor que 800 ms e o de "TND-06" menor que 1.200 ms
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem TR ou TR não concluído | 422 | `TERM_REQUIRED_FOR_IMPORT` | "Conclua o TR para importar os dados no edital." | Botão desabilitado; link para o TR |
| Token expirado ou origem alterada | 410 | `IMPORT_PREVIEW_EXPIRED` | "O TR ou a minuta foram alterados. Atualizando a prévia…" | Recarrega a prévia e mantém a seleção |
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise a seleção." | Marca a seção, o campo ou o item |
| Nada a importar | 422 | `BUSINESS_RULE_VIOLATION` | "O TR não tem dados importáveis para este modelo de edital." | Mostra a explicação e o link para o administrador |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "A minuta não pode ser editada no status atual." | Oculta a ação |
| Tipo fora da etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O edital é elaborado na etapa Minuta do edital." | Oculta a ação |
| Minuta ou TR inexistente, de outro tenant ou invisível | 404 | `TENDER_NOT_FOUND` | "Minuta do edital não encontrada." | Volta ao detalhe do processo |
| Sem permissão ou TR restrito | 403 | `PERMISSION_DENIED` | "Você não tem permissão para importar o TR neste edital." | Oculta a ação |
| Sem custódia | 403 | `NOT_PROCESS_CUSTODIAN` | "Você não está com este processo." | Oculta a ação |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente de novo." | Recarrega a minuta |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "A minuta foi alterada por outra pessoa. Atualize a página." | Recarrega e gera nova prévia |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Aplicação em andamento | 409 | `IDEMPOTENCY_IN_PROGRESS` | "Estamos concluindo a importação. Aguarde." | Repete a consulta após 2 s |
| Banco ou Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível importar agora. Tente novamente em instantes." | Mantém a seleção; botão "Tentar novamente"; respeita `Retry-After` |

## Dependências
- **Stories:** US-163 (a minuta e o cabeçalho que recebem a importação, a regra de validação do estado resultante e o ETag do `Tender`); US-037 (mecânica de prévia, `importToken` e `importMappings` replicada aqui); US-038 (itens e condições do TR, que são a origem); US-039 (TR concluído e versionado, requisito da importação). Indiretas: US-110 (modelo `EDITAL` com `importMappings` semeado), US-065 e US-066 (ciclo de vida, versões `IMPORT`/`SYSTEM`, DOC-17 e DOC-18), US-006 (itens e lotes de planejamento), US-165 (`TenderLotSeeder` e lotes), US-166 e US-167 (consumidores do mesmo TR), US-169 (rascunho por IA que também parte do TR).
- **Decisões/ADRs:** DEC-201, DEC-017, DEC-018, DEC-019, DEC-030, DEC-105, DEC-161, DEC-196; ADR-006; POL-02, POL-09; RN-TND-04, RN-TND-08, RN-TND-10; RN-TR-16 a RN-TR-24 (mecânica espelhada).
- **Configurações:** `DocumentTemplateVersion.importMappings` do `EDITAL`; catálogo `JUDGMENT_CRITERION`.
- **Lacunas nas fontes canônicas:**
  1. **Formato de `importMappings` para TR → EDITAL:** `entities.md` §5.8 define apenas `fromDocumentType: 'ETP'`, `fields[].target` para o TR e `items` com `copyQuantities`/`copyCalculationMemoToNotes`. Propor generalizar para `fromDocumentType: 'ETP' | 'TR'`, aceitar `fields[].target` com prefixo `tender.` (campos do `Tender`) e `items: { renderIntoSection: string; seedLots: boolean }` para o edital; registrar as chaves de seção do template `EDITAL` (a story usa `OBJECT`, `ITEMS`, `JUDGMENT_CRITERIA`, `EXECUTION_CONDITIONS`, `PAYMENT`, `GUARANTEES`, `SANCTIONS`, `ESTIMATED_VALUE`, indicativas) no seed da US-110.
  2. **Código novo `TERM_REQUIRED_FOR_IMPORT` (422)** e a violação `TENDER_IMPORT_EMPTY` (`BUSINESS_RULE_VIOLATION`), por analogia a `ETP_REQUIRED_FOR_IMPORT`; `IMPORT_PREVIEW_EXPIRED` é reaproveitado (410). A consolidar no `api.md` do MVP 2 (IDs `TND-05` e `TND-06`).
  3. **Campos calculados de TND-03:** `termChangedSinceImport` e `termImportAvailable` não constam em `entities.md` (mesmo padrão de `etpChangedSinceImport` e dos campos `...Masked`); registrar no `api.md`.
  4. **Payload de `TenderImportedFromTerm`:** `events.md` traz `sectionsImported[]`, `itemsImported` e `lotsCreated`, mas não os campos do cabeçalho importados. Propor `fieldsImported[]` opcional (mesma `eventVersion`).
  5. **Autor da importação no `Tender`:** o TR guarda `importedById`; o `Tender` só tem `importedFromTermVersionId` e `importedAt`. O autor fica na auditoria e na timeline. **Dúvida de produto:** acrescentar `importedById` ao `Tender`?
  6. **Reimportação parcial e versão de origem:** o `Tender` guarda uma só `importedFromTermVersionId`; ao reimportar só uma seção da v4, a origem passa a v4 mesmo que o resto do edital tenha vindo da v3. **Dúvida de produto:** registrar a versão de origem por seção?
  7. **Dias úteis do TR:** `Tender.executionTermDays` não tem tipo de contagem (lacuna 6 da US-163); a story não importa prazo em dias úteis. **Dúvida de produto:** acrescentar o tipo de contagem ao `Tender`.
  8. **Versão `SYSTEM` antes da substituição:** `VersionReason.SYSTEM` existe, mas o MVP 1 só a usa em eventos internos; a story a emprega para guardar o texto anterior. Confirmar com a US-066.
  9. **Defasagem não bloqueia:** a RN-TND-06/09 não trata o edital desatualizado em relação ao TR; a story só avisa. **Dúvida de produto:** a regra de saída de `MINUTA_EDITAL` (US-168) deve emitir `WARNING` quando `termChangedSinceImport`?
  10. **Valor dos itens no edital:** a story não importa preços; a exibição de valores estimados no edital (quando `estimatedValueDisclosed = true`) depende do template e do valor de lote (US-165); confirmar o modelo de apresentação.

## Impacto técnico
- **Mecânica compartilhada:** reaproveita a prévia com `importToken` stateless (HMAC, 15 min) da US-037; o token embute `termVersionId`, a `version` do `Tender` e as revisões de seção do edital, de modo que a invalidação é um simples recálculo e comparação.
- **Atomicidade:** seções, campos, texto de itens, lotes, versões do documento, auditoria e outbox na mesma transação, com `SELECT … FOR UPDATE` no `Tender` e no documento; falha desfaz tudo.
- **Determinismo:** a geração da seção de itens e da prévia só depende do snapshot e do `Tender`, o que torna a reimportação idempotente e testável por `contentHash`.
- **Isolamento do TR:** o módulo `tender` só **lê** `term`/`document` por fachada (`DocumentFacade.getVersionSnapshot`, D11); regra de arquitetura: `tender` nunca escreve em `term` ou `risk` (domains.md). Teste de arquitetura e teste de integração (hash do TR inalterado).
- **Volume:** snapshots de TR com até 1.000 itens e seções de até 1 MB; metas de p95 na suíte de performance (sem benchmark no card).
- **Compatibilidade:** nenhuma mudança em contratos do MVP 1; `DOC-17` e `DOC-18` são reaproveitados para ver e comparar versões do TR; o seed do template `EDITAL` (US-110) precisa trazer o `importMappings` descrito na RN-TND-42.
- **Segurança:** conteúdo do TR só sai da fachada para quem passou pela POL-09; o conteúdo importado nunca é registrado em log; a prévia não grava nada.

## Backend
- **Módulo(s):** `tender` (dono), `document` (snapshot de versão, `DraftContentService`, `DocumentVersionFactory`), `term` (leitura por fachada), `process` (itens e lotes de planejamento, custódia), `catalog`, `access`, `timeline`, `audit`, `platform` (`ImportToken`, `IdempotencyService`, `OutboxWriter`).
- **Casos de uso:** `PreviewImportTermToTenderQuery` (TND-05), `ApplyImportTermToTenderCommand` (TND-06); leitura de `termChangedSinceImport` em `GetTenderQuery` (TND-03).
- **Domínio:** `Tender.applyTermImport(mapping, selection, snapshot)`, `TermImportMapper` (mapeamento de seções, campos e itens), `TenderItemsSectionRenderer`, `TenderLotSeeder` (US-165), `ImportToken` (value object compartilhado com a US-037), `TenderHeaderPolicy` (validação do estado resultante, US-163).
- **Integrações internas:** `DocumentFacade.getVersionSnapshot(termVersionId)` e `getCurrentVersion(termDocumentId)`, `DocumentFacade.createVersion(reason: 'IMPORT' | 'SYSTEM')`, `ProcessFacade.getItems`, `CatalogFacade`, `AuthorizationService.assertCan('TENDER_UPDATE', { processId })` com a POL-09, `OutboxWriter`, `AuditService`, `TimelineProjector`.
- **Transação:** passos 6.1 a 6.8 do fluxo principal em uma transação interativa Prisma com `app.tenant_id`: revalidação do token, aplicação seletiva, versões, auditoria, outbox e timeline, commit.

## Frontend
- **Tela(s):** SCR-021 (`/processos/[id]/edital/[tenderId]`), painel "Importar do TR" e aviso de defasagem na moldura da tela.
- **Componentes:** `ImportTermPreviewPanel` (diff "antes/depois" por seção, em três grupos Itens, Critérios e Condições), `FieldImportList`, `ItemsImportTable`, `LotSeedingSummary`, `ReplaceSectionConfirm`, `StaleTermBanner` (`termChangedSinceImport`) com "Comparar versões do TR" e "Reimportar", `ImportResultToast`, `DisabledReasonHint`.
- **Estados:** carregando a prévia (skeleton); vazio/bloqueado (TR não concluído, com link para o TR); erro (prévia expirada recarrega automaticamente; falha geral com "Tentar novamente"); sucesso (resumo "X seções, Y campos e Z itens importados").
- **Acessibilidade e responsividade:** foco movido ao painel ao abrir e devolvido ao botão ao fechar; diferenças anunciadas por `aria-live`; checkboxes navegáveis por teclado, com o motivo de cada item desabilitado ligado por `aria-describedby`; situação nunca só por cor; abaixo de 768 px o diff "antes/depois" vira abas "Antes" e "Depois" e os grupos viram acordeões; contraste AA.

## Banco de dados
- **Tabelas:** `tenders` (update de `imported_from_term_version_id`, `imported_at`, campos do cabeçalho, `version`), `documents` (`draftContent`, `draftRevision`, `version`), `document_versions` (insert, `IMPORT` e `SYSTEM`), `tender_lots` e `tender_lot_items` (insert na semente), `audit_logs`, `outbox_events`, `process_timeline_entries`; leitura de `document_versions` do TR, `terms_of_reference`, `process_items`, `document_items`.
- **Migrações:** nenhuma nova (colunas e tabelas do `Tender` já na migração do MVP 2).
- **Índices/constraints relevantes:** FK `imported_from_term_version_id` para `document_versions`; `UNIQUE (tenant_id, tender_id, number)` em `tender_lots` e `UNIQUE (tenant_id, tender_id, process_item_id)` em `tender_lot_items` (garantem que a semente não duplica); `UNIQUE (tenant_id, process_id)` em `tenders`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `TND-05` | POST | `/api/v1/tenders/{id}/import-term/preview` | `{}` (calcula a partir do estado atual) | `200 { data: { importToken, expiresAt, term: { documentId, code, versionId, versionNumber }, sections: [{ target, sources, mode, before, after, hasContent, skippedReason? }], fields: [{ target, source, current, proposed, skippedReason? }], items: { count, preview: [{ processItemId, sequence, description, unit, quantity }], lotSeeding: { allowed, lotsPlanned, itemsWithoutLot } }, warnings[] } }` | 200, 401, 403, 404, 409, 422 (`TERM_REQUIRED_FOR_IMPORT`, `BUSINESS_RULE_VIOLATION`) |
| `TND-06` | POST | `/api/v1/tenders/{id}/import-term` | `{ importToken, sections: string[], fields: string[], copyItems: boolean, seedLots?: boolean, confirmReplaceSections?: string[] }` + `If-Match` + `Idempotency-Key` | `200 { data: { tender: Tender, sectionsImported: string[], fieldsImported: string[], itemsImported: number, lotsCreated: number, documentVersion: { id, versionNumber } } }` + `ETag` | 200, 401, 403, 404, 409, 410 (`IMPORT_PREVIEW_EXPIRED`), 412, 422, 428, 503 |
| `TND-03` | GET | `/api/v1/tenders/{id}` | — (US-163) | ganha `termChangedSinceImport` e `termImportAvailable` | 200, 401, 403, 404 |
| `DOC-17` | GET | `/api/v1/document-versions/{versionId}` | MVP 1 | versão do TR de origem (atalho "Ver versão importada") | 200, 403, 404 |
| `DOC-18` | GET | `/api/v1/documents/{id}/versions/compare?from=&to=` | MVP 1 | comparação das versões do TR (atalho "Comparar versões do TR") | 200, 403, 404 |

## Logs
- `info` `tender.term_import_applied` — `tenderId`, `termDocumentId`, `termVersionNumber`, `sectionsCount`, `fieldsCount`, `itemsCount`, `lotsCreated`, `durationMs`, `correlationId`.
- `info` `tender.term_import_previewed` — `tenderId`, `termVersionNumber`, `durationMs`.
- `warn` `tender.term_import_stale` — prévia recusada por expiração ou mudança (`reason`: `TERM`, `TENDER`, `SECTION`, `TTL`); `warn` `tender.term_import_denied` — `reasonCode`; `warn` `idempotency.store_unavailable`.
- `error` `tender.term_import_failed` — `errorCode`, causa resumida, `correlationId`.
- Nunca logar: conteúdo de seções, especificações e critérios de aceitação dos itens, valores do TR ou do orçamento, texto de justificativas.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `tender.import_term` | `DATA_CHANGE` | Commit de TND-06 com mudança efetiva | `changes`: campos do cabeçalho de `de` para `para` (valores não textuais) e chaves das seções alteradas, sem conteúdo; `metadata`: `tenderId`, `termDocumentId`, `termVersionId`, `termVersionNumber`, `sectionsImported[]`, `fieldsImported[]`, `itemsImported`, `lotsCreated`, `systemVersionCreated`, `idempotencyKey` |
| `tender.lots_update` | `DATA_CHANGE` | Mesmo commit, se houve lotes semeados | `metadata`: `tenderId`, `source` `IMPORT`, `lotsCount`, `itemsAssigned`, `itemsUnassigned` |
| `access.denied` | `ACCESS` | 403 em TND-05 ou TND-06 | `reasonCode` (`TENDER_UPDATE`, `POL-09`, `POL-02`), `tenderId` |

## Testes necessários
- **Unitários:** `TermImportMapper` (`REPLACE` e `APPEND`; seção sem conteúdo na origem; campo `SOURCE_EMPTY`); conversões (`ROUNDED`, dias úteis); `TenderItemsSectionRenderer` (ordem, formato pt-BR, rich text); `TenderLotSeeder` (grupos por `lotNumber`, itens sem lote, edital com lotes); assinatura e verificação do `ImportToken` (TR, `Tender`, revisões); regra de sigilo da seção `ESTIMATED_VALUE`; precedência da validação do estado resultante.
- **Integração (Testcontainers):** aplicação atômica (seções, campos, itens, lotes, versões `SYSTEM` e `IMPORT`, auditoria, outbox, timeline); `contentHash` e `version` do TR inalterados; reimportação idempotente; rollback total em falha induzida; RLS entre tenants; TR `RESTRICTED` (POL-09); snapshot lido da versão e não do rascunho.
- **API/contrato:** TND-05 e TND-06 (códigos, `If-Match`, `Idempotency-Key`, `Idempotent-Replayed`, 410); campos aditivos de TND-03; DOC-17 e DOC-18 inalterados.
- **RBAC e multi-tenant:** suíte "tenant leak" com TND-05 e TND-06 (minuta e TR de outro tenant → 404, sem revelar existência); matriz de autorização com `TENDER_UPDATE`, `PROCESS_VIEW` e `PROCESS_VIEW_CONFIDENTIAL_BUDGET`; bateria de POL-02 (custódia, participação, `DRAFT`/`RETURNED`, etapa, status do processo).
- **Concorrência:** TR novo, `Tender` alterado, autosave de seção e dupla aplicação entre prévia e aplicação.
- **E2E (Playwright):** prévia, seleção parcial, confirmação de substituição, aplicação, verificação do cabeçalho, dos lotes, do editor e da timeline; TR com versão nova, aviso, comparação e reimportação.
- **Acessibilidade/performance:** axe no painel de importação; 360 px; metas de p95 de TND-05/TND-06 na suíte de performance (sem benchmark no card).

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
- [ ] Transação única comprovada por teste de falha induzida, com o TR comprovadamente intacto (`version` e `contentHash`)
- [ ] Nenhum valor do orçamento sigiloso presente no edital, na prévia, em eventos, logs ou auditoria
- [ ] Reimportação idempotente e aviso de TR com versão nova verificados em teste
- [ ] Gherkin das 8 categorias automatizado, incluindo etapa fora de `MINUTA_EDITAL`, `If-Match` e `IMPORT_PREVIEW_EXPIRED`

## Estimativa
**M** — reaproveita a mecânica de prévia e token da US-037 e o ciclo de vida do documento, sem entidades novas; a complexidade está no mapeamento TR para edital (seções, campos e itens), na semente de lotes, na versão `SYSTEM` antes da substituição e na invalidação do token por três fontes de mudança.

## Prioridade
**P0** — sem a importação o edital volta a ser redigido por cópia e cola, com o risco de divergência em relação ao TR que o épico existe para eliminar; é também o que alimenta o KPI de "minutas criadas com importação do TR".

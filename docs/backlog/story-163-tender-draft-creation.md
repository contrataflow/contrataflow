---
id: US-163
title: "Criar a minuta do edital com cabeçalho tipado"
epic: EP-027
feature: FT-078
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-039, US-065, US-110]
modules: [tender, document, process, catalog, access, timeline, audit, platform]
screens: [SCR-021, SCR-006]
endpoints: [TND-01, TND-02, TND-03, TND-04, DOC-05]
permissions: [TENDER_CREATE, TENDER_UPDATE, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [TenderCreated, TenderUpdated, DocumentCreated]
---

# US-163 — Criar a minuta do edital com cabeçalho tipado

## Título
Criar a minuta do edital com cabeçalho tipado

## Descrição
**Como** servidor de Licitações que recebeu o processo na etapa `MINUTA_EDITAL`, **quero** criar, dentro do processo, a minuta do edital já com o cabeçalho tipado (modalidade, critério de julgamento, modo de disputa, regime de execução, adjudicação, benefício a pequenas empresas, forma eletrônica, prazos, garantia, visita técnica e exigências de habilitação) e editá-lo enquanto a minuta está em elaboração, **para** que o edital nasça coerente com o processo, sem redigitar o que o sistema já sabe, e para que nenhuma minuta incompleta de cabeçalho chegue ao Jurídico.

A story entrega: a criação atômica do `Tender` (1:1 com o processo) e do documento `EDITAL` a partir do template publicado do órgão (TND-01); a leitura da minuta pelo processo e pelo id (TND-02, TND-03); a edição parcial do cabeçalho com `If-Match` (TND-04); o cálculo da exigência de matriz de alocação de riscos (`riskMatrixRequired`); a aba "Edital" do processo (SCR-006) e a moldura da tela SCR-021 com o formulário do cabeçalho. A importação do TR é da US-164, os lotes da US-165, a matriz de riscos da US-166, a minuta do contrato da US-167, a conclusão da US-168 e o rascunho por IA da US-169.

## Contexto
- O edital (art. 25 da Lei 14.133/2021) é o produto final da fase preparatória e hoje é redigido fora do sistema. A DEC-201 cria o módulo `tender`: `Tender` (cabeçalho tipado, 1:1 com o processo e com o documento `EDITAL`, `id = documentId`), `TenderLot`, `TenderLotItem` e `TenderRiskAllocation`. O `EDITAL` é um documento tipado (`SystemDocumentModule.TENDER`, `requiresApproval = false`, `allowMultiplePerProcess = false`, código `ED {seq:4}/{year}`) com o ciclo de vida único da DEC-018.
- **No MVP 2 só existe a minuta.** O código `ED 0001/2026` é o código interno do documento, **não** o número do edital; número do edital, publicação e `PUBLISHED` ficam para o MVP 3 (DEC-201). A aprovação do edital é a etapa `AUTORIZACAO_LICITACAO` (DEC-196, POL-23), não uma `Approval` do documento.
- A posição da etapa `MINUTA_EDITAL` entre `DOTACAO` e `JURIDICO` é padrão semeado do workflow v2 (DEC-196, US-130), a validar com o jurídico do piloto: o parecer do art. 53 analisa a minuta já elaborada.
- A edição segue a POL-02 com `TENDER_UPDATE` para `EDITAL` e `MINUTA_CONTRATO` (permissions.md §7): custódia **ou** participação `COLLABORATOR`/`CONSULTANT`, documento em `DRAFT`/`RETURNED`, tipo permitido na etapa atual (`WorkflowStage.documentTypeCodes`) e processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`. As coleções tipadas do edital (`TenderLot`, `TenderRiskAllocation`) seguem a regra do documento dono.
- Sigilo do orçamento (art. 24, DEC-030, POL-09): `estimatedValueDisclosed` nasce como `NOT process.isBudgetConfidential`; o cabeçalho em si não guarda valores monetários, e nenhum valor entra em evento, log ou auditoria.
- O cabeçalho espelha o que o TR já decidiu (`selectionCriterionId`, `awardType`, vigência, prazo, garantia). A **sugestão** do critério de julgamento a partir do TR é conveniência de tela; a **importação** com registro de versão de origem é da US-164.

## Objetivo
Garantir que 100% das minutas de edital nasçam de uma criação única e atômica (cabeçalho tipado mais documento `EDITAL`), com os defaults do processo aplicados e as obrigatoriedades condicionais (RN-TND-03) validadas já no cabeçalho, que a criação leve a Licitações a qualquer aba da minuta em até 2 cliques a partir do detalhe do processo e que nenhum valor sigiloso apareça no cabeçalho, nos eventos ou nos logs.

## Persona
- **Principal:** Licitações (`LICITACOES`) — cria e edita a minuta.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, também possui `TENDER_CREATE`/`TENDER_UPDATE`); Consultoria externa (`CONSULTOR_EXTERNO`), que edita o cabeçalho apenas como participante (`TENDER_UPDATE`); Planejamento e Compras, que conferem a fidelidade ao TR (leitura); Jurídico e autoridade, que leem a minuta depois de concluída; Auditor (leitura).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`, MFA conforme `security.mfaPolicy` (`TENDER_CREATE` e `TENDER_UPDATE` são risco `M`: MFA só com política `ALL`).
- Para **criar** (TND-01): `TENDER_CREATE` cobrindo o processo; custódia do processo (POL-01: `currentResponsibleId` ou lotação na `currentDepartmentId`); processo em `DRAFT`, `IN_PROGRESS` ou `RETURNED`; tipo `EDITAL` permitido na etapa ativa; tipo `EDITAL` ativo no tenant com template `PUBLISHED`; o processo ainda sem `Tender`.
- Para **editar** (TND-04): `TENDER_UPDATE` cobrindo o processo; custódia ou participação `COLLABORATOR`/`CONSULTANT` (POL-02); documento `EDITAL` em `DRAFT` ou `RETURNED`; tipo permitido na etapa; processo editável.
- Para **ler** (TND-02, TND-03): `PROCESS_VIEW` cobrindo o processo.
- Recomendado, não exigido: TR concluído (US-039), porque o formulário sugere o critério de julgamento do TR e a US-164 importa o restante.

## Fluxo principal
1. A pessoa de Licitações abre o processo na etapa `MINUTA_EDITAL` (SCR-006) e entra na aba **"Edital"**. O front chama TND-02, que responde `data: null` com `meta.canCreate = true`; a aba mostra o estado vazio "Este processo ainda não tem minuta de edital" e o botão **"Criar minuta do edital"**.
2. O botão abre o diálogo **"Nova minuta do edital"**, com o cabeçalho em três blocos: *Contratação* (modalidade, critério de julgamento, modo de disputa, regime de execução, adjudicação, registro de preços, benefício a pequenas empresas), *Condições* (forma eletrônica e justificativa, validade da proposta, prazo de execução, vigência, garantia, visita técnica, divulgação do valor estimado) e *Habilitação* (jurídica, fiscal/social/trabalhista, econômico-financeira, técnica). Modalidade, registro de preços e divulgação do valor vêm preenchidos com os defaults do processo; o critério de julgamento vem sugerido pelo TR, quando o TR tem um.
3. O formulário valida em tempo real as obrigatoriedades condicionais (modo de disputa para pregão e concorrência; regime de execução para serviços e obras; justificativa quando a forma não é eletrônica) e mostra, ao lado do regime e do objeto, o aviso **"A matriz de alocação de riscos será exigida"** quando a regra de exigência se aplica.
4. A pessoa confirma em **"Criar minuta"**. O front envia TND-01 com `Idempotency-Key`.
5. A API valida existência e tenant, permissão e custódia, status do processo, tipo permitido na etapa, template publicado, unicidade do edital e o corpo. Em **uma transação** (com `SELECT … FOR UPDATE` no processo) cria o `Document` `EDITAL` em `DRAFT` (código `ED 0001/2026`, título padrão "Edital — 0012/2026", seções do template inicializadas, `responsibleId` o próprio usuário), cria o `Tender` com `id = documentId`, calcula `riskMatrixRequired`, semeia os lotes a partir de `ProcessItem.lotNumber`/`lotName` quando o planejamento já definiu lotes (RN-TND-39), audita `tender.create` e `document.create`, grava no outbox `TenderCreated` e `DocumentCreated` (e `TenderLotsChanged`, se houve lotes) e projeta `TENDER_CREATED` na timeline.
6. A API responde 201 com a minuta, `ETag` e `Location: /api/v1/tenders/{id}`. O front navega para SCR-021 (`/processos/[id]/edital/[tenderId]`) e mostra o toast "Minuta do edital criada: ED 0001/2026".
7. Em SCR-021 a pessoa vê o cabeçalho, o painel de situação (documento `DRAFT`, importação do TR pendente, lotes, matriz de riscos, minuta do contrato) e o editor das seções do template (autosave por DOC-05, MVP 1).
8. Para ajustar o cabeçalho, a pessoa edita os campos e o front envia TND-04 com `If-Match` (ETag do `Tender`) apenas com os campos alterados. A API reaplica as validações sobre o estado resultante, grava, incrementa a `version`, recalcula `riskMatrixRequired`, audita `tender.update` e publica `TenderUpdated` com `changedFields[]`.
9. A pessoa de Planejamento, de Compras ou o Jurídico abrem a aba "Edital" e leem o cabeçalho em modo somente leitura (TND-03), sem botões de edição.

## Fluxos alternativos
- **FA-01 — Minuta já existe:** TND-01 em processo que já tem `Tender` responde 409 `DOCUMENT_ALREADY_EXISTS` com `meta.existingTenderId`; o front leva à SCR-021 existente (RN-TND-01).
- **FA-02 — Reenvio da criação:** a mesma chave de idempotência e o mesmo corpo devolvem a mesma resposta com `Idempotent-Replayed: true` e não criam segundo documento nem segundo número `ED`.
- **FA-03 — Processo sem modalidade prevista:** `process.modalityId` nulo ("A definir"); o campo "Modalidade" vem vazio e é obrigatório; sem ele, 422 `VALIDATION_ERROR` (`REQUIRED`) em `modalityId`.
- **FA-04 — Modalidade de contratação direta:** `DISPENSA` e `INEXIGIBILIDADE` (`metadata.isDirectContracting = true`) não geram edital; 422 `VALIDATION_ERROR` (`NOT_ALLOWED`) em `modalityId` com orientação de escolher outra modalidade (RN-TND-23).
- **FA-05 — Etapa não permite o tipo:** o processo está em etapa cuja lista `documentTypeCodes` não contém `EDITAL` (por exemplo `JURIDICO`); 422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`; a aba mostra a minuta em leitura, quando existe, e o botão de criar fica oculto com a dica "O edital é elaborado na etapa Minuta do edital" (RN-TND-20).
- **FA-06 — Template sem versão publicada:** 422 `VALIDATION_ERROR` (`REFERENCE_INACTIVE` em `documentType`) com a orientação de falar com o administrador; nenhum registro é criado.
- **FA-07 — Orçamento sigiloso:** o processo é sigiloso; `estimatedValueDisclosed` nasce `false` e o campo fica desabilitado com a dica "O orçamento deste processo é sigiloso (art. 24)"; enviar `true` responde 422 (RN-TND-28).
- **FA-08 — Forma não eletrônica:** desmarcar "Licitação eletrônica" exibe a justificativa obrigatória (art. 17, § 2º); voltar a marcar limpa a justificativa (RN-TND-26).
- **FA-09 — Edital fora de `DRAFT`/`RETURNED`:** TND-04 com o documento `FINALIZED`, `IN_REVIEW`, `APPROVED`, `REJECTED` ou `CANCELED` responde 409 `DOCUMENT_NOT_EDITABLE`; a tela fica em leitura e, para `FINALIZED`, oferece a reabertura do documento (DOC-12, `DOCUMENT_REOPEN`, POL-11), que não é desta story.
- **FA-10 — Alteração que não muda nada:** TND-04 cujo corpo reproduz os valores atuais responde 200 sem incrementar a `version`, sem auditoria e sem evento (RN-TND-31).
- **FA-11 — Participante consultor:** `CONSULTOR_EXTERNO` participante edita o cabeçalho (TND-04) mas não cria a minuta nem vê o botão "Criar minuta do edital" (não possui `TENDER_CREATE`).
- **FA-12 — Divergência de modalidade com o processo:** o cabeçalho usa modalidade diferente da prevista no processo; a tela mostra o aviso "A modalidade do edital difere da modalidade prevista no processo", sem bloquear e sem alterar o processo (RN-TND-22).
- **FA-13 — Conflito de edição:** `If-Match` divergente em TND-04 responde 412 `VERSION_CONFLICT`; o front recarrega o cabeçalho e preserva o que a pessoa digitou para reaplicar.

## Regras de negócio
- **RN-TND-01** — Há um só `Tender` por processo, 1:1 com o documento `EDITAL`; o edital não admite múltiplos documentos por processo (DEC-201). *(regra da feature, adotada)*
- **RN-TND-02** — A criação herda do processo modalidade, registro de preços e sigilo do orçamento (`estimatedValueDisclosed = NOT isBudgetConfidential`) (DEC-201, art. 24). *(regra da feature, adotada)*
- **RN-TND-03** — `disputeMode` é obrigatório para pregão e concorrência e `executionRegime` para serviços e obras; forma não eletrônica exige justificativa (DEC-201). *(regra da feature, adotada)*
- **RN-TND-09** — Concluir exige critério de julgamento e modalidade preenchidos, lotes cobrindo os itens e matriz completa quando exigida; a conclusão não aprova nada. *(regra da feature, adotada; a conclusão é da US-168 — aqui o cabeçalho garante critério e modalidade desde a criação)*
- **RN-TND-10** — A edição segue o ciclo de vida do documento (DEC-018) e a POL-02 com `TENDER_UPDATE`, apenas em `DRAFT` ou `RETURNED` para o colaborador; valores seguem o sigilo do orçamento (DEC-030). *(regra da feature, adotada)*
- **RN-TND-20** *(nova)* — Criar (TND-01): `TENDER_CREATE` cobrindo o processo + custódia (POL-01, `NOT_PROCESS_CUSTODIAN`) + processo em `DRAFT`/`IN_PROGRESS`/`RETURNED` (`INVALID_PROCESS_STATUS`) + `EDITAL` permitido na etapa ativa, isto é, lista `documentTypeCodes` vazia ou contendo `EDITAL` (`DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`) + template `PUBLISHED`. Participação `COLLABORATOR`/`CONSULTANT` não basta: criar exige `TENDER_CREATE`. Na etapa `MINUTA_EDITAL` semeada, `documentTypeCodes = [EDITAL, MINUTA_CONTRATO]` (lacuna 3).
- **RN-TND-21** *(nova)* — Criação atômica e numerada: o `Document` `EDITAL` (`DRAFT`, `code` `ED {seq:4}/{year}` com a numeração por `(tenant, tipo, ano)` do MVP 1, título padrão "Edital — {código do processo}" editável de 5 a 250 caracteres, `templateVersionId` da versão `PUBLISHED`, seções inicializadas, `responsibleId` o usuário) e o `Tender` (`id = documentId`) nascem na mesma transação, sob `SELECT … FOR UPDATE` no processo; falha em qualquer passo desfaz tudo (a sequência de numeração pode ficar com lacuna, como no MVP 1). A unicidade `(tenant_id, process_id)` e `(tenant_id, document_id)` é a rede de segurança.
- **RN-TND-22** *(nova)* — Defaults herdados na criação: `modalityId ← process.modalityId`, `isPriceRegistration ← process.isPriceRegistration`, `estimatedValueDisclosed ← NOT process.isBudgetConfidential`, `awardType = BY_ITEM`, `smallBusinessBenefit = NONE`, `isElectronic = true`, `habilitationRequirements` com o mínimo legal (`legal = true`, `fiscalSocialLabor = true`, `economicFinancial.required = false`, `technical.required = false`). O corpo pode sobrescrever qualquer um (respeitadas as regras abaixo). O `Tender` **não** altera o processo: `Process.modalityId` e `isPriceRegistration` continuam do módulo `process`; divergência só gera aviso na tela.
- **RN-TND-23** *(nova)* — `modalityId` é obrigatório (a coluna não aceita nulo): vem do processo e, se o processo tem modalidade "A definir", deve ser informado. Deve ser item ativo do catálogo `MODALITY` com `metadata.isDirectContracting = false`; modalidades de contratação direta não geram edital (`NOT_ALLOWED`). `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` para item inexistente, de outro tenant ou inativo.
- **RN-TND-24** *(nova)* — `judgmentCriterionId` é obrigatório (a coluna não aceita nulo) e deve ser item ativo do catálogo `JUDGMENT_CRITERION`. A tela sugere o `selectionCriterionId` do TR vigente do processo, quando existe; a sugestão é só preenchimento do formulário e **não** grava `importedFromTermVersionId` (isso é a importação, US-164).
- **RN-TND-25** *(nova)* — Obrigatoriedades condicionais de RN-TND-03: `disputeMode` (`OPEN`, `CLOSED`, `OPEN_CLOSED`, `CLOSED_OPEN` — art. 56) é obrigatório quando a modalidade é `PREGAO` ou `CONCORRENCIA` (código semeado do catálogo); `executionRegime` (art. 46) é obrigatório quando o tipo de contratação do processo (`CONTRACTING_TYPE.metadata.itemKinds`) contém `SERVICE`, `ENGINEERING_SERVICE` ou `WORK`. Fora dessas hipóteses os campos são opcionais e, se enviados, validados contra o enum (`CONDITIONAL_REQUIRED` quando faltam).
- **RN-TND-26** *(nova)* — Forma eletrônica (art. 17, § 2º): `isElectronic = false` exige `inPersonJustification` de 10 a 2.000 caracteres, texto puro, aparado (`CONDITIONAL_REQUIRED`); com `isElectronic = true` a justificativa é descartada (gravada `null`). O check do banco `is_electronic OR in_person_justification IS NOT NULL` é a rede de segurança.
- **RN-TND-27** *(nova)* — Faixas dos prazos e da garantia: `proposalValidityDays` de 1 a 365; `executionTermDays` de 1 a 3.650; `contractTermMonths` de 1 a 120 (mesma faixa do TR); `guaranteePercent` de 0 a 10 com duas casas (arts. 96 a 98), admitindo mais de 10 e até 30 apenas quando o tipo de contratação contém `WORK` (obras, retomada pela seguradora — o limite de 30 é o check do banco); `siteVisit` em `NONE`, `OPTIONAL` ou `MANDATORY`. Todos são opcionais na criação e passam a compor a completude do documento conforme o template (US-168). Fora da faixa: `OUT_OF_RANGE`.
- **RN-TND-28** *(nova)* — Divulgação do valor estimado (art. 24): se `process.isBudgetConfidential = true`, `estimatedValueDisclosed = true` é recusado com 422 `VALIDATION_ERROR` (`NOT_ALLOWED`); se o processo não é sigiloso, o campo nasce `true` e pode ser posto `false` por quem edita o cabeçalho (o órgão pode optar por não divulgar o valor no edital). O cabeçalho não guarda valor monetário; valores de lotes seguem a POL-09 (US-165). Se o sigilo do processo mudar depois da criação, a coerência é revalidada na conclusão (lacuna 7).
- **RN-TND-29** *(nova)* — Exigências de habilitação: `habilitationRequirements` é validado pelo `tenderHabilitationSchema` (entities.md §7.7): `legal` e `fiscalSocialLabor` são verdadeiros, salvo `waiverJustification` preenchida (art. 70, III; 10 a 2.000 caracteres); em `economicFinancial`, `indices[].min` maior que zero e `minNetWorthPercent` de 0 a 10 (art. 69, § 4º); em `technical`, `quantitativeMinPercent` de 1 a 50 (art. 67, § 2º) e `professional`/`operational` com até 2.000 caracteres; sub-objetos com `required = false` não aceitam detalhamento preenchido (`NOT_ALLOWED`).
- **RN-TND-30** *(nova)* — Exigência da matriz de riscos: `riskMatrixRequired` é **calculado** pelo servidor (nunca informado) e gravado a cada escrita do `Tender`. Fica `true` quando: (a) `executionRegime` é `INTEGRATED` ou `SEMI_INTEGRATED` (art. 22, § 3º); (b) o tipo de contratação contém `WORK` ou `ENGINEERING_SERVICE` e o valor estimado do processo atinge o limite de grande vulto da regra semeada (art. 6º, XXII); ou (c) `tender.riskMatrixValueThreshold` não é nulo e o valor estimado do processo é maior ou igual a ele. As hipóteses são configuração semeada (DEC-016), não código; o cálculo roda no servidor mesmo com orçamento sigiloso e a resposta traz apenas `riskMatrixReasons[]` (`INTEGRATED_REGIME`, `LARGE_VALUE_WORK`, `VALUE_THRESHOLD`), nunca o valor ou o limite. Sem valor estimado no processo, (b) e (c) não se aplicam.
- **RN-TND-31** *(nova)* — Edição parcial (TND-04): corpo com qualquer subconjunto dos campos editáveis, `If-Match` obrigatório; as validações valem sobre o **estado resultante** (campo enviado mais campos já gravados), de modo que trocar a modalidade para `PREGAO` sem `disputeMode` gravado é recusado. Campos que não mudam não contam: corpo sem diferença responde 200 sem alterar `version`, sem auditoria e sem evento. São somente leitura (`NOT_ALLOWED`): `processId`, `documentId`, `contractDraftDocumentId` (US-167), `importedFromTermVersionId` e `importedAt` (US-164), `riskMatrixRequired` e qualquer campo desconhecido.
- **RN-TND-32** *(nova)* — Efeitos da mudança do cabeçalho em outras partes: trocar `awardType` de `BY_LOT` para outro valor mantém os lotes gravados (apenas deixam de ser exigidos); trocar para `BY_LOT` não cria lotes (a cobertura é verificada na conclusão, US-168, e orientada na US-165); mudar `executionRegime` ou a modalidade pode ligar ou desligar `riskMatrixRequired` sem apagar a matriz já preenchida.
- **RN-TND-33** *(nova)* — Edição e documento: o cabeçalho é editável enquanto o `EDITAL` está em `DRAFT`/`RETURNED`, sob POL-02; o título do documento e as seções seguem DOC-04 e DOC-05 do MVP 1. Documento `FINALIZED` volta a ser editável apenas por reabertura (DOC-12, POL-11), que a US-168 trata; após a reabertura, TND-04 volta a funcionar.
- **RN-TND-34** *(nova)* — Leitura: TND-02 e TND-03 exigem `PROCESS_VIEW` cobrindo o processo (DEC-024); processo de outro tenant ou invisível responde 404. TND-03 devolve `editable` e `editBlockedReason`, o resumo do documento (`id`, `code`, `title`, `status`, `version`, `currentVersionId`), os contadores de lotes e de matriz (preenchidos pelas US-165 e US-166), `riskMatrixReasons[]` e `termChangedSinceImport` (calculado pela US-164: a versão vigente do TR é outra que `importedFromTermVersionId`). A permissão `TENDER_VIEW` citada na DEC-201 como indicativa não existe no catálogo: a leitura é `PROCESS_VIEW` (permissions.md §9).
- **RN-TND-35** *(nova)* — Concorrência: TND-01 é atômica e idempotente por `Idempotency-Key` e pelas unicidades; duas criações simultâneas no mesmo processo resultam em exatamente uma `201` e a outra `409` `DOCUMENT_ALREADY_EXISTS`. TND-04 usa `If-Match` com a `version` do `Tender` (412 `VERSION_CONFLICT`; ausente, 428 `PRECONDITION_REQUIRED`); a mesma `version` é incrementada por qualquer escrita do tender (cabeçalho, importação, lotes e matriz), o que mantém um só ETag por minuta.
- **RN-TND-36** *(nova)* — Eventos, timeline e notificação: criar publica `TenderCreated` (`tenderId`, `documentId`, `contractDraftDocumentId` ausente, `modalityCode`, `judgmentCriterionCode`) e o genérico `DocumentCreated` (`document.created.edital`); projeta `TENDER_CREATED` ("{actor} criou a minuta do edital", parâmetro `documentCode`) na timeline; editar publica `TenderUpdated` com `changedFields[]` (apenas nomes de campo) e só audita. Nenhuma notificação: `events.md` §6 não prevê tipo para criação ou edição do cabeçalho.
- **RN-TND-37** *(nova)* — Sigilo e privacidade: eventos, logs, auditoria e notificações carregam ids, códigos de catálogo, nomes de campo, tamanhos e hashes; nunca o texto de `inPersonJustification`, de `waiverJustification` nem dos requisitos técnicos, nem valores do orçamento (DEC-030).
- **RN-TND-38** *(nova)* — Participação: o participante `COLLABORATOR`/`CONSULTANT` com `TENDER_UPDATE` edita o cabeçalho do `EDITAL` em `DRAFT`/`RETURNED` (permissions.md §4) e não cria a minuta, não importa orçamento sigiloso e não conclui; tentar criar responde 403 `PERMISSION_DENIED`.

- **RN-TND-39** *(nova)* — Lotes na criação: `entities.md` §4.5 manda os lotes nascerem de `ProcessItem.lotNumber`/`lotName` "na criação e na importação do TR". Ao criar, se algum `ProcessItem` do processo tem `lotNumber`, o `TenderLotSeeder` (definido na US-165) cria um `TenderLot` por número de lote (`name` = `lotName`) e um `TenderLotItem` por item, na mesma transação; itens sem lote ficam sem lote (a cobertura só é cobrada com `awardType = BY_LOT`, US-165 e US-168); sem item com lote, nada é criado. A semente **não** altera `ProcessItem` (o planejamento continua do módulo `process`) e publica `TenderLotsChanged` (`lotsCount`, `itemsUnassigned`) com a auditoria `tender.lots_update` (`metadata.source = SEED`).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Título do edital | `title` (TND-01) | texto (5..250) | Não | RN-TND-21; vira o título do documento | "Edital — {código do processo}" |
| Modalidade | `modalityId` | seleção (`MODALITY`) | Sim | RN-TND-23; sem contratação direta | `process.modalityId` |
| Critério de julgamento | `judgmentCriterionId` | seleção (`JUDGMENT_CRITERION`) | Sim | RN-TND-24 | sugestão do TR (`selectionCriterionId`) |
| Modo de disputa | `disputeMode` | `OPEN` \| `CLOSED` \| `OPEN_CLOSED` \| `CLOSED_OPEN` | Condicional | Pregão e concorrência (RN-TND-25) | em branco |
| Regime de execução | `executionRegime` | enum `ExecutionRegime` (8 valores) | Condicional | Serviços e obras (RN-TND-25) | em branco |
| Adjudicação | `awardType` | `BY_ITEM` \| `BY_LOT` \| `GLOBAL` | Não | RN-TND-32 | `BY_ITEM` |
| Sistema de Registro de Preços | `isPriceRegistration` | booleano | Não | RN-TND-22 | `process.isPriceRegistration` |
| Benefício a pequenas empresas | `smallBusinessBenefit` | `NONE` \| `EXCLUSIVE` \| `RESERVED_QUOTA` \| `SUBCONTRACTING` | Não | LC 123/2006, arts. 47 a 49 | `NONE` |
| Licitação eletrônica | `isElectronic` | booleano | Não | RN-TND-26 | `true` |
| Justificativa da forma presencial | `inPersonJustification` | texto (10..2.000) | Condicional | Obrigatória com `isElectronic = false` | em branco |
| Divulgar o valor estimado | `estimatedValueDisclosed` | booleano | Não | RN-TND-28 | `NOT process.isBudgetConfidential` |
| Validade da proposta (dias) | `proposalValidityDays` | inteiro (1..365) | Não | RN-TND-27 | em branco |
| Prazo de execução/entrega (dias) | `executionTermDays` | inteiro (1..3.650) | Não | RN-TND-27 | em branco |
| Vigência prevista (meses) | `contractTermMonths` | inteiro (1..120) | Não | RN-TND-27 | em branco |
| Garantia contratual (%) | `guaranteePercent` | decimal (0..10; até 30 em obras), 2 casas | Não | RN-TND-27 | em branco |
| Visita técnica | `siteVisit` | `NONE` \| `OPTIONAL` \| `MANDATORY` | Não | RN-TND-27 | em branco |
| Exigências de habilitação | `habilitationRequirements` | objeto `TenderHabilitation` | Não | RN-TND-29 | mínimo legal |
| Versão do cabeçalho | `If-Match` (ETag) | texto | Sim (TND-04) | `Tender.version` | `GET` TND-03 |
| Chave de idempotência | `Idempotency-Key` | texto | Sim (TND-01) | 24 h | gerada pelo front |
| *(saída)* Matriz de riscos exigida | `riskMatrixRequired`, `riskMatrixReasons[]` | booleano / lista | — | RN-TND-30 | calculado |
| *(saída)* Documento | `document` (`id`, `code`, `title`, `status`, `version`) | objeto | — | RN-TND-34 | `Document` `EDITAL` |
| *(saída)* Origem do TR | `importedFromTermVersionId`, `importedAt`, `termChangedSinceImport` | uuid / data / booleano | — | US-164 | `Tender` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `modalityId` ausente (processo sem modalidade prevista) | Front + API (Zod) | "Escolha a modalidade do edital." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-02 | `modalityId` de contratação direta | API | "Dispensa e inexigibilidade não têm edital. Escolha outra modalidade." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-03 | Catálogo inexistente, de outro tenant ou inativo | API | "Escolha uma opção válida da lista." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-04 | `judgmentCriterionId` ausente | Front + API | "Escolha o critério de julgamento." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-05 | Pregão ou concorrência sem `disputeMode` | Front + API | "Informe o modo de disputa para pregão e concorrência." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-06 | Serviço ou obra sem `executionRegime` | Front + API | "Informe o regime de execução para serviços e obras." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-07 | `isElectronic = false` sem justificativa de 10 a 2.000 caracteres | Front + API | "Justifique a escolha da forma presencial (mín. 10 caracteres)." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-08 | Prazo, validade, vigência ou garantia fora da faixa | Front + API | "Informe um valor entre {min} e {max}." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-09 | Garantia acima de 10% fora de obra | API | "Garantia acima de 10% só é admitida em obras." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-10 | `estimatedValueDisclosed = true` em processo sigiloso | API | "O orçamento é sigiloso (art. 24). Não é possível divulgar o valor no edital." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-11 | `habilitationRequirements` fora do schema | Front + API | "Revise as exigências de habilitação." | `VALIDATION_ERROR` |
| V-12 | Campo somente leitura ou desconhecido no `PATCH` | API | "Este campo não pode ser alterado aqui." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-13 | `title` fora de 5 a 250 caracteres | Front + API | "Informe um título entre 5 e 250 caracteres." | `VALIDATION_ERROR` (`TOO_SHORT`/`TOO_LONG`) |
| V-14 | Template do `EDITAL` sem versão publicada | API | "O edital não tem um modelo publicado. Fale com o administrador." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) |
| V-15 | Tipo `EDITAL` não permitido na etapa | API | "O edital é elaborado na etapa Minuta do edital." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` (422) |
| V-16 | Processo em status não editável | API | "O processo não está em andamento." | `INVALID_PROCESS_STATUS` (409) |
| V-17 | Já existe minuta no processo | API | "Este processo já tem uma minuta de edital." | `DOCUMENT_ALREADY_EXISTS` (409) |
| V-18 | Documento fora de `DRAFT`/`RETURNED` | API | "A minuta não pode ser editada no status atual." | `DOCUMENT_NOT_EDITABLE` (409) |
| V-19 | `If-Match` ausente ou divergente | API | "Atualize a página e tente de novo." / "A minuta foi alterada por outra pessoa." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-20 | Chave de idempotência reutilizada com corpo diferente | API | "Esta chave já foi usada em outra solicitação." | `IDEMPOTENCY_KEY_REUSED` (422) |

## Permissões
- **Permissão:** `TENDER_CREATE` com escopo que cubra o processo para criar; `TENDER_UPDATE` cobrindo o processo para editar o cabeçalho; `PROCESS_VIEW` para ler (TND-02, TND-03). Perfis com `TENDER_CREATE`: `LICITACOES` e `GESTOR_CONTRATACOES`; com `TENDER_UPDATE`: os mesmos mais `CONSULTOR_EXTERNO` (permissions.md §3).
- **Políticas:** POL-01 (custódia para criar), POL-02 (edição de documento: `EDITAL` ← `TENDER_UPDATE`, custódia ou participação, `DRAFT`/`RETURNED`, etapa, status do processo), POL-09 (sigilo do orçamento), DEC-024 (visibilidade). Segregação POL-19 e POL-23 incide depois: quem cria ou edita o edital não analisa nem aprova (o autor fica registrado em `Document.createdById` e nas versões).
- **MFA:** `TENDER_CREATE` e `TENDER_UPDATE` são risco `M`: exigido apenas com `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão "Criar minuta do edital" e os campos de edição ficam ocultos ou desabilitados; a API responde 403 `PERMISSION_DENIED` ou `NOT_PROCESS_CUSTODIAN` e grava `access.denied`; minuta ou processo de outro tenant, ou de processo invisível, responde 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TenderCreated` | `tender.created` | Commit de TND-01 | `tenderId`, `documentId`, `modalityCode`, `judgmentCriterionCode` (`contractDraftDocumentId` ausente); consumidores T (timeline `TENDER_CREATED`) e R (read model) |
| `TenderLotsChanged` | `tender.lots_changed` | Mesmo commit, só se houve lotes semeados (RN-TND-39) | `tenderId`, `lotsCount`, `itemsUnassigned`; sem consumidor síncrono |
| `DocumentCreated` | `document.created.edital` | Mesmo commit | Evento genérico do MVP 1 (`documentId`, `documentTypeCode`, `kind`, `code`, `title`, `templateVersionId`) |
| `TenderUpdated` | `tender.updated` | Commit de TND-04 com alteração efetiva | `tenderId`, `changedFields[]`; sem valores nem texto; sem consumidor síncrono |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação nesta story: `events.md` §6 não prevê tipo para criação ou edição do cabeçalho do edital (a notificação do fim da elaboração é da conclusão, US-168, se prevista) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Criar a minuta do edital com cabeçalho tipado

  Background:
    Given que o tenant "Prefeitura A" está ativo e o modelo "EDITAL" está publicado
    And o processo "0012/2026" é um pregão de aquisição de bens, está "IN_PROGRESS" na etapa "MINUTA_EDITAL", que permite os tipos "EDITAL" e "MINUTA_CONTRATO"
    And o processo tem a modalidade prevista "PREGAO", orçamento não sigiloso e valor estimado de "R$ 480.000,00"
    And "Lia Moreira" tem o perfil "LICITACOES" com "TENDER_CREATE", "TENDER_UPDATE" e a custódia do processo
    And "Paulo Reis", da consultoria externa, é participante "CONSULTANT" do processo com "TENDER_UPDATE"
    And "Marcos Ribeiro", de Compras, tem "PROCESS_VIEW" e não tem permissões de edital
    And o processo tem um TR concluído com critério de seleção "MENOR_PRECO"

  Scenario: [Sucesso] Criar a minuta com os defaults do processo
    When "Lia Moreira" chamar "POST /processes/{id}/tender" com "judgmentCriterionId" "MENOR_PRECO", "disputeMode" "OPEN" e a chave "K1"
    Then a API deve responder 201 com o "Tender" e o cabeçalho "Location" e "ETag"
    And o documento "EDITAL" deve nascer "DRAFT" com o código "ED 0001/2026", o título "Edital — 0012/2026" e as seções do modelo
    And o "Tender" deve ter "id" igual a "documentId", modalidade "PREGAO", "awardType" "BY_ITEM", "isElectronic" verdadeiro e "estimatedValueDisclosed" verdadeiro
    And "riskMatrixRequired" deve ser falso
    And deve gerar a auditoria "tender.create" e "document.create"
    And devem ser publicados os eventos "TenderCreated" e "DocumentCreated" do tipo "edital"
    And a timeline deve exibir "Lia Moreira criou a minuta do edital"

  Scenario: [Sucesso] Lotes semeados a partir do planejamento
    Given que os itens 1 e 2 do processo estão no lote 1 "Material de expediente" e o item 3 está no lote 2 "Informática"
    When "Lia Moreira" criar a minuta
    Then devem existir os lotes 1 e 2 com os itens correspondentes e nenhum item sem lote
    And deve ser publicado o evento "TenderLotsChanged" com "lotsCount" 2 e "itemsUnassigned" 0
    And os itens do processo devem continuar com os mesmos "lotNumber" e "lotName"

  Scenario: [Sucesso] Processo com orçamento sigiloso nasce sem divulgar o valor
    Given que o orçamento do processo é sigiloso
    When "Lia Moreira" criar a minuta
    Then o "Tender" deve ter "estimatedValueDisclosed" falso
    And nenhum evento, log ou auditoria deve conter o valor estimado

  Scenario: [Sucesso] Regime de contratação integrada exige a matriz de riscos
    Given que o processo é uma obra de engenharia
    When "Lia Moreira" criar a minuta com "executionRegime" "INTEGRATED"
    Then a API deve responder 201 com "riskMatrixRequired" verdadeiro e "riskMatrixReasons" contendo "INTEGRATED_REGIME"
    And a resposta não deve conter o valor estimado nem o limite configurado

  Scenario: [Sucesso] Limite de valor configurado liga a exigência da matriz
    Given que "tender.riskMatrixValueThreshold" é "R$ 400.000,00"
    When "Lia Moreira" criar a minuta
    Then a API deve responder 201 com "riskMatrixRequired" verdadeiro e "riskMatrixReasons" contendo "VALUE_THRESHOLD"

  Scenario: [Sucesso] Ler a minuta pelo processo antes e depois de criar
    When "Marcos Ribeiro" chamar "GET /processes/{id}/tender"
    Then a API deve responder 200 com "data" nulo e "meta.canCreate" falso
    When "Lia Moreira" chamar "GET /processes/{id}/tender"
    Then a API deve responder 200 com "data" nulo e "meta.canCreate" verdadeiro
    Given que a minuta foi criada
    When "Marcos Ribeiro" chamar "GET /tenders/{id}"
    Then a API deve responder 200 com o cabeçalho, o resumo do documento e "editable" falso

  Scenario: [Sucesso] Editar o cabeçalho com If-Match
    Given que a minuta foi criada com a ETag "T1"
    When "Lia Moreira" chamar "PATCH /tenders/{id}" com "proposalValidityDays" 90, "guaranteePercent" 5 e "If-Match" "T1"
    Then a API deve responder 200 com os valores novos e a ETag incrementada
    And deve ser publicado "TenderUpdated" com "changedFields" iguais a "proposalValidityDays" e "guaranteePercent"
    And deve gerar a auditoria "tender.update" sem texto livre

  Scenario: [Sucesso] Corpo sem diferença não altera a versão
    When "Lia Moreira" chamar "PATCH /tenders/{id}" repetindo os valores atuais
    Then a API deve responder 200 com a mesma ETag
    And nenhum evento nem auditoria devem ser gerados

  Scenario: [Sucesso] Participante consultor edita o cabeçalho mas não cria
    Given que a minuta foi criada e o documento está "DRAFT"
    When "Paulo Reis" chamar "PATCH /tenders/{id}" com "siteVisit" "OPTIONAL"
    Then a API deve responder 200
    Given que o processo ainda não tem minuta
    When "Paulo Reis" chamar "POST /processes/{id}/tender"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Validação] Campos obrigatórios e condicionais
    When "Lia Moreira" criar a minuta sem "judgmentCriterionId"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REQUIRED" em "judgmentCriterionId"
    When "Lia Moreira" criar a minuta de pregão sem "disputeMode"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" em "disputeMode"
    Given que o processo contrata um serviço
    When "Lia Moreira" criar a minuta sem "executionRegime"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" em "executionRegime"
    When "Lia Moreira" enviar "isElectronic" falso sem justificativa
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" em "inPersonJustification"
    When "Lia Moreira" enviar "proposalValidityDays" 400
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "OUT_OF_RANGE"
    When "Lia Moreira" enviar "guaranteePercent" 15 em uma aquisição de bens
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "OUT_OF_RANGE"
    And nenhum documento nem "Tender" devem ter sido criados

  Scenario: [Validação] Modalidade de contratação direta e processo sem modalidade
    When "Lia Moreira" criar a minuta com a modalidade "DISPENSA"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" em "modalityId"
    Given que o processo tem modalidade "A definir"
    When "Lia Moreira" criar a minuta sem "modalityId"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REQUIRED" em "modalityId"

  Scenario: [Validação] Divulgação do valor em processo sigiloso
    Given que o orçamento do processo é sigiloso
    When "Lia Moreira" criar a minuta com "estimatedValueDisclosed" verdadeiro
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" em "estimatedValueDisclosed"

  Scenario: [Validação] Etapa fora de MINUTA_EDITAL e edital já finalizado
    Given que o processo está na etapa "JURIDICO", que não permite o tipo "EDITAL"
    When "Lia Moreira" chamar "POST /processes/{id}/tender"
    Then a API deve responder 422 com código "DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE"
    Given que a minuta existe e o documento "EDITAL" está "FINALIZED"
    When "Lia Moreira" chamar "PATCH /tenders/{id}" com "siteVisit" "MANDATORY"
    Then a API deve responder 409 com código "DOCUMENT_NOT_EDITABLE"

  Scenario: [Validação] Modelo sem versão publicada e processo suspenso
    Given que o tipo "EDITAL" não tem modelo publicado
    When "Lia Moreira" chamar "POST /processes/{id}/tender"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_INACTIVE" em "documentType"
    Given que o processo está "SUSPENDED"
    When "Lia Moreira" chamar "POST /processes/{id}/tender"
    Then a API deve responder 409 com código "INVALID_PROCESS_STATUS"

  Scenario: [Permissão] Sem permissão, sem custódia e leitor sem edição
    Given que "Marcos Ribeiro" não tem "TENDER_CREATE"
    When "Marcos Ribeiro" chamar "POST /processes/{id}/tender"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar a auditoria "access.denied"
    Given que "Bruno Lopes", de Licitações, tem "TENDER_CREATE" mas o processo está com outra unidade
    When "Bruno Lopes" chamar "POST /processes/{id}/tender"
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"
    When "Marcos Ribeiro" chamar "PATCH /tenders/{id}" com "siteVisit" "NONE"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And o botão "Criar minuta do edital" não deve aparecer para "Marcos Ribeiro"

  Scenario: [Tenant incorreto] Minuta e processo de outro órgão
    Given que o processo "0003/2026" e a minuta "ED 0002/2026" pertencem ao tenant "Prefeitura B"
    When "Lia Moreira" chamar "GET /processes/{id-0003}/tender", "POST /processes/{id-0003}/tender", "GET /tenders/{id-ED2}" e "PATCH /tenders/{id-ED2}"
    Then a API deve responder 404 em todas as chamadas, com "NOT_FOUND" nas duas primeiras e "TENDER_NOT_FOUND" nas duas últimas
    And nenhum dado da "Prefeitura B" deve aparecer na resposta, nos logs ou na auditoria

  Scenario: [Duplicidade] Segunda minuta, reenvio e reuso de chave
    Given que "Lia Moreira" criou a minuta com a chave "K1" e recebeu 201
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com a mesma resposta e o cabeçalho "Idempotent-Replayed: true"
    And deve existir um único documento "EDITAL" e uma única numeração "ED 0001/2026"
    When "Lia Moreira" chamar "POST /processes/{id}/tender" com a chave "K2"
    Then a API deve responder 409 com código "DOCUMENT_ALREADY_EXISTS" e "meta.existingTenderId"
    When "Lia Moreira" reutilizar a chave "K1" com outro corpo
    Then a API deve responder 422 com código "IDEMPOTENCY_KEY_REUSED"

  Scenario: [Concorrência] Criações simultâneas e edições simultâneas
    When "Lia Moreira" e "Bruno Lopes" (com a custódia compartilhada da unidade) criarem a minuta do mesmo processo ao mesmo tempo
    Then exatamente uma chamada deve responder 201 e a outra 409 com código "DOCUMENT_ALREADY_EXISTS"
    And deve existir um único "Tender" e um único documento "EDITAL" no processo
    Given que "Lia Moreira" e "Paulo Reis" leram a minuta com a ETag "T1"
    When ambos enviarem "PATCH /tenders/{id}" com "If-Match" "T1" e campos diferentes
    Then uma chamada deve responder 200 e a outra 412 com código "VERSION_CONFLICT"
    When a chamada rejeitada for repetida com a ETag nova
    Then a API deve responder 200 e os dois campos devem estar gravados
    When "Lia Moreira" enviar "PATCH /tenders/{id}" sem "If-Match"
    Then a API deve responder 428 com código "PRECONDITION_REQUIRED"

  Scenario: [Falha de banco] Falha na transação de criação e de edição
    Given que o banco de dados fica indisponível durante a transação de "POST /processes/{id}/tender"
    When "Lia Moreira" tentar criar a minuta
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And não deve existir documento "EDITAL", "Tender", numeração consumida, auditoria nem evento no outbox
    Given que o banco de dados fica indisponível durante a transação de "PATCH /tenders/{id}"
    When "Lia Moreira" tentar editar o cabeçalho
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o cabeçalho deve continuar com os valores anteriores

  Scenario: [Falha de integração] Redis e relay do outbox indisponíveis
    Given que o Redis está indisponível
    When "Lia Moreira" criar a minuta
    Then a API deve responder 201 sem consultar o cache de idempotência
    And deve ser registrado log "warn" "idempotency.store_unavailable"
    Given que o relay do outbox está indisponível
    When "Lia Moreira" editar o cabeçalho com sucesso
    Then a API deve responder 200 e o evento "TenderUpdated" deve permanecer "PENDING" no outbox até o relay voltar

  Scenario: [Sucesso] Desempenho da criação e da leitura (teste de suíte, sem benchmark no card)
    Given a suíte de desempenho com um processo de 300 itens
    When forem executadas 50 criações em processos distintos e 200 leituras de "GET /tenders/{id}"
    Then o p95 de "POST /processes/{id}/tender" deve ser menor que 800 ms e o de "GET /tenders/{id}" menor que 300 ms
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Dados inválidos | 422 | `VALIDATION_ERROR` | Mensagem do campo | Marca o campo e foca o primeiro erro |
| Sem `If-Match` | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente de novo." | Recarrega o cabeçalho |
| ETag divergente | 412 | `VERSION_CONFLICT` | "A minuta foi alterada por outra pessoa. Atualize a página." | Recarrega e reaplica o que foi digitado |
| Processo inexistente, de outro tenant ou invisível | 404 | `NOT_FOUND` | "Processo não encontrado." | Volta à lista de processos |
| Minuta inexistente, de outro tenant ou de processo invisível | 404 | `TENDER_NOT_FOUND` | "Minuta do edital não encontrada." | Volta ao detalhe do processo |
| Já existe minuta | 409 | `DOCUMENT_ALREADY_EXISTS` | "Este processo já tem uma minuta de edital." | Abre a minuta existente |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "A minuta não pode ser editada no status atual." | Cabeçalho em leitura; oferece reabertura quando permitida |
| Processo em status não editável | 409 | `INVALID_PROCESS_STATUS` | "O processo não está em andamento." | Oculta as ações |
| Tipo não permitido na etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O edital é elaborado na etapa Minuta do edital." | Oculta "Criar minuta"; explica na dica |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação no edital." | Oculta a ação |
| Sem custódia | 403 | `NOT_PROCESS_CUSTODIAN` | "Você não está com este processo." | Oculta a ação |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Criação em andamento | 409 | `IDEMPOTENCY_IN_PROGRESS` | "Estamos criando a minuta. Aguarde." | Repete a consulta após 2 s |
| Banco ou Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Botão "Tentar novamente"; respeita `Retry-After`; mantém o formulário |

## Dependências
- **Stories:** US-065 (ciclo de vida do documento, validador tipado, DOC-08/DOC-10 que a US-168 usa); US-110 (biblioteca de templates padrão: semeia o modelo `EDITAL` com `importMappings` TR para EDITAL); US-039 (TR concluído, de onde vêm a sugestão do critério e a importação). Indiretas: US-130 (workflow v2 com a etapa `MINUTA_EDITAL` e seus `documentTypeCodes`), US-129 (`RuleContext` v2 com `tender.*`), US-006 (itens do processo), US-063 (DOC-05, autosave de seção), US-164 a US-169 (demais stories do épico, que consomem o `Tender` criado aqui).
- **Decisões/ADRs:** DEC-201, DEC-196, DEC-018, DEC-030, DEC-016, DEC-024; POL-01, POL-02, POL-09; RN-TND-01 a RN-TND-03, RN-TND-09, RN-TND-10.
- **Configurações:** `tender.riskMatrixValueThreshold` (padrão `null`); regra semeada de exigência da matriz (hipóteses do art. 22, § 3º); catálogos `MODALITY` e `JUDGMENT_CRITERION`; template do `EDITAL` do tenant.
- **Lacunas nas fontes canônicas:**
  1. **Códigos de erro novos:** `TENDER_NOT_FOUND` (404) não consta em `api.md`; `DOCUMENT_ALREADY_EXISTS` (409) é reaproveitado do MVP 1 com `meta.existingTenderId`. A consolidar no `api.md` do MVP 2 (IDs `TND-01` a `TND-04` e contratos indicativos desta story).
  2. **Permissão `TENDER_VIEW`:** a DEC-201 a cita como "indicativa", mas `permissions.md` do MVP 2 não a define e usa `PROCESS_VIEW` para ler o edital (§9). Esta story segue `permissions.md`; ajustar o texto da DEC-201.
  3. **`documentTypeCodes` da etapa `MINUTA_EDITAL`:** a US-130 não semeia as listas de tipos permitidos das etapas novas; a story assume `[EDITAL, MINUTA_CONTRATO]` em `MINUTA_EDITAL` (e `PARECER_JURIDICO` em `JURIDICO`, etc.). Registrar no seed do workflow v2.
  4. **`judgmentCriterionId` obrigatório na criação:** `entities.md` §4.5 define a coluna como `não nula` e sem default, enquanto a RN-TND-09 fala em "critério preenchido" na conclusão. A story exige o critério já na criação. **Dúvida de produto:** permitir criar a minuta sem critério (coluna anulável) e cobrar só na conclusão?
  5. **Default de `habilitationRequirements`:** `entities.md` lista `{}`, que não satisfaz o `tenderHabilitationSchema` (§7.7 exige `legal`, `fiscalSocialLabor`, `economicFinancial` e `technical`). A story preenche o mínimo legal; ajustar o default em `entities.md`.
  6. **Unidade do prazo de execução:** `executionTermDays` do `Tender` não tem `DayCountType` (o TR tem `executionDeadlineType`). A story trata o campo como dias corridos; ver a US-164 para a importação quando o TR usa dias úteis. **Dúvida de produto:** acrescentar `executionTermType` ao `Tender`?
  7. **Sigilo alterado depois da criação:** não há regra canônica para `estimatedValueDisclosed` quando `Process.isBudgetConfidential` muda depois da criação do `Tender`. A story revalida na conclusão (US-168). **Dúvida de produto:** sincronizar automaticamente?
  8. **Limite de grande vulto e regra semeada:** `entities.md` fala em "regra semeada por valor/objeto" para `riskMatrixRequired`, sem registrar o limite do art. 6º, XXII nem a chave de configuração. A story o trata como configuração semeada; registrar no seed.
  9. **Cancelamento do `EDITAL` (DOC-13):** com `UNIQUE (tenant_id, process_id)` no `Tender`, cancelar o documento deixa o processo sem como recriar a minuta. **Dúvida de produto:** impedir DOC-13 sobre o `EDITAL` ou permitir recriação após cancelamento?
  10. **`DOCUMENT_REOPEN` para `LICITACOES`:** reabrir o `EDITAL` finalizado depois de uma devolução do Jurídico exige a permissão do MVP 1, que `permissions.md` do MVP 2 não menciona para o perfil; conferir na US-168.
  11. **Timeline duplicada:** `TenderCreated` (`TENDER_CREATED`) e `DocumentCreated` (`DOCUMENT_CREATED`) geram dois lançamentos na criação; avaliar suprimir o genérico para o tipo `edital`.
  12. **Ordem de entrega do `TenderLotSeeder`:** a semente de lotes na criação (RN-TND-39) usa um serviço definido na US-165, que depende desta story; implementar o serviço no primeiro dos dois cards a ser desenvolvido (a ordem de desenvolvimento sugerida é US-163, US-165, US-164) e, enquanto ele não existir, TND-01 não semeia lotes.
  13. **Ação de auditoria da criação do documento:** `events.md` §7 lista `tender.create`; a story também grava `document.create` (padrão do MVP 1) com `metadata.tenderId`.

## Impacto técnico
- **Atomicidade e numeração:** a criação trava o processo (`SELECT … FOR UPDATE`), numera o documento pela sequência do MVP 1 e grava `Tender` com `id = documentId` na mesma transação; as unicidades são a rede de segurança contra corrida.
- **Regras semeadas, não código:** a exigência da matriz de riscos e as obrigatoriedades condicionais ficam em um `TenderHeaderPolicy` que lê configuração (DEC-016); alterar o limite não exige deploy.
- **Padrão estabelecido:** o `Tender` repete o padrão do DFD/TR (`id = documentId`, ETag pela `version`, `importedFrom...` para origem); a mesma `version` é consumida por lotes, matriz e importação, para que o front trabalhe com um só ETag da minuta.
- **Desempenho:** metas p95 de TND-01 < 800 ms, TND-04 < 400 ms, TND-02/TND-03 < 300 ms, escritas na suíte de performance e medidas no endurecimento.
- **Compatibilidade:** nenhum contrato do MVP 1 muda; `DOC-04`, `DOC-05`, `DOC-08` e `DOC-10` são reaproveitados; o seed de templates (US-110) ganha o modelo `EDITAL` e o catálogo `JUDGMENT_CRITERION` é reaproveitado do MVP 1.
- **Migração:** as tabelas `tenders`, `tender_lots`, `tender_lot_items` e `tender_risk_allocations` são criadas pela migração do MVP 2 (cards de banco); esta story não cria migração própria além do que a migração do módulo já traz (a confirmar com o card de migração).

## Backend
- **Módulo(s):** `tender` (dono), `document` (`TypedDocumentModule` do `EDITAL`, numeração, versões), `process` (custódia, etapa, status, itens), `catalog` (modalidade, critério, tipo de contratação), `access`, `timeline`, `audit`, `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `CreateTenderCommand` (TND-01), `GetProcessTenderQuery` (TND-02), `GetTenderQuery` (TND-03), `UpdateTenderHeaderCommand` (TND-04).
- **Domínio:** `Tender.create`/`updateHeader`, `TenderHeaderPolicy` (obrigatoriedades condicionais, faixas, sigilo), `RiskMatrixRequirementPolicy` (RN-TND-30), `TenderHabilitation` (value object, `tenderHabilitationSchema`), `TenderTypedDocumentModule` (registrado para `SystemDocumentModule.TENDER`; a completude é da US-168).
- **Integrações internas:** `DocumentFacade.createFromTemplate` (numeração `ED`, seções), `ProcessFacade.getStageAndCustody`/`getForTender`, `CatalogFacade`, `TermReadFacade.getSelectionCriterion` (sugestão), `AuthorizationService.assertCan('TENDER_CREATE' | 'TENDER_UPDATE', { processId })`, `OutboxWriter`, `AuditService`, `TimelineProjector`.
- **Transação:** TND-01 (documento, `Tender`, auditoria, outbox, timeline) e TND-04 (cabeçalho, `version + 1`, auditoria, outbox) em transação única interativa com `app.tenant_id`; falha em qualquer passo desfaz tudo.

## Frontend
- **Tela(s):** SCR-006 (aba "Edital" no detalhe do processo, `/processos/[id]`) e SCR-021 (`/processos/[id]/edital/[tenderId]`), com a moldura de abas (Cabeçalho, Itens e lotes, Matriz de riscos, Minuta do contrato, Conclusão) preenchida pelas stories seguintes.
- **Componentes:** `TenderTab` (estado vazio e cartão da minuta), `CreateTenderDialog`, `TenderHeaderForm` (blocos Contratação, Condições e Habilitação; `zodResolver(tenderHeaderSchema)`), `HabilitationRequirementsEditor`, `RiskMatrixRequiredNotice`, `TenderStatusPanel` (situação do documento, TR, lotes, matriz, contrato), `ModalityMismatchNotice`, `ConfidentialBudgetHint`.
- **Estados:** loading (skeleton do cabeçalho); vazio ("Este processo ainda não tem minuta de edital"); erro com "Tentar novamente"; somente leitura quando o documento não está `DRAFT`/`RETURNED` ou o usuário não edita (campos como texto, com o motivo em `editBlockedReason`); sucesso com toast e foco no primeiro campo.
- **Acessibilidade e responsividade:** campos condicionais anunciados por `aria-live` ao aparecer; mensagens de erro associadas aos campos; foco preso e devolvido nos diálogos; modo de disputa e regime com `radiogroup` rotulado; situação nunca só por cor; abaixo de 768 px o formulário vira acordeão por bloco e o painel de situação passa para o topo; contraste AA.

## Banco de dados
- **Tabelas:** `tenders` (criação e `UPDATE` do cabeçalho), `documents`/`document_versions`/`document_sections` (criação pelo ciclo de vida do MVP 1), `audit_logs`, `outbox_events`, `process_timeline_entries`; leitura de `processes`, `catalog_items`, `terms_of_reference`, `process_items`, `process_stages`.
- **Migrações:** nenhuma nova nesta story (tabelas do módulo `tender` na migração do MVP 2); seed do template `EDITAL` (US-110) e dos catálogos já existentes.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, process_id)` e `UNIQUE (tenant_id, document_id)`; checks `id = document_id`, `is_electronic OR in_person_justification IS NOT NULL`, `guarantee_percent IS NULL OR guarantee_percent BETWEEN 0 AND 30`, `site_visit IS NULL OR site_visit IN ('NONE','OPTIONAL','MANDATORY')`; RLS por `tenant_id` como nas demais tabelas; índice `(tenant_id, process_id)` para TND-02.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `TND-01` | POST | `/api/v1/processes/{id}/tender` | `{ title?, modalityId?, judgmentCriterionId, disputeMode?, executionRegime?, awardType?, isPriceRegistration?, smallBusinessBenefit?, isElectronic?, inPersonJustification?, estimatedValueDisclosed?, proposalValidityDays?, executionTermDays?, contractTermMonths?, guaranteePercent?, siteVisit?, habilitationRequirements? }` + `Idempotency-Key` | `201 { data: Tender, meta: { document, riskMatrixReasons[] } }` + `ETag` + `Location` | 201, 401, 403, 404, 409, 422, 429, 503 |
| `TND-02` | GET | `/api/v1/processes/{id}/tender` | — | `200 { data: Tender \| null, meta: { canCreate, createBlockedReason?, stageKey, templatePublished } }` | 200, 401, 403, 404 |
| `TND-03` | GET | `/api/v1/tenders/{id}` | — | `200 { data: Tender, meta: { document, editable, editBlockedReason?, riskMatrixReasons[], lots: { count, itemsUnassigned }, riskMatrix: { required, count, complete }, termChangedSinceImport } }` + `ETag` | 200, 401, 403, 404 |
| `TND-04` | PATCH | `/api/v1/tenders/{id}` | subconjunto dos campos de TND-01 (exceto `title`) + `If-Match` | `200 { data: Tender, meta: { changedFields[] } }` + `ETag` | 200, 401, 403, 404, 409, 412, 422, 428, 429, 503 |
| `DOC-05` | PUT | `/api/v1/documents/{id}/sections/{sectionKey}` | MVP 1 | seção do `EDITAL` salva (POL-02 com `TENDER_UPDATE`) | 200, 403, 404, 409, 412 |

## Logs
- `info` `tender.created` — `tenderId`, `documentId`, `modalityCode`, `riskMatrixRequired`, `durationMs`, `correlationId`.
- `info` `tender.header_updated` — `tenderId`, `changedFields`, `durationMs`.
- `warn` `tender.create_denied` e `tender.update_denied` — `reasonCode`, `processId`; `warn` `idempotency.store_unavailable`.
- `error` `tender.create_failed` e `tender.update_failed` — `errorCode`, causa resumida, `correlationId`.
- Nunca logar: justificativas (forma presencial, dispensa de habilitação), requisitos técnicos, texto de seções, valores do orçamento, título do documento.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `tender.create` | `DATA_CHANGE` | Commit de TND-01 | `metadata`: `tenderId`, `documentId`, `modalityCode`, `judgmentCriterionCode`, `riskMatrixRequired`, `templateVersionId`, `idempotencyKey` |
| `document.create` | `DATA_CHANGE` | Mesmo commit | `metadata`: `documentId`, `documentTypeCode` `EDITAL`, `tenderId`, `templateVersionId` |
| `tender.lots_update` | `DATA_CHANGE` | Commit de TND-01 com lotes semeados | `metadata`: `tenderId`, `source` `SEED`, `lotsCount`, `itemsAssigned`, `itemsUnassigned` |
| `tender.update` | `DATA_CHANGE` | Commit de TND-04 com alteração | `changes`: campo de `de` para `para` para valores não textuais; campos textuais só com `length` e `hash`; `metadata`: `tenderId`, `riskMatrixRequiredChanged` |
| `access.denied` | `ACCESS` | 403 em TND-01 ou TND-04 | `reasonCode`, `processId` ou `tenderId` |

## Testes necessários
- **Unitários:** `TenderHeaderPolicy` (obrigatoriedade por modalidade e tipo de contratação, justificativa da forma presencial, faixas, garantia em obra, divulgação do valor); `RiskMatrixRequirementPolicy` (regime, grande vulto, limite configurado, sem valor); `tenderHabilitationSchema`; herança dos defaults do processo; PATCH sem diferença; validação sobre o estado resultante.
- **Integração (Testcontainers):** criação atômica (documento, `Tender`, evento, timeline, auditoria) e numeração `ED`; unicidade por processo sob corrida; rollback total em falha induzida; `If-Match` e `version`; RLS entre tenants; participante editando e não criando; processo sigiloso sem vazamento em evento, log e auditoria.
- **API/contrato:** TND-01 a TND-04 (códigos, `ETag`, `Location`, `Idempotent-Replayed`); `data: null` de TND-02; DOC-05 inalterado no contrato.
- **RBAC e multi-tenant:** suíte "tenant leak" com TND-01 a TND-04; matriz de autorização (gerada) com `TENDER_CREATE`, `TENDER_UPDATE`, `PROCESS_VIEW`; bateria de POL-01 e POL-02 (custódia, participação, `DRAFT`/`RETURNED`, etapa, status do processo).
- **Concorrência:** criações simultâneas; PATCH simultâneos; PATCH contra importação ou edição de lotes (mesma `version`).
- **E2E (Playwright):** abrir a aba "Edital", criar a minuta, ver as obrigatoriedades condicionais, editar o cabeçalho, ver o conflito de edição e a leitura por Compras.
- **Acessibilidade/performance:** axe em aba, diálogo e formulário; 360 px; metas de p95 na suíte de performance (sem benchmark no card).

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
- [ ] Criação do `Tender` e do documento `EDITAL` comprovadamente atômica (teste de falha induzida)
- [ ] `riskMatrixRequired` calculado só no servidor e sem valor sigiloso na resposta
- [ ] Texto de justificativas e valores do orçamento comprovadamente ausentes de eventos, logs e auditoria
- [ ] Gherkin das 8 categorias automatizado, incluindo etapa fora de `MINUTA_EDITAL` e `If-Match`

## Estimativa
**M** — uma criação atômica de duas entidades com numeração, quatro operações de API, um conjunto de regras condicionais e a moldura da SCR-021; reaproveita o ciclo de vida e o editor do MVP 1, e o esforço está nas validações do cabeçalho e no cálculo semeado da exigência da matriz.

## Prioridade
**P0** — sem a minuta e seu cabeçalho tipado não há o que importar, organizar em lotes, concluir nem enviar ao Jurídico; é a base de todas as demais stories do épico EP-027.

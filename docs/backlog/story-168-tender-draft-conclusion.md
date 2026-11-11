---
id: US-168
title: "Concluir a minuta do edital"
epic: EP-027
feature: FT-078
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-129, US-164, US-165, US-167]
modules: [tender, document, term, process, workflow, risk, catalog, access, timeline, audit, platform]
screens: [SCR-021, SCR-006]
endpoints: [TND-13, TND-14, DOC-08, DOC-21, DOC-22]
permissions: [TENDER_SUBMIT, PROCESS_VIEW]
events: [DocumentFinalized, DocumentVersionCreated]
---

# US-168 — Concluir a minuta do edital

## Título
Concluir a minuta do edital

## Descrição
**Como** pessoa de Licitações responsável pela minuta do edital, **quero** ver todas as pendências que impedem a conclusão e os avisos que preciso reconhecer, e depois concluir a minuta do edital e a minuta do contrato de uma só vez, **para** entregar ao Jurídico e à autoridade versões congeladas, completas e coerentes com o TR, com a regra de saída da etapa `MINUTA_EDITAL` satisfeita.

Concluir é o ato final do módulo `tender` no MVP 2: a análise de pendências (TND-13) e a conclusão (TND-14) usam o mesmo serviço, validam a completude (`TypedDocumentModule.validateCompleteness`), finalizam os documentos `EDITAL` e `MINUTA_CONTRATO` na mesma transação (DEC-018), congelam as versões, geram os PDFs pelo Gotenberg após o commit e publicam o evento `DocumentFinalized` do edital, conhecido no domínio como `TenderDraftCompleted`. A story publica também o provedor `tender.*` do `RuleContext` v2 (contrato fixado na US-129) e as regras de saída da etapa. **Concluir não aprova nada, não numera nem publica o edital e não move o processo**: a aprovação é a etapa `AUTORIZACAO_LICITACAO` (DEC-196) e a publicação é do MVP 3.

## Contexto
- O edital (art. 25 da Lei 14.133/2021) é o produto final da fase preparatória. A feature FT-078 e a DEC-201 fixam que a conclusão valida critério de julgamento, modalidade, cobertura de lotes e matriz de riscos (RN-TND-09) e deixa os dois documentos prontos para o Jurídico. A DEC-196 posiciona `MINUTA_EDITAL` entre `DOTACAO` e `JURIDICO`, com saída que exige `Tender` e `EDITAL` completos (`BLOCKING`) e minuta do contrato existente (`WARNING`).
- O ciclo de vida do documento é o da DEC-018: `EDITAL` e `MINUTA_CONTRATO` têm `requiresApproval = false`; finalizar valida completude, cria versão e bloqueia a edição; a aprovação vem depois, pela etapa de aprovação que cobre os documentos (`FINALIZED` → `APPROVED`). As regras legais, como as seções obrigatórias por modalidade, são **configuração semeada, não código** (DEC-016).
- A completude do `EDITAL` é um módulo tipado (`TenderValidator`, códigos `TENDER_*`, api.md §2.1.2) que reutiliza as violações genéricas do `document` (`SECTION_REQUIRED`, `SECTION_AI_REVIEW_PENDING`, `SECTION_PLACEHOLDER_PENDING`, RN-AI-57). A `MINUTA_CONTRATO` é `FREE_TEXT`: a completude é a genérica do `document`, coordenada pela conclusão do `tender`.
- As stories anteriores entregam os dados que esta valida: cabeçalho tipado (US-163), importação do TR e versão de origem (US-164), lotes (US-165), matriz de alocação de riscos (US-166, definição de "completa") e minuta do contrato (US-167). A IA do edital (US-169) só escreve texto de seção e a revisão humana por seção é condição da conclusão (RN-TND-16).
- O Jurídico (EP-025) analisa as **versões exatas** concluídas aqui (`LegalReviewDocument`); a autoridade as aprova em `AUTORIZACAO_LICITACAO`. O KPI de tempo de elaboração (EP-027, ≤ 4 dias úteis) mede `Document.createdAt` × `finalizedAt` do `EDITAL`.
- Nos processos da v2 do workflow padrão, `COMPLETED` significa **fase preparatória concluída** (DEC-196, rótulo da etapa `END`, `CONCLUSAO`); a v2, as regras e a continuação dos processos concluídos na v1 são das US-130 e US-131.

## Objetivo
Garantir que 100% das minutas concluídas passem pela mesma análise exibida ao usuário (sem divergência entre tela e validação), com avisos reconhecidos e registrados, dois documentos finalizados e versionados na mesma transação, PDFs gerados e a regra de saída de `MINUTA_EDITAL` satisfeita em até 1 s após o commit; reduzir devoluções do Jurídico por divergência entre edital e TR em 40% (KPI do épico).

## Persona
- **Principal:** Licitações (perfil `LICITACOES`, `TENDER_SUBMIT`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, `TENDER_SUBMIT`); Planejamento e Compras (conferem a análise e a fidelidade ao TR); Consultoria externa (`CONSULTOR_EXTERNO`, edita e resolve pendências com `TENDER_UPDATE`, não conclui); Jurídico, Controle Interno e autoridade (leem as versões concluídas); Auditor (`AUDITOR`, trilha de avisos reconhecidos).

## Pré-condições
- Processo `IN_PROGRESS` com etapa ativa que permita os tipos `EDITAL` e `MINUTA_CONTRATO` (na v2 padrão, `MINUTA_EDITAL`).
- `Tender` com documento `EDITAL` em `DRAFT` ou `RETURNED`; a `MINUTA_CONTRATO`, quando existe, em `DRAFT`, `RETURNED` ou já `FINALIZED`/`APPROVED`.
- Usuário com vínculo ativo, `TENDER_SUBMIT` cobrindo o processo e custódia (POL-01) ou participação conforme a POL-02. A análise (TND-13) pede só `PROCESS_VIEW`.
- MFA válido na sessão apenas se `security.mfaPolicy = ALL` (`TENDER_SUBMIT` é risco `M`).

## Fluxo principal
1. Em SCR-021 (`/processos/[id]/edital/[tenderId]`), o painel **"Análise da minuta"** (`TenderCompletenessPanel`) chama `GET /tenders/{id}/completeness` (TND-13) ao abrir a aba e depois de cada alteração (com espera de 1 s), no mesmo serviço usado na conclusão.
2. A API avalia, na ordem: cabeçalho tipado, critério e modalidade, lotes, matriz de riscos, seções obrigatórias da modalidade, importação do TR, revisão de IA e marcadores `[a confirmar]` dos dois documentos, sigilo do orçamento e a minuta do contrato. Devolve `violations[]` (bloqueantes e avisos), o resumo por tema e o `analysisHash` (ETag).
3. O painel mostra o resumo ("Lotes: 12 de 12 itens cobertos", "TR: importado da versão 2, atual", "Matriz de riscos: completa", "Revisão de IA: 0 seções pendentes", "Minuta do contrato: em elaboração") e a lista de pendências bloqueantes, cada uma com link para o campo, a seção, o lote ou o item.
4. A pessoa resolve as pendências nas abas do edital (cabeçalho, lotes, matriz, seções, minuta do contrato) e reconhece cada aviso aplicável com **"Reconhecer"**.
5. Com zero bloqueios e a permissão `TENDER_SUBMIT`, o botão **"Concluir minuta do edital"** fica habilitado; sem a permissão, aparece o motivo.
6. O diálogo (`ConcludeTenderDialog`) mostra o que será congelado (edital `ED 0004/2026` e contrato `MC 0001/2026`, versão do TR importada, número de lotes e de riscos), os avisos reconhecidos e o texto "A conclusão deixa a minuta pronta para o Jurídico. Ela não aprova o edital nem o publica." A pessoa confirma.
7. O front envia `POST /tenders/{id}/conclude` (TND-14) com `acknowledgedWarnings`, `If-Match` (ETag da análise) e `Idempotency-Key`.
8. A API, em uma transação, trava o `Tender` e os documentos em ordem fixa, reavalia a análise com o mesmo serviço (evita corrida com edições concorrentes), confere o ETag, finaliza a `MINUTA_CONTRATO` (se estiver em `DRAFT`/`RETURNED`) e o `EDITAL`, cria uma `DocumentVersion` `FINALIZATION` para cada um (o snapshot do edital leva o cabeçalho, os lotes, a matriz, a versão do TR importada e a versão congelada do contrato), preenche `finalizedAt`, audita, projeta a timeline e grava no outbox `DocumentFinalized` (edital, `TenderDraftCompleted`) e `DocumentFinalized` (contrato).
9. Depois do commit, a API enfileira a geração dos PDFs (`CONTENT`) das duas versões na fila `document-render` (Gotenberg) e responde 200 com os documentos, as versões e o estado das renditions (`PENDING`).
10. A aba passa ao modo somente leitura: selo "Minuta concluída — pronta para o Jurídico", versões congeladas, links para os PDFs (chips "Gerando PDF…" → "Baixar") e o aviso de que o próximo passo é encaminhar o processo.
11. O provedor `tender.*` passa a devolver `exists = true` e `isComplete = true`; a regra de saída `MINUTA_EDITAL` (RN-TND-136) fica satisfeita e o responsável encaminha o processo ao `JURIDICO` pela tramitação do MVP 1 (US-041/US-047); a conclusão não move o processo.
12. Mais adiante o Jurídico analisa as versões congeladas, o Controle Interno se manifesta e, em `AUTORIZACAO_LICITACAO`, a autoridade aprova os documentos (RN-TND-138); o processo chega a `CONCLUSAO` ("Fase preparatória concluída").

## Fluxos alternativos
- **FA-01 — Pendência bloqueante:** o botão fica desabilitado com o resumo ("3 pendências"); chamar TND-14 sem resolvê-las responde 422 `DOCUMENT_INCOMPLETE` com as `violations[]` e nada é gravado.
- **FA-02 — Aviso não reconhecido:** TND-14 sem cobrir todos os códigos `WARNING` responde 422 `WARNINGS_NOT_ACKNOWLEDGED`; o diálogo expande os avisos pendentes.
- **FA-03 — Cobertura de lotes incompleta:** com `awardType = BY_LOT`, itens sem lote geram `TENDER_LOT_COVERAGE_INCOMPLETE` com a lista dos itens (cenário da feature); o link abre a tela de lotes no item.
- **FA-04 — TR mudou desde a importação:** `TENDER_TERM_IMPORT_OUTDATED` (aviso) com as versões e o atalho "Reimportar do TR" (US-164); a pessoa reimporta ou reconhece o aviso.
- **FA-05 — Sem minuta do contrato:** `TENDER_CONTRACT_DRAFT_MISSING` (aviso); a pessoa cria a minuta (US-167) ou reconhece; a conclusão finaliza só o edital e a regra de saída emite o `WARNING` correspondente (RN-TND-136).
- **FA-06 — Conteúdo de IA pendente:** seção do edital ou do contrato gerada por IA sem revisão, ou com `[a confirmar]`, bloqueia com `SECTION_AI_REVIEW_PENDING` e `SECTION_PLACEHOLDER_PENDING`; o painel lista as seções e abre o editor (RN-TND-127).
- **FA-07 — Valor sigiloso no texto:** com orçamento sigiloso, texto que repete o valor estimado ou um preço de referência bloqueia com `TENDER_CONFIDENTIAL_VALUE_IN_TEXT`, indicando as seções (sem mostrar o valor).
- **FA-08 — Edital devolvido:** quando o Jurídico devolve por diligência ou a autoridade devolve a autorização, o processo volta a `MINUTA_EDITAL` e os documentos ficam editáveis (`RETURNED`, ou `DRAFT` após reabrir por DOC-12); a nova conclusão cria **novas versões** e exige novo reconhecimento de avisos; as versões anteriores permanecem (RN-TND-139).
- **FA-09 — Só um dos documentos pendente de finalização:** se a `MINUTA_CONTRATO` já está `FINALIZED`/`APPROVED` e o edital foi reaberto, a conclusão finaliza apenas o edital e referencia a versão vigente do contrato (RN-TND-131).
- **FA-10 — Finalizar pelo documento:** DOC-10 sobre `EDITAL` ou `MINUTA_CONTRATO` vinculado a um `Tender` responde 409 `TENDER_CONCLUSION_REQUIRED`, com a orientação "Conclua pelo botão Concluir minuta do edital" (RN-TND-132).
- **FA-11 — PDF indisponível:** o Gotenberg falha ou o circuito abre; a conclusão já foi gravada e vale; o chip mostra "PDF pendente" e a ação "Tentar de novo" (DOC-21); a regra de saída não depende do PDF (RN-TND-134).
- **FA-12 — Já concluída:** nova conclusão com o edital já `FINALIZED`/`APPROVED` responde 409 `INVALID_STATE`; o reenvio com a mesma chave devolve a resposta original (RN-TND-131).
- **FA-13 — Provedor `tender.*` indisponível:** a regra de saída é avaliada como não satisfeita (falha fechada, RN-WF2-84); a conclusão em si já foi gravada e a tela orienta a tentar encaminhar de novo.
- **FA-14 — Geração de IA em andamento ou proposta pronta:** a conclusão prossegue; a análise informa `aiProposals` (em andamento, prontas) e o diálogo avisa que a proposta deixa de poder ser aplicada; a geração ativa termina `CANCELED` por política e a proposta pronta vira não aplicável (`AI_GENERATION_NOT_APPLICABLE`, RN-TND-127).

## Regras de negócio
- **RN-TND-09** *(da feature, adotada)* — Concluir exige critério de julgamento e modalidade preenchidos, cobertura de lotes e matriz completa quando exigida (`TypedDocumentModule.validateCompleteness`); a conclusão não aprova nada (DEC-201).
- **RN-TND-05** *(da feature, adotada)* — Um item pertence a um só lote; com `awardType = BY_LOT` os lotes cobrem todos os itens do processo (DEC-201).
- **RN-TND-06** *(da feature, adotada)* — A matriz de riscos é obrigatória quando `riskMatrixRequired` e deve estar completa para concluir (DEC-201).
- **RN-TND-10** *(da feature, adotada)* — A edição segue o ciclo de vida do documento (DEC-018) e a POL-02; depois de finalizado, o documento não é mais editável (DEC-018).
- **RN-TND-16** *(da feature, adotada)* — Revisão humana por seção é obrigatória antes de finalizar o `EDITAL` (US-122, DEC-202).
- **RN-TND-120** — Análise única: TND-13 e TND-14 usam o mesmo `TenderCompletenessAnalyzer`; DOC-08 sobre o `EDITAL` devolve a parte do edital (via `TenderValidator`), de modo que o indicador do editor e a conclusão nunca divergem. A análise é somente leitura, não grava nada e devolve `violations[]` no formato de api.md §2.1.2, com `documentTypeCode` (`EDITAL` ou `MINUTA_CONTRATO`) e `severity` (`BLOCKING` ou `WARNING`). Nenhuma mensagem, `params` ou link carrega valor do orçamento sigiloso.
- **RN-TND-121** — Cabeçalho (bloqueantes): `TENDER_DISPUTE_MODE_REQUIRED` (modalidade pregão ou concorrência sem `disputeMode`, RN-TND-03); `TENDER_EXECUTION_REGIME_REQUIRED` (contratação de serviço ou de obra sem `executionRegime`, mesma derivação da US-163); `TENDER_IN_PERSON_JUSTIFICATION_REQUIRED` (`isElectronic = false` sem `inPersonJustification`); `TENDER_PROPOSAL_VALIDITY_REQUIRED` (`proposalValidityDays` nulo); `TENDER_HABILITATION_INCOMPLETE` (`habilitationRequirements` incoerente: `legal`/`fiscalSocialLabor` desligados sem `waiverJustification` — art. 70, III; `economicFinancial.required` sem índices nem patrimônio líquido mínimo; `technical.required` sem exigência técnica; `params.reasons[]`). Avisos: `TENDER_EXECUTION_TERM_NOT_DEFINED` (`executionTermDays` ou `contractTermMonths` nulo) e `TENDER_GUARANTEE_NOT_DEFINED` (`guaranteePercent` nulo).
- **RN-TND-122** — Critério e modalidade: `TENDER_JUDGMENT_CRITERION_REQUIRED` (critério ausente ou item de catálogo `JUDGMENT_CRITERION` inativo) e `TENDER_MODALITY_INVALID` (modalidade ausente, inativa ou de contratação direta, `MODALITY.metadata.isDirectContracting = true`, que não tem edital). Ambos bloqueantes (RN-TND-09).
- **RN-TND-123** — Lotes e itens: `TENDER_ITEMS_REQUIRED` (processo sem item ativo); com `awardType = BY_LOT`, `TENDER_LOT_COVERAGE_INCOMPLETE` (itens ativos sem lote, `params.itemsWithoutLot[]` com até 50 `processItemId` e `params.total`), `TENDER_LOT_EMPTY` (lote sem itens) e `TENDER_LOT_ITEM_INACTIVE` (lote com item inativado depois); com outro `awardType`, o lote vazio vira aviso `TENDER_LOT_EMPTY`. A regra de lotes é a da US-165; aqui só se reavalia a cobertura.
- **RN-TND-124** — Matriz de riscos: quando `riskMatrixRequired`, ausência de linhas gera `TENDER_RISK_MATRIX_REQUIRED` e matriz fora do critério de completude da US-166 gera `TENDER_RISK_MATRIX_INCOMPLETE` (`params.risksWithoutAllocation[]`, até 50 `riskId`). A análise chama a política da US-166 (`TenderRiskMatrixPolicy.evaluate`) e não duplica a definição de "completa"; quando a matriz não é exigida, nenhum código é emitido, mesmo com linhas registradas.
- **RN-TND-125** — Seções obrigatórias por modalidade (regra semeada, DEC-016): cada `SectionDefinition` do template do `EDITAL` pode trazer `applicableModalities` (códigos de `MODALITY`); a seção só é exigida (`SECTION_REQUIRED`, `SECTION_JUSTIFICATION_REQUIRED`, `SECTION_TOO_SHORT`) para as modalidades listadas, e vale para todas se o atributo for omitido. A biblioteca padrão v2 semeia o atributo (por exemplo, seções do modo de disputa e da fase de lances só para pregão e concorrência), a validar com o jurídico do piloto; o `TenderValidator` apenas lê o dado, sem código por modalidade. O órgão ajusta no template (US-110).
- **RN-TND-126** — Importação do TR: `TENDER_TERM_NOT_IMPORTED` (aviso: `importedFromTermVersionId` nulo e o processo tem TR) e `TENDER_TERM_IMPORT_OUTDATED` (aviso: existe versão `APPROVED`/`FINALIZED` do TR posterior à importada; `params.importedVersionNumber`, `params.currentVersionNumber`). A versão corrente do TR segue a precedência aprovada > finalizada. Ambos exigem reconhecimento; o reconhecimento não reimporta nada. A análise nunca altera o TR.
- **RN-TND-127** — Conteúdo de IA, nos dois documentos: `SECTION_AI_REVIEW_PENDING` (seção com proveniência de IA sem `reviewedAt`) e `SECTION_PLACEHOLDER_PENDING` (seção com `toConfirm`, `params.count`) são bloqueantes (RN-AI-57), inclusive o que chegou por importação do TR ou do contrato (US-122). A conclusão nunca revisa por conta própria. Ela também não depende de geração de IA: geração `QUEUED`/`RUNNING` do `EDITAL` termina `CANCELED` com `CANCELED_BY_POLICY` (o worker revalida `DRAFT`/`RETURNED` antes de chamar o provedor) e proposta `SUCCEEDED` não aplicada deixa de ser aplicável (409 `AI_GENERATION_NOT_APPLICABLE`); a análise mostra a contagem em `aiProposals` (US-169).
- **RN-TND-128** — Sigilo no texto: com `estimatedValueDisclosed = false` ou orçamento sigiloso, qualquer seção do `EDITAL` ou da `MINUTA_CONTRATO` que contenha, por comparação normalizada, o valor total estimado ou um valor unitário ou total de item do processo gera `TENDER_CONFIDENTIAL_VALUE_IN_TEXT` (`sectionKey`, sem o valor). A verificação usa a lista de valores sigilosos do processo (não detecta qualquer número em moeda) e roda no servidor, mesmo para quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`.
- **RN-TND-129** — Minuta do contrato: `TENDER_CONTRACT_DRAFT_MISSING` (aviso, sem minuta ativa); com minuta, as violações genéricas dela entram com `documentTypeCode = MINUTA_CONTRATO` (seções obrigatórias, IA, `[a confirmar]`), bloqueantes; `TENDER_CONTRACT_TERM_IMPORT_OUTDATED` (aviso: versão do TR posterior a `contractDraftImportedFromTermVersionId`, US-167).
- **RN-TND-130** — Reconhecimento de avisos: `acknowledgedWarnings` deve cobrir todos os códigos `WARNING` do momento da conclusão (senão 422 `WARNINGS_NOT_ACKNOWLEDGED`); código que não está entre os avisos atuais é recusado (`VALIDATION_ERROR`). Os códigos reconhecidos e seus `params` ficam na auditoria e no resumo do evento (evidência para o Controle Interno, DEC-016).
- **RN-TND-131** — Conclusão atômica e idempotente: em uma transação, trava o `Tender` e os documentos em ordem fixa (`EDITAL`, depois `MINUTA_CONTRATO`), reavalia a análise, confere o ETag (`If-Match` = `analysisHash` de TND-13; divergência = 412 `VERSION_CONFLICT`), finaliza a `MINUTA_CONTRATO` e depois o `EDITAL` (cada um só se estiver em `DRAFT`/`RETURNED`; os já `FINALIZED`/`APPROVED` seguem com a versão vigente), cria uma `DocumentVersion` `FINALIZATION` para cada documento finalizado, preenche `finalizedAt`, e grava auditoria, timeline e outbox. `Idempotency-Key` obrigatória: reenvio devolve a resposta original com `Idempotent-Replayed: true`; duas conclusões simultâneas resultam em uma 200 e uma 409 `INVALID_STATE`; edital já finalizado responde 409 `INVALID_STATE`. Nenhuma chamada de rede ocorre dentro da transação.
- **RN-TND-132** — Único caminho: enquanto o `Tender` está vinculado, `EDITAL` e `MINUTA_CONTRATO` só são finalizados por TND-14; DOC-10 e DOC-09 sobre eles respondem 409 `TENDER_CONCLUSION_REQUIRED`. Reabrir (DOC-12, `DOCUMENT_REOPEN` + POL-11), cancelar e devolver por aprovação seguem as rotas genéricas.
- **RN-TND-133** — Versões congeladas: o snapshot do `EDITAL` (`buildHeaderSnapshot`, `buildCollectionsSnapshot`) guarda o cabeçalho tipado, `importedFromTermVersionId`, os lotes com seus itens, as alocações de risco e o `contractDraftVersionId` (versão finalizada do contrato vigente no momento); o do contrato guarda as seções. `contentHash` é SHA-256 do JSON canonicalizado (RFC 8785, DEC-017). Depois da conclusão, cabeçalho, lotes, matriz e seções não são editáveis (409 `DOCUMENT_NOT_EDITABLE` nas rotas de TND-03 a TND-10 e de seção); o snapshot **não contém valor estimado nem de item**.
- **RN-TND-134** — PDF: depois do commit, enfileira-se uma rendition `CONTENT` por versão finalizada (fila `document-render`, Gotenberg, como a US-067: tentativas com backoff e *circuit breaker*). Falha ou demora do Gotenberg não desfaz a conclusão; as renditions ficam `PENDING`, `PROCESSING`, `READY` ou `FAILED` e podem ser pedidas de novo por DOC-21. O PDF segue o sigilo (POL-09): o edital não leva o valor estimado quando `estimatedValueDisclosed = false`, garantido por RN-TND-128.
- **RN-TND-135** — Evento e linha do tempo: `DocumentFinalized` do `EDITAL` (`document.finalized.edital`, nome do produto `TenderDraftCompleted`) e `DocumentFinalized` da `MINUTA_CONTRATO` (`document.finalized.minuta_contrato`), com `typedSummary` do edital: `tenderId`, `modalityCode`, `judgmentCriterionCode`, `awardType`, `lotsCount`, `riskMatrixRequired`, `riskAllocationsCount`, `termVersionNumber`, `contractDraftVersionId?`, `warningsAcknowledgedCount`, `estimatedValueDisclosed`; nunca valores. A timeline recebe `DOCUMENT_FINALIZED` para cada documento; não há notificação própria (events.md §8).
- **RN-TND-136** — Provedor `tender.*` e regras de saída (US-129, RN-WF2-83/84): o módulo `tender` registra o `TenderRuleContextContributor`, dono do namespace, com `exists` (há `Tender` do processo), `isComplete` (o `EDITAL` está `FINALIZED` ou `APPROVED`, ou seja, a conclusão ocorreu e não foi desfeita por reabertura, devolução ou cancelamento), `judgmentCriterionCode`, `disputeMode`, `lotsCount`, `riskMatrixRequired` e `riskMatrixComplete` (verdadeiro quando a matriz não é exigida), lendo só a fachada `TenderFacade` em uma consulta agregada, com tempo de 2 s por namespace e falha fechada. As regras de saída semeadas da etapa `MINUTA_EDITAL` (registradas para o portão de prontidão da US-130, RN-WF2-100): `BLOCKING` "Conclua a minuta do edital antes de encaminhar o processo" com `tender.exists = true E tender.isComplete = true`; `WARNING` "O processo não tem minuta do contrato; o Jurídico analisa edital e contrato juntos. Confirme que ela não é necessária" com `documents.MINUTA_CONTRATO.exists = true`. Os avisos reconhecidos seguem a DEC-016.
- **RN-TND-137** — Escopo: concluir não aprova, não numera, não publica e não move o processo. Número do edital, publicação, divulgação no PNCP e Diário Oficial, status `PUBLISHED`, impugnações e sessão pública são do MVP 3 em diante e não existem nesta story; o `Tender` não ganha status. O encaminhamento segue a tramitação do MVP 1 (US-041/US-047) e o SLA da etapa (EP-021); concluir com o processo `SUSPENDED` ou `CANCELED` é recusado (`INVALID_PROCESS_STATUS`).
- **RN-TND-138** — Conclusão da fase preparatória (etapa `CONCLUSAO`): para o edital isto exige, **antes** de o processo chegar a `CONCLUSAO`, que (a) a saída de `MINUTA_EDITAL` tenha sido satisfeita (edital concluído); (b) a análise jurídica e a manifestação do Controle Interno tenham sido concluídas sobre as versões congeladas (US-155 e US-161, com avisos `WARNING` de versão desatualizada, `legalReview.outdatedDocuments`); e (c) a autoridade tenha aprovado, em `AUTORIZACAO_LICITACAO`, `EDITAL` e `MINUTA_CONTRATO` nas versões concluídas (`FINALIZED` → `APPROVED`, DEC-018, POL-23). A etapa `END` não tem regra própria. Ao chegar a `CONCLUSAO`, `COMPLETED` significa **fase preparatória concluída** (rótulo do nome da etapa `END`); o processo `COMPLETED` é terminal (RN-PROC-117), de modo que `Tender`, `EDITAL` e `MINUTA_CONTRATO` ficam somente leitura, prontos para a divulgação do MVP 3, **sem** número, publicação ou `PUBLISHED`. A semente da v2, as regras e a continuação dos processos concluídos na v1 (que entram em `DOTACAO` e só então criam o `Tender`) são das US-130 e US-131. Se a autoridade devolver a aprovação, os dois documentos voltam a `RETURNED`, o processo volta a `MINUTA_EDITAL` e vale a RN-TND-139.
- **RN-TND-139** — Nova conclusão: depois de devolução (`RETURNED`) ou reabertura (`DRAFT`), a próxima conclusão cria versões novas (`vN+1`), exige nova análise e novo reconhecimento de avisos e preserva as versões anteriores, que continuam consultáveis, comparáveis (DOC-18) e referenciadas por análises e aprovações já feitas (`LegalReviewDocument`, `ApprovalDocument`).
## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Pendências bloqueantes | `violations[]` (`severity = BLOCKING`) | lista (somente leitura) | — | RN-TND-121 a RN-TND-129 | TND-13 |
| Avisos | `violations[]` (`severity = WARNING`) | lista (somente leitura) | — | RN-TND-121, RN-TND-123, RN-TND-126, RN-TND-129 | TND-13 |
| Avisos reconhecidos | `acknowledgedWarnings` | lista de códigos | Condicional (havendo avisos) | cada código deve estar entre os avisos atuais (RN-TND-130) | `[]` |
| Situação da importação do TR | `term` (`importedVersionNumber`, `currentVersionNumber`, `outdated`) | objeto (somente leitura) | — | RN-TND-126 | TND-13 |
| Cobertura de lotes | `lots` (`count`, `itemsTotal`, `itemsAssigned`, `itemsUnassigned`) | objeto (somente leitura) | — | RN-TND-123 | TND-13 |
| Matriz de riscos | `riskMatrix` (`required`, `complete`, `allocationsCount`) | objeto (somente leitura) | — | RN-TND-124 | TND-13 |
| Minuta do contrato | `contractDraft` (`exists`, `documentId?`, `status?`, `termImportOutdated?`) | objeto (somente leitura) | — | RN-TND-129 | TND-13 |
| Revisão de IA | `aiReview` (`pendingSections[]`, `placeholdersPending`) | objeto (somente leitura) | — | RN-TND-127 | TND-13 |
| Propostas de IA | `aiProposals` (`active`, `ready`) | objeto (somente leitura) | — | RN-TND-127 | TND-13 |
| *(sistema)* Hash da análise | `analysisHash` / `ETag` | texto | Sim (`If-Match` em TND-14) | hash estável dos insumos avaliados (cabeçalho, lotes, matriz, revisões dos dois documentos, versões do TR) | TND-13 |
| *(sistema)* Chave de idempotência | `Idempotency-Key` | texto | Sim (TND-14) | 24 h | gerada pelo front |
| *(saída)* Versões congeladas | `editalVersion`, `contractDraftVersion?` (`id`, `versionNumber`, `contentHash`) | objetos | — | RN-TND-133 | TND-14 |
| *(saída)* PDFs | `renditions[]` (`documentVersionId`, `id`, `status`) | lista | — | `PENDING`, `PROCESSING`, `READY`, `FAILED` | TND-14, DOC-22 |

**Catálogo de códigos da análise (`TENDER_*`, api.md §2.1.2):**
| Código | Severidade | Campo ou seção | Regra |
|---|---|---|---|
| `TENDER_MODALITY_INVALID` | bloqueante | `modalityId` | RN-TND-122 |
| `TENDER_JUDGMENT_CRITERION_REQUIRED` | bloqueante | `judgmentCriterionId` | RN-TND-122 |
| `TENDER_DISPUTE_MODE_REQUIRED` | bloqueante | `disputeMode` | RN-TND-121 |
| `TENDER_EXECUTION_REGIME_REQUIRED` | bloqueante | `executionRegime` | RN-TND-121 |
| `TENDER_IN_PERSON_JUSTIFICATION_REQUIRED` | bloqueante | `inPersonJustification` | RN-TND-121 |
| `TENDER_PROPOSAL_VALIDITY_REQUIRED` | bloqueante | `proposalValidityDays` | RN-TND-121 |
| `TENDER_HABILITATION_INCOMPLETE` | bloqueante | `habilitationRequirements` | RN-TND-121 |
| `TENDER_ITEMS_REQUIRED` | bloqueante | itens do processo | RN-TND-123 |
| `TENDER_LOT_COVERAGE_INCOMPLETE` | bloqueante | lotes | RN-TND-123 |
| `TENDER_LOT_EMPTY` | bloqueante com `BY_LOT`, senão aviso | lote | RN-TND-123 |
| `TENDER_LOT_ITEM_INACTIVE` | bloqueante | lote e item | RN-TND-123 |
| `TENDER_RISK_MATRIX_REQUIRED` | bloqueante | matriz de riscos | RN-TND-124 |
| `TENDER_RISK_MATRIX_INCOMPLETE` | bloqueante | matriz de riscos | RN-TND-124 |
| `SECTION_REQUIRED`, `SECTION_JUSTIFICATION_REQUIRED`, `SECTION_TOO_SHORT` | bloqueante | seção aplicável à modalidade | RN-TND-125 |
| `SECTION_AI_REVIEW_PENDING`, `SECTION_PLACEHOLDER_PENDING` | bloqueante | seção | RN-TND-127 |
| `TENDER_CONFIDENTIAL_VALUE_IN_TEXT` | bloqueante | seção | RN-TND-128 |
| `TENDER_TERM_NOT_IMPORTED` | aviso | importação do TR | RN-TND-126 |
| `TENDER_TERM_IMPORT_OUTDATED` | aviso | importação do TR | RN-TND-126 |
| `TENDER_CONTRACT_DRAFT_MISSING` | aviso | minuta do contrato | RN-TND-129 |
| `TENDER_CONTRACT_TERM_IMPORT_OUTDATED` | aviso | minuta do contrato | RN-TND-129 |
| `TENDER_EXECUTION_TERM_NOT_DEFINED` | aviso | `executionTermDays`, `contractTermMonths` | RN-TND-121 |
| `TENDER_GUARANTEE_NOT_DEFINED` | aviso | `guaranteePercent` | RN-TND-121 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Existe pendência bloqueante em qualquer dos dois documentos | Front + API | "Resolva as pendências antes de concluir a minuta." | `DOCUMENT_INCOMPLETE` |
| V-02 | Existe aviso não reconhecido | Front + API | "Reconheça os avisos antes de concluir." | `WARNINGS_NOT_ACKNOWLEDGED` |
| V-03 | Código reconhecido que não é aviso atual | API | "Atualize a análise e reconheça apenas os avisos exibidos." | `VALIDATION_ERROR` |
| V-04 | Edital fora de `DRAFT`/`RETURNED` (já concluído, em aprovação, cancelado) | API | "Esta minuta não pode ser concluída no estado atual." | `INVALID_STATE` |
| V-05 | Processo fora de `IN_PROGRESS` | API | "O processo não está disponível para conclusão no momento." | `INVALID_PROCESS_STATUS` |
| V-06 | Tipo não permitido na etapa atual | API | "A minuta não pode ser concluída nesta etapa." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-07 | Sem `TENDER_SUBMIT` ou sem custódia | API | "Você não tem permissão para concluir esta minuta." | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` |
| V-08 | `If-Match` ausente | API | "Atualize a análise e tente novamente." | `PRECONDITION_REQUIRED` |
| V-09 | `If-Match` divergente (a minuta mudou depois da análise) | API | "A minuta foi alterada depois da análise. Recarregue e confira de novo." | `VERSION_CONFLICT` |
| V-10 | Finalizar `EDITAL` ou `MINUTA_CONTRATO` vinculado por DOC-10 ou DOC-09 | API | "Conclua pelo botão Concluir minuta do edital." | `TENDER_CONCLUSION_REQUIRED` |
| V-11 | `Idempotency-Key` ausente ou reutilizada com corpo diferente | API | "Esta chave já foi usada em outra solicitação." | `IDEMPOTENCY_KEY_REUSED` |
| V-12 | `Tender` inexistente ou de outro tenant | API | "Edital não encontrado." | `NOT_FOUND` |

## Permissões
- **Permissão:** `TENDER_SUBMIT` (risco `M`) com escopo que cubra o processo para concluir (TND-14); `PROCESS_VIEW` para a análise (TND-13) e a leitura. Perfis padrão: `LICITACOES` e `GESTOR_CONTRATACOES`; `CONSULTOR_EXTERNO` não conclui.
- **Políticas:** POL-01 (custódia) e POL-02 (`EDITAL` e `MINUTA_CONTRATO` ← `TENDER_UPDATE` para editar; estado `DRAFT`/`RETURNED`, tipo permitido na etapa, processo editável), POL-09 e DEC-030 (sigilo), POL-11 (reabertura), POL-23 (a aprovação do edital é da autorização, não desta story).
- **MFA:** não exigido, salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão "Concluir minuta do edital" fica oculto sem `TENDER_SUBMIT` e desabilitado com o motivo quando há bloqueios, o edital já foi concluído ou a etapa não permite; a API responde 403 `PERMISSION_DENIED`/`NOT_PROCESS_CUSTODIAN` e grava `access.denied`; edital de outro tenant responde 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentFinalized` (nome do produto `TenderDraftCompleted`) | `document.finalized.edital` | Commit de TND-14 | `documentId`, `documentVersionId`, `typedSummary` do edital (RN-TND-135); projeta `DOCUMENT_FINALIZED` na timeline; consumidores: auditoria e avaliação da regra de saída |
| `DocumentFinalized` | `document.finalized.minuta_contrato` | Mesmo commit, se a minuta do contrato foi finalizada agora | `documentId`, `documentVersionId`; projeta `DOCUMENT_FINALIZED` |
| `DocumentVersionCreated` | `document.version_created.edital` e `document.version_created.minuta_contrato` | Mesmo commit | `reason = FINALIZATION` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma ao concluir (events.md §8: edital concluído só projeta a timeline). O responsável da etapa seguinte é notificado quando o processo é encaminhado, pelo `PROCESS_RECEIVED` do MVP 1; a diligência, o parecer e a aprovação têm notificações próprias nos épicos EP-025 e EP-021. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Concluir a minuta do edital

  Background:
    Given que o tenant "Prefeitura A" está ativo com o workflow padrão v2
    And o processo "0012/2026" está "IN_PROGRESS" na etapa "MINUTA_EDITAL" com orçamento não sigiloso
    And o "Tender" tem modalidade "PREGAO", critério "Menor preço", modo de disputa "OPEN", adjudicação "BY_LOT", validade da proposta de 60 dias e habilitação coerente
    And o processo tem 12 itens ativos distribuídos em 2 lotes, e a matriz de alocação de riscos é exigida e está completa
    And o TR "TR 0003/2026" está "FINALIZED" na versão 2 e foi importado para o edital na versão 2
    And o edital "ED 0004/2026" está "DRAFT" com todas as seções obrigatórias preenchidas e revisadas
    And a minuta do contrato "MC 0001/2026" está "DRAFT" e completa
    And "Lia Santos" tem vínculo ativo no perfil "LICITACOES", com "TENDER_SUBMIT" e "TENDER_UPDATE" no processo, e custódia dele

  Scenario: [Sucesso] Concluir a minuta do edital e a minuta do contrato
    When "Lia Santos" consultar a análise da minuta
    Then a análise deve trazer 0 violações bloqueantes, "canConclude" igual a "true" e um "analysisHash"
    When "Lia Santos" concluir a minuta com o "If-Match" da análise e a chave "K1"
    Then a API deve responder 200 e os documentos "ED 0004/2026" e "MC 0001/2026" devem ficar "FINALIZED"
    And devem existir duas "DocumentVersion" com "reason" igual a "FINALIZATION" e "contentHash" calculado
    And o snapshot do edital deve conter o cabeçalho, os 2 lotes com os 12 itens, a matriz, a versão 2 do TR e a versão do contrato, sem nenhum valor estimado
    And "finalizedAt" deve estar preenchido nos dois documentos
    And deve gerar a auditoria "document.finalize" para cada documento
    And deve gerar o evento "DocumentFinalized" do edital (nome "TenderDraftCompleted") com "typedSummary" sem valores e o evento "DocumentFinalized" do contrato
    And a timeline deve registrar "DOCUMENT_FINALIZED" duas vezes
    And duas renditions "CONTENT" devem ser enfileiradas no Gotenberg com estado "PENDING"
    And o processo não deve ter sido movido de etapa e nenhuma notificação deve ser gerada

  Scenario: [Sucesso] A regra de saída da etapa fica satisfeita e o processo pode ser encaminhado
    Given que "Lia Santos" concluiu a minuta
    When o responsável avaliar a regra de saída da etapa "MINUTA_EDITAL"
    Then "tender.exists" e "tender.isComplete" devem ser verdadeiros e "tender.lotsCount" deve ser 2
    And a regra "BLOCKING" de edital completo deve estar satisfeita e a regra "WARNING" de minuta do contrato não deve disparar
    And o processo deve poder ser encaminhado à etapa "JURIDICO" pela tramitação do MVP 1

  Scenario: [Sucesso] Concluir reconhecendo os avisos de TR desatualizado e de ausência do contrato
    Given que o TR ganhou a versão 3 depois da importação e a minuta do contrato não existe
    When "Lia Santos" consultar a análise
    Then a análise deve trazer os avisos "TENDER_TERM_IMPORT_OUTDATED" com versões 2 e 3 e "TENDER_CONTRACT_DRAFT_MISSING" e "canConclude" igual a "true"
    When "Lia Santos" concluir reconhecendo os dois avisos
    Then somente o edital deve ficar "FINALIZED" e a auditoria deve registrar os dois códigos reconhecidos
    And a regra de saída "WARNING" de minuta do contrato deve exibir o aviso a ser reconhecido no encaminhamento

  Scenario: [Sucesso] Nova conclusão depois de devolução gera novas versões
    Given que a minuta foi concluída e o processo foi devolvido à etapa "MINUTA_EDITAL", com os documentos em "RETURNED"
    When "Lia Santos" ajustar a seção "PAYMENT" do edital e concluir de novo reconhecendo os avisos
    Then devem existir as versões 2 dos dois documentos e as versões 1 devem permanecer consultáveis
    And "tender.isComplete" deve voltar a ser verdadeiro

  Scenario: [Sucesso] Edital aprovado na autorização fica somente leitura e sem publicação
    Given que o processo passou por "JURIDICO", "CONTROLE_INTERNO" e "AUTORIZACAO_LICITACAO" com a aprovação dos dois documentos
    When o processo chegar à etapa "CONCLUSAO" e ficar "COMPLETED"
    Then o rótulo deve ser "Fase preparatória concluída" e o edital e o contrato devem estar "APPROVED"
    And qualquer edição do "Tender", dos lotes, da matriz e das seções deve ser recusada
    And o "Tender" não deve ter número do edital, publicação nem status "PUBLISHED"

  Scenario: [Sucesso] Metas de desempenho na suíte de performance
    Given um edital com 200 itens, 20 lotes, 30 alocações de risco e as minutas completas
    When a suíte de performance executar 200 análises e 100 conclusões
    Then o p95 de TND-13 deve ser de até 600 ms e o de TND-14, sem contar a geração dos PDFs, de até 1,2 s
    And o provedor "tender.*" deve responder em p95 de até 50 ms por avaliação

  Scenario: [Validação] Item sem lote com adjudicação por lote
    Given que o item 7 do processo não pertence a nenhum lote
    When "Lia Santos" consultar a análise
    Then a análise deve trazer "TENDER_LOT_COVERAGE_INCOMPLETE" com "itemsWithoutLot" contendo o item 7 e "canConclude" igual a "false"
    When "Lia Santos" tentar concluir
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE" e a violação "TENDER_LOT_COVERAGE_INCOMPLETE"
    And os dois documentos devem continuar "DRAFT"

  Scenario: [Validação] Critério, modo de disputa, matriz, seção da modalidade e IA pendente
    Given que o critério de julgamento está inativo no catálogo, o modo de disputa está em branco e a matriz exigida não tem linhas
    And a seção "FASE_DE_LANCES", aplicável a "PREGAO", está vazia e a seção "OBJECT" foi gerada por IA sem revisão
    When "Lia Santos" tentar concluir
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE" e as violações "TENDER_JUDGMENT_CRITERION_REQUIRED", "TENDER_DISPUTE_MODE_REQUIRED", "TENDER_RISK_MATRIX_REQUIRED", "SECTION_REQUIRED" e "SECTION_AI_REVIEW_PENDING"
    Given que a modalidade é "CONCORRENCIA" e a seção "FASE_DE_LANCES" não se aplica a ela por configuração do template
    When "Lia Santos" consultar a análise
    Then a seção "FASE_DE_LANCES" não deve gerar "SECTION_REQUIRED", porque a aplicabilidade vem do dado do template

  Scenario: [Validação] Avisos sem reconhecimento e valor sigiloso no texto
    Given que o TR ganhou a versão 3 depois da importação
    When "Lia Santos" concluir sem reconhecer o aviso
    Then a API deve responder 422 com código "WARNINGS_NOT_ACKNOWLEDGED" e nada deve ser gravado
    Given que o orçamento é sigiloso e a seção "PAYMENT" do contrato repete o valor total estimado
    When "Lia Santos" consultar a análise
    Then a análise deve trazer "TENDER_CONFIDENTIAL_VALUE_IN_TEXT" na seção "PAYMENT" do contrato, sem exibir o valor
    When "Lia Santos" tentar concluir
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE" e o valor não deve aparecer na resposta, no log nem no evento

  Scenario: [Validação] Finalizar pelo documento e estado incompatível
    When "Lia Santos" finalizar o documento "ED 0004/2026" por "POST /documents/{id}/finalize"
    Then a API deve responder 409 com código "TENDER_CONCLUSION_REQUIRED" e o edital deve continuar "DRAFT"
    Given que o edital já está "FINALIZED"
    When "Lia Santos" concluir de novo com a chave "K2"
    Then a API deve responder 409 com código "INVALID_STATE"

  Scenario: [Permissão] Sem TENDER_SUBMIT, consultor externo e sem custódia
    Given que "Bruno Lopes" não tem "TENDER_SUBMIT" no processo
    When "Bruno Lopes" concluir a minuta
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar a auditoria "access.denied"
    Given que "Paulo Dias", do perfil "CONSULTOR_EXTERNO", é participante com "TENDER_UPDATE"
    When "Paulo Dias" consultar a análise e depois tentar concluir
    Then a análise deve responder 200 e a conclusão 403 com código "PERMISSION_DENIED"
    Given que "Marcos Pires", do perfil "GESTOR_CONTRATACOES", tem "TENDER_SUBMIT" mas não tem custódia nem participação no processo
    When "Marcos Pires" tentar concluir
    Then a API deve responder 403 com código "NOT_PROCESS_CUSTODIAN"

  Scenario: [Tenant incorreto] Edital de outro órgão
    Given que o "Tender" "ED 0009/2026" pertence ao tenant "Prefeitura B"
    When "Lia Santos", da "Prefeitura A", consultar a análise ou concluir esse edital
    Then a API deve responder 404 com código "NOT_FOUND" nas duas chamadas
    And nada do tenant "Prefeitura B" deve ser lido nem alterado
    And o provedor "tender" do tenant "Prefeitura A" não deve considerar editais da "Prefeitura B"

  Scenario: [Duplicidade] Reenvio da conclusão com a mesma chave e conclusão repetida
    Given que "Lia Santos" concluiu a minuta com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o mesmo corpo e o cabeçalho "Idempotent-Replayed: true"
    And devem existir apenas duas "DocumentVersion" "FINALIZATION", um evento "DocumentFinalized" por documento e uma auditoria "document.finalize" por documento
    When "Lia Santos" enviar nova conclusão com a chave "K2"
    Then a API deve responder 409 com código "INVALID_STATE"

  Scenario: [Concorrência] Edição durante a análise e conclusões simultâneas
    Given que "Lia Santos" consultou a análise e recebeu o "analysisHash" "H1"
    When "Marcos Pires" mover o item 7 para outro lote e "Lia Santos" concluir com "If-Match" igual a "H1"
    Then a API deve responder 412 com código "VERSION_CONFLICT" e os documentos devem continuar "DRAFT"
    When "Lia Santos" consultar a análise de novo e concluir ao mesmo tempo em que "Marcos Pires" concluir
    Then exatamente uma conclusão deve responder 200 e a outra 409 com código "INVALID_STATE"
    And as versões e os eventos devem existir uma única vez
    Given que há uma geração de IA "RUNNING" para o edital
    When "Lia Santos" concluir a minuta
    Then a conclusão deve responder 200 e a geração deve terminar "CANCELED" com "CANCELED_BY_POLICY"

  Scenario: [Falha de banco] Banco indisponível durante a transação de conclusão
    Given que o banco de dados fica indisponível durante a transação de "POST /tenders/{id}/conclude"
    When "Lia Santos" confirmar a conclusão
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And os dois documentos devem continuar "DRAFT"
    And não deve existir versão, auditoria, evento, entrada de timeline nem rendition

  Scenario: [Falha de integração] Gotenberg, relay do outbox e provedor de regras indisponíveis
    Given que o Gotenberg está fora do ar
    When "Lia Santos" concluir a minuta com sucesso
    Then a API deve responder 200 com as renditions "PENDING" e os documentos "FINALIZED"
    And as renditions devem tentar de novo com espera crescente e, esgotadas as tentativas, ficar "FAILED" sem desfazer a conclusão
    When "Lia Santos" pedir os PDFs de novo com o Gotenberg de volta
    Then as renditions devem ficar "READY"
    Given que o relay do outbox está indisponível
    When "Lia Santos" concluir a minuta com sucesso
    Then os eventos "DocumentFinalized" devem permanecer "PENDING" no outbox até o relay voltar
    Given que o provedor do namespace "tender" excede o tempo de 2 segundos
    When o responsável tentar encaminhar o processo
    Then a regra de saída deve ser avaliada como não satisfeita com o erro "RULE_CONTEXT_UNAVAILABLE" e a conclusão gravada deve permanecer inalterada
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Pendência bloqueante | 422 | `DOCUMENT_INCOMPLETE` | "Resolva as pendências antes de concluir a minuta." | Lista `violations[]` com link para o campo, a seção, o lote ou o item |
| Aviso não reconhecido | 422 | `WARNINGS_NOT_ACKNOWLEDGED` | "Reconheça os avisos antes de concluir." | Expande os avisos pendentes |
| Código reconhecido inválido | 422 | `VALIDATION_ERROR` | "Atualize a análise e reconheça apenas os avisos exibidos." | Recarrega a análise |
| Edital já concluído ou em estado incompatível | 409 | `INVALID_STATE` | "Esta minuta não pode ser concluída no estado atual." | Recarrega a aba |
| Processo fora de `IN_PROGRESS` | 409 | `INVALID_PROCESS_STATUS` | "O processo não está disponível para conclusão no momento." | Desabilita a ação |
| Tipo fora da etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "A minuta não pode ser concluída nesta etapa." | Oculta a ação |
| Finalização pelo documento | 409 | `TENDER_CONCLUSION_REQUIRED` | "Conclua pelo botão Concluir minuta do edital." | Leva à aba do edital |
| Sem permissão ou custódia | 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | "Você não tem permissão para concluir esta minuta." | Oculta a ação |
| Edital inexistente ou de outro tenant | 404 | `NOT_FOUND` | "Edital não encontrado." | Volta ao processo |
| `If-Match` ausente / divergente | 428 / 412 | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` | "A minuta foi alterada depois da análise. Recarregue e confira de novo." | Recarrega a análise e mantém os avisos já reconhecidos que continuam válidos |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco ou Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém o diálogo; respeita `Retry-After` |
| PDF não gerado (assíncrono) | — | rendition `FAILED` | "Não foi possível gerar o PDF agora. A minuta foi concluída." | Chip "PDF pendente" com "Tentar de novo" |
| Provedor de regras indisponível (no encaminhamento) | 503 | `RULE_CONTEXT_UNAVAILABLE` | "Não foi possível avaliar as regras agora. Tente encaminhar de novo." | Mantém a tela de encaminhamento |

## Dependências
- **Stories:** US-129 (mecanismo e contrato do `RuleContext` v2; esta story publica o provedor `tender.*`), US-164 (importação do TR e versão de origem), US-165 (lotes e cobertura), US-167 (minuta do contrato). Indiretas: US-163 (`Tender` e cabeçalho), US-166 (matriz e definição de "completa"), US-169 (conteúdo de IA que exige revisão), US-122 (revisão e bloqueio por seção), US-065 (ciclo de vida, DOC-08, DOC-10, DOC-12), US-066 (versões e `contentHash`), US-067 (PDF e Gotenberg), US-110 (template e `applicableModalities`), US-130 (workflow v2 e portão de prontidão das regras), US-131 (processos concluídos na v1 que continuam na v2), US-155 e US-161 (análise e manifestação sobre as versões congeladas), US-041/US-047 (encaminhamento).
- **Decisões/ADRs:** DEC-016, DEC-017, DEC-018, DEC-030, DEC-196, DEC-201, DEC-202; ADR-008 (regras e avisos), ADR-015 (`RuleContext` v2).
- **Configurações:** `tender.riskMatrixValueThreshold` (usada na exigência da matriz, US-166); template do `EDITAL` e da `MINUTA_CONTRATO` (seções, `applicableModalities`); regras de saída da etapa `MINUTA_EDITAL` na versão do workflow do tenant; `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:**
  1. **Catálogo `TENDER_*`:** `api.md` do MVP 1 reserva o prefixo por tipo, mas os códigos do edital (tabela de Campos) e o novo código de erro `TENDER_CONCLUSION_REQUIRED` não constam de nenhuma fonte; consolidar no `api.md` do MVP 2 e alinhar `TENDER_RISK_MATRIX_*` e `TENDER_LOT_*` com as US-165 e US-166.
  2. **Seções por modalidade:** `SectionDefinition` (MVP 1 §5.1) não tem aplicabilidade por modalidade. Esta story adota o atributo opcional `applicableModalities?: string[]` (códigos de `MODALITY`) como dado do template, semeado na biblioteca v2. Alternativa: chave de configuração do tenant. Decisão do card de templates (US-110/US-163). As seções semeadas (como `FASE_DE_LANCES`) são exemplos a validar com o jurídico do piloto.
  3. **Semântica de `tender.isComplete`:** `entities.md` §7.2 lista o campo sem defini-lo. Adotado: `EDITAL` `FINALIZED` ou `APPROVED`. Confirmar com o produto, pois a DEC-196 fala em "`Tender` e documento `EDITAL` completos".
  4. **Campos do cabeçalho que bloqueiam:** `entities.md` §4.5 deixa `proposalValidityDays`, `executionTermDays`, `contractTermMonths` e `guaranteePercent` nulos; esta story trata a validade da proposta como bloqueante e os demais como aviso (RN-TND-121). Também `judgmentCriterionId` e `modalityId` são `NOT NULL` em `entities.md`; se a US-163 mantiver, `TENDER_JUDGMENT_CRITERION_REQUIRED` e `TENDER_MODALITY_INVALID` só disparam por item inativo. Confirmar com o piloto.
  5. **`MINUTA_CONTRATO` é `FREE_TEXT`:** não tem `TypedDocumentModule`; a conclusão do `tender` usa a completude genérica do `document` e a finalização interna (`DocumentLifecycleService`) para os dois documentos. A porta `TypedDocumentModule` de `domains.md` lista só `TENDER` para o edital; o fluxo da conclusão conjunta precisa constar de `domains.md`.
  6. **Snapshot do edital:** `contractDraftVersionId` entra no snapshot (não em coluna de `tenders`); `entities.md` §4.5 e o `buildHeaderSnapshot` do módulo precisam listá-lo. `typedSummary` do edital (RN-TND-135) também é novo.
  7. **DOC-10 e DOC-09 recusados para tipos vinculados:** `TENDER_CONCLUSION_REQUIRED` e a recusa em DOC-10 são mudança nas rotas genéricas do `document`; registrar em `api.md`.
  8. **Regras de saída semeadas:** `entities.md` §9 e a DEC-196 descrevem as regras em texto; as expressões e mensagens da RN-TND-136 são propostas desta story (RN-WF2-100 exige que as definições estejam registradas) e usam `documents.MINUTA_CONTRATO.exists` (RuleContext v1).
  9. **Base legal e rótulos:** a referência ao art. 70, III, e ao art. 25 vem do briefing do épico; validar com o jurídico do piloto.

## Impacto técnico
- **Análise única:** o `TenderCompletenessAnalyzer` compõe o `TenderValidator` (edital), o serviço genérico do `document` (contrato e seções) e verificações cruzadas (TR, contrato, sigilo). É chamado a cada alteração no editor, portanto precisa ser determinístico e barato: uma consulta agregada para cabeçalho, lotes e matriz e leitura das seções já carregadas; meta de p95 em 600 ms (200 itens, 20 lotes, 30 alocações), medida no endurecimento.
- **Atomicidade:** nenhuma chamada de rede dentro da transação; o PDF é enfileirado depois do commit (relay do outbox para os eventos; fila `document-render` para as renditions). Ordem fixa de trava (`Tender`, `EDITAL`, `MINUTA_CONTRATO`) evita *deadlock* entre conclusões e edições.
- **ETag da análise:** o `analysisHash` dá o `If-Match` de TND-14 sem criar um contador novo no `Tender`; qualquer mudança nos insumos avaliados invalida a conclusão iniciada com análise antiga (412), sem apagar o que a pessoa reconheceu.
- **Provedor do `RuleContext`:** consulta única agregada, cache por requisição, 2 s por namespace, falha fechada; nenhuma exposição de valor (RN-WF2-83/84).
- **Sigilo:** a lista de valores sigilosos (total e por item) fica no servidor; a análise, o log, o evento e o snapshot nunca levam valor. A comparação normaliza separadores e moeda.
- **Compatibilidade:** DOC-08, DOC-09, DOC-10 e DOC-12 mantêm os contratos; ganham o tipo `EDITAL` e a recusa por `TENDER_CONCLUSION_REQUIRED`; eventos genéricos `document.*.edital` e `document.*.minuta_contrato` com `eventVersion = 1`.
- **Fora de escopo e MVP 3:** número do edital, publicação, `PUBLISHED`, PNCP e Diário Oficial, assinatura eletrônica e sessão pública não têm campo, estado nem rota aqui; o `Tender` fica pronto para recebê-los sem migração destrutiva.

## Backend
- **Módulo(s):** `tender` (dono: análise, conclusão, `TenderValidator`, `TenderRuleContextContributor`, `TenderFacade`), `document` (ciclo de vida, versões, renditions), `term` e `risk` (fachadas de leitura), `process`, `workflow` (regras de saída semeadas), `catalog`, `access`, `timeline`, `audit`, `platform` (`OutboxWriter`, `IdempotencyService`, fila `document-render`).
- **Casos de uso:** `GetTenderCompletenessQuery` (TND-13); `ConcludeTenderDraftCommand` (TND-14); `TenderRuleContextContributor.contribute` (namespace `tender`); `GetDocumentValidationQuery` (DOC-08, estendida pelo `TenderValidator`).
- **Domínio:** `TenderCompletenessAnalyzer` (regras RN-TND-120 a RN-TND-129); `TenderConclusionPolicy` (estado, avisos reconhecidos, ETag); `TenderValidator` (implementa `TypedDocumentModule.validateCompleteness`, `buildHeaderSnapshot`, `buildCollectionsSnapshot`, `typedSummary`); `ConfidentialValueScanner` (valores sigilosos conhecidos × texto); `TenderRiskMatrixPolicy` (da US-166).
- **Integrações internas:** `DocumentLifecycleService.finalize` (os dois documentos), `DocumentFacade.getVersionSnapshot` e `RenditionRequester` (PDFs), `TermReadFacade` (versão corrente do TR), `RiskFacade`, `ProcessFacade` (itens e estado), `AuthorizationService.assertCan('TENDER_SUBMIT', { processId })`, `ConfidentialBudgetGuard`, `AuditService`, `TimelineProjector`, `IdempotencyService`.
- **Transação:** trava do `Tender` e dos documentos → reavaliação da análise → conferência do ETag e dos avisos → finalização do contrato e do edital → duas `DocumentVersion` → auditoria → timeline → outbox → commit; PDFs enfileirados depois do commit; avaliação das regras de saída fora da transação.

## Frontend
- **Tela(s):** SCR-021 (`/processos/[id]/edital/[tenderId]`), painel "Análise da minuta" e modo somente leitura; SCR-006 (`/processos/[id]`), onde o encaminhamento mostra o resultado das regras de saída.
- **Componentes:** `TenderCompletenessPanel` (resumo por tema, bloqueios e avisos com links), `AcknowledgeWarningToggle`, `ConcludeTenderDialog` (o que será congelado, avisos reconhecidos, texto "não aprova nem publica"), `FrozenVersionsCard`, `RenditionStatusChip` (com "Tentar de novo"), `TenderConcludedBanner`, `ConfirmationDialog`.
- **Estados:** carregando a análise (skeleton); sem pendências (destaque verde, ação habilitada); com bloqueios (lista e ação desabilitada); erro ao calcular (com "Tentar novamente"); concluindo; concluída (somente leitura); análise desatualizada (412, recarrega); PDF gerando, pronto ou pendente.
- **Acessibilidade e responsividade:** lista de pendências com foco programático ao abrir o link; resultado da conclusão e mudança dos chips anunciados por `aria-live`; selos por texto e ícone, nunca só cor; em telas abaixo de 768 px a análise vira *accordion* e o diálogo ocupa a tela; contraste AA nos temas claro e escuro.

## Banco de dados
- **Tabelas:** `tenders`, `tender_lots`, `tender_lot_items` e `tender_risk_allocations` (leitura), `documents` (update de status e `finalized_at`), `document_versions` (insert), `document_renditions` (insert `PENDING`), `audit_logs`, `outbox_events`, `timeline_entries`; leitura de `process_items`, `risks`, `catalog_items`, versões do TR.
- **Migrações:** nenhuma tabela ou coluna nova além das da US-167 e da M2-14; semente de regras de saída da etapa `MINUTA_EDITAL` e do atributo `applicableModalities` na biblioteca padrão v2 (M2-21 e semente de templates).
- **Índices/constraints relevantes:** os de `tenders`, `tender_lots` e `tender_lot_items` (unicidade de item por lote); trigger de bloqueio de `UPDATE`/`DELETE` em `tender_lots`, `tender_lot_items` e `tender_risk_allocations` quando o `EDITAL` não está `DRAFT`/`RETURNED`; RLS por `tenant_id`.

## API
_Indicativa; IDs e contratos finais no `api.md` do MVP 2._

| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `TND-13` | GET | `/api/v1/tenders/{id}/completeness` | path `id` | `200 { data: { canConclude, violations[], summary, term, lots, riskMatrix, contractDraft, aiReview, aiProposals, evaluatedAt }, meta: { analysisHash } }` + `ETag` | 200, 401, 403, 404 |
| `TND-14` | POST | `/api/v1/tenders/{id}/conclude` | `{ acknowledgedWarnings?: string[] }` + `If-Match` + `Idempotency-Key` | `200 { data: { tender, editalVersion, contractDraftVersion?, renditions[], warningsAcknowledged[] } }` | 200, 401, 403, 404, 409, 412, 422, 428, 503 |
| `DOC-08` | GET | `/api/v1/documents/{id}/validation` | — | `violations[]` do documento (edital via `TenderValidator`) | 200, 403, 404 |
| `DOC-21` | POST | `/api/v1/document-versions/{versionId}/renditions` | — | nova rendition `CONTENT` (retentativa do PDF) | 202, 403, 404, 409 |
| `DOC-22` | GET | `/api/v1/document-renditions/{renditionId}` | — | estado da rendition | 200, 403, 404 |

## Logs
- `info` `tender.completeness_evaluated` — `tenderId`, `blockingCount`, `warningCount`, `durationMs`.
- `info` `tender.concluded` — `tenderId`, `processId`, `editalVersionNumber`, `contractDraftFinalized`, `warningsAcknowledgedCount`, `durationMs`, `correlationId`.
- `warn` `tender.conclude_rejected` — `tenderId`, `errorCode`; `warn` `tender.rendition_enqueue_failed`; `warn` `rule_context.tender_slow`; `warn` `idempotency.store_unavailable`.
- `error` `tender.conclude_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** texto das seções, valores do orçamento sigiloso, valores dos itens, nomes de pessoas.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.finalize` | `DATA_CHANGE` | Commit de TND-14 (uma por documento finalizado) | `metadata`: `documentId`, `documentTypeCode`, `documentVersionId`, `acknowledgedWarnings[]` (código e `params`), `tenderId`, `idempotencyKey`; sem texto |
| `access.denied` | `ACCESS` | 403 em TND-13 ou TND-14 | `reasonCode` (`TENDER_SUBMIT`, `NOT_PROCESS_CUSTODIAN`), `tenderId` |

## Testes necessários
- **Unitários:** cada regra do `TenderCompletenessAnalyzer` isolada (cabeçalho condicional por modalidade e tipo de contratação, habilitação, critério e modalidade, cobertura de lotes com e sem `BY_LOT`, matriz exigida ou não, seções por `applicableModalities`, TR em dia e desatualizado, IA pendente, valor sigiloso no texto, contrato ausente e desatualizado); `TenderConclusionPolicy`; `TenderRuleContextContributor` (`exists`, `isComplete`, `riskMatrixComplete` quando não exigida); `ConfidentialValueScanner` (formatos de moeda, falsos positivos); cálculo do `analysisHash`.
- **Integração (Testcontainers PostgreSQL + Redis):** transação completa (duas finalizações, duas versões, auditoria, timeline, outbox) e rollback total; trava e ordem entre `Tender` e documentos; trigger de imutabilidade de lotes e matriz; renditions enfileiradas depois do commit; regra de saída satisfeita e desfeita por reabertura; devolução e nova conclusão com versões novas; RLS entre tenants.
- **API/contrato:** TND-13 e TND-14 conforme o `api.md` (`ETag`, `If-Match`, `Idempotent-Replayed`, 412, 428); DOC-08 e DOC-10 (`TENDER_CONCLUSION_REQUIRED`); `violations[]` no formato de §2.1.2 sem valores; eventos sem texto nem valores.
- **RBAC e multi-tenant:** `TENDER_SUBMIT` por perfil e escopo; `CONSULTOR_EXTERNO` não conclui; POL-01 e POL-02; edital e provedor `tender` de outro tenant → 404; teste novo na suíte `test/tenant-leak` (análise, conclusão e provedor de regras).
- **Concorrência:** conclusão x edição de lote ou de seção (412); duas conclusões simultâneas; conclusão x geração de IA; conclusão x nova versão do TR; reenvio idempotente.
- **E2E (Playwright):** criar a minuta → importar do TR → lotes e matriz → contrato → análise com bloqueios e avisos → resolver e reconhecer → concluir → encaminhar ao Jurídico; variantes com orçamento sigiloso, com edital gerado por IA (`FakeAiProvider`) exigindo revisão e com devolução e nova conclusão.
- **Acessibilidade/performance:** axe sem violações sérias no painel e no diálogo; 360 px; p95 de TND-13 ≤ 600 ms, de TND-14 ≤ 1,2 s (sem os PDFs) e do provedor `tender.*` ≤ 50 ms na suíte de performance (medidos no endurecimento).

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
- [ ] Catálogo de códigos `TENDER_*` documentado e coberto por teste
- [ ] Teste prova que as seções obrigatórias por modalidade vêm do template (dado semeado) e que não há regra por modalidade no código
- [ ] Teste de falha induzida comprova a transação única (dois documentos, versões, auditoria, evento) e que o PDF só é enfileirado depois do commit
- [ ] Provedor `tender.*` e as duas regras de saída registrados e cobertos pelo teste de contrato dos provedores (US-129) e pelo portão de prontidão da US-130
- [ ] Teste prova que nenhum valor estimado aparece na análise, no snapshot, no PDF, no evento nem no log com orçamento sigiloso
- [ ] Teste prova que concluir não move o processo, não numera, não publica e não aprova

## Estimativa
**M** — o ciclo de vida, as versões e o PDF já existem (US-065 a US-067); o esforço está no analisador de completude (catálogo `TENDER_*`, seções por modalidade, TR em dia, sigilo no texto), na conclusão atômica de dois documentos com ETag e idempotência, no provedor `tender.*` com as regras de saída e nos testes de concorrência e de isolamento.

## Prioridade
**P0** — sem a conclusão a regra de saída de `MINUTA_EDITAL` não é satisfeita, o Jurídico não recebe versões congeladas e a fase preparatória da v2 não avança; é o ato que entrega o edital pronto para análise e para a autorização.

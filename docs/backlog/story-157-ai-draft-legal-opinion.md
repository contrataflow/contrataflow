---
id: US-157
title: "Gerar o rascunho do parecer jurídico com IA"
epic: EP-025
feature: FT-075
mvp: 2
priority: P1
estimate: L
status: Especificada
depends_on: [US-115, US-116, US-122, US-154]
modules: [ai, document, legal-review, budget, tender, process, tenancy, access, catalog, timeline, notification, audit, platform]
screens: [SCR-019, SCR-117, SCR-041]
endpoints: [AI-01, AI-02, AI-04, AI-05, AI-06, DOC-26, DOC-27, LGL-02]
permissions: [AI_GENERATE, LEGAL_REVIEW_MANAGE, LEGAL_REVIEW_VIEW, LEGAL_REVIEW_CONCLUDE, PROCESS_VIEW, SETTINGS_MANAGE]
events: [AiGenerationRequested, AiGenerationCompleted, AiGenerationFailed, AiContentApplied, AiContentReviewed, DocumentVersionCreated, AiUsageThresholdReached]
---

# US-157 — Gerar o rascunho do parecer jurídico com IA

## Título
Gerar o rascunho do parecer jurídico com IA

## Descrição
**Como** procurador da assessoria jurídica responsável pelo parecer (art. 53 da Lei 14.133/2021), **quero** pedir à IA um rascunho das seções do `PARECER_JURIDICO` a partir das versões exatas que estou analisando, da dotação, da minuta do edital e das diligências anteriores, aplicá-lo seção a seção e revisá-lo, **para** reduzir o tempo de redação do relatório, da fundamentação e da análise dos artefatos sem abrir mão da decisão, que continua sendo minha.

A story acrescenta ao fluxo genérico do EP-020 (solicitar `AI-01`, acompanhar `AI-02`, descartar `AI-04`, aplicar `DOC-26`, revisar `DOC-27`, painel `SCR-117`) o gerador e o prompt `draft.legal_opinion`, o alvo `LEGAL_OPINION` e as regras próprias do ato mais sensível da fase preparatória: **a IA nunca propõe a conclusão** (a seção `CONCLUSION` sai sempre como `[a confirmar]` da categoria `DECISION`), a situação (`FAVORABLE`, `FAVORABLE_WITH_RESERVATIONS`, `UNFAVORABLE`) é escolhida só por quem tem `LEGAL_REVIEW_CONCLUDE`, aplicar texto não muda `LegalReview.status` e o parecer só é finalizado, e a análise só é concluída, com todas as seções revisadas por uma pessoa (US-122). Não há endpoint novo de geração.

## Contexto
- A DEC-202 estende a camada de IA do MVP 1 (DEC-037, DEC-079) ao parecer: gerador `draft.legal_opinion`, `AiGeneration.targetModule = LEGAL_OPINION`, entradas em cadeia (DFD, ETP, mapa de riscos, pesquisa de preços, TR, dotação, minuta do edital), mesmos `ContextSanitizer` e `GroundingGuard`, mesmos princípios (a IA não decide, nada inventado, revisão humana por seção, opt-in e limites por órgão). Na DEC-203 o custo é incluído no plano, sem cobrança por uso.
- O parecer é um `Document` `PARECER_JURIDICO` (módulo `LEGAL_OPINION`), criado pelo procurador a partir do template do órgão (LGL-20, US-154), com seções do template v2 (relatório, fundamentação, análise dos artefatos, ressalvas, conclusão). O ciclo de vida é o da DEC-018; a análise (`LegalReview`) está em `IN_REVIEW` e já tem o snapshot das versões analisadas (US-152, RN-LGL-09/RN-LGL-41).
- Pela DEC-196 a dotação (EP-024) e a minuta do edital (EP-027) existem **antes** da análise jurídica, por isso entram como insumo. Na retomada após diligência (US-153) a análise tem nova rodada e as diligências anteriores passam a ser entrada.
- O rascunho do parecer é restrito (POL-24): só quem tem `LEGAL_REVIEW_MANAGE` cobrindo o processo e o Auditor leem o conteúdo. Isso vale também para a proposta da IA, que é um rascunho do parecer.
- A segregação jurídico x requisitante (POL-19) vale para gerar, aplicar e revisar, como para editar o parecer. A POL-18 é estendida a `LEGAL_OPINION` com `AI_GENERATE` mais `LEGAL_REVIEW_MANAGE` (permissions.md); `AI_GENERATE` foi ampliada para o perfil `JURIDICO` e continua fora de `CONTROLE_INTERNO` e `CONSULTOR_EXTERNO`.
- O orçamento sigiloso (DEC-030, POL-09) nunca vai ao prompt, ao log, ao evento nem à auditoria, nem para quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`. A dotação entra só com classificação e situação de cobertura, sem valores.
- A revisão obrigatória (US-122) já bloqueia finalizar (DOC-10) e concluir (LGL-19, US-155, RN-LGL-17) com seção `SECTION_AI_REVIEW_PENDING` ou `SECTION_PLACEHOLDER_PENDING`; esta story só garante que o conteúdo do parecer gerado por IA entre nesse circuito.

## Objetivo
Entregar, em até 90 s (p95, medido no endurecimento), uma proposta das seções do parecer com 100% dos fatos vindos das entradas rastreadas, todo dado ausente marcado `[a confirmar]` e a seção de conclusão sempre pendente de decisão humana, de modo que 0 propostas tragam situação conclusiva (amostragem e conjunto de avaliação) e 100% dos pareceres com texto de IA só sejam finalizados depois de revisados seção a seção.

## Persona
- **Principal:** Jurídico / procurador (`JURIDICO`) com `AI_GENERATE`, `LEGAL_REVIEW_MANAGE` e, para concluir, `LEGAL_REVIEW_CONCLUDE`.
- **Secundárias:** Titular ou substituto da unidade jurídica (mesmos poderes sobre o parecer, se não houver conflito de POL-19); Administrador do órgão (`ADMIN_ORGAO`, `SETTINGS_MANAGE`: liga a IA e acompanha limites e consumo); Auditor (`AUDITOR`, `AUDIT_VIEW`: lê rascunho, gerações e trilha); Requisitante e Planejamento veem só a situação da análise e o parecer concluído, nunca a proposta nem o rascunho (POL-24).

## Pré-condições
- IA ligada no órgão (`ai.enabled = true`, com os termos aceitos), provedor disponível e limites mensal e diário não atingidos (US-115, US-116).
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`, com `AI_GENERATE` e `LEGAL_REVIEW_MANAGE` cobrindo o processo, sem conflito de POL-19.
- `LegalReview` do tenant em `IN_REVIEW` (snapshot da rodada corrente já gravado) de processo `IN_PROGRESS` na etapa `JURIDICO` (RN-LGL-111).
- Documento `PARECER_JURIDICO` criado para a análise (LGL-20, US-154), em `DRAFT`, com tipo permitido na etapa e processo editável (POL-02).

## Fluxo principal
1. No editor do parecer (SCR-019, `/juridico/[reviewId]`, US-154), o procurador com `AI_GENERATE` vê **"Gerar rascunho com IA"** (`AiDraftButton`); o front consulta `AI-05` e desabilita a ação, com explicação, se `canGenerate = false` (IA desligada, limite, análise fora de `IN_REVIEW`, parecer ainda não criado, conflito de POL-19).
2. O painel `SCR-117` abre no formulário (`AiRequestForm`): lista as entradas previstas (versões do snapshot da rodada com tipo, `vN` e se eram rascunho; dotação por classificação e cobertura; minuta do edital; diligências da rodada anterior, se houver), as seções do parecer vazias e preenchidas, o campo opcional de orientações, o aviso fixo "A IA não propõe a conclusão do parecer: a seção Conclusão sairá como [a confirmar] e a situação é sua escolha" e o consumo estimado de tokens.
3. O procurador clica em **"Gerar rascunho"**; o front envia `AI-01` (`targetModule = LEGAL_OPINION`, `documentId` do parecer, `kind = DRAFT`, `instruction?`) com `Idempotency-Key`. A API valida a POL-18 estendida, a POL-19, o estado da análise (RN-LGL-111), a geração ativa (RN-AI-12) e os limites; grava `AiGeneration` em `QUEUED` com `promptKey = draft.legal_opinion`, reserva os tokens, enfileira após o commit e responde 202 com `Location` e `pollAfterMs`.
4. O painel mostra o progresso (`AiGenerationProgress`); o procurador pode continuar editando o parecer (RN-AI-30).
5. O worker revalida POL-18, POL-19 e o estado da análise; monta o contexto por fachadas de leitura (RN-LGL-112/RN-LGL-113) com o `ContextSanitizer`; chama o provedor fora de transação com o prompt `draft.legal_opinion`; valida o esquema (só `sections`); trata a seção `CONCLUSION` (RN-LGL-115); aplica o `GroundingGuard` (RN-LGL-116/RN-LGL-118) e grava a proposta `SUCCEEDED` com `inputRefs`, `warnings`, `placeholdersCount` e `groundingReplacements`.
6. O solicitante recebe `AI_GENERATION_READY` e o painel exibe a proposta (`AiProposalSectionList`): `[a confirmar]` por seção, avisos (insumo rascunho, truncamento, sigilo), seções `EMPTY` marcadas e `FILLED` desmarcadas com "substituirá o texto atual"; a seção **Conclusão** aparece com o selo "Decisão sua" e só traz a pendência.
7. O procurador lê a prévia (`AiSectionDiffView` nas já preenchidas), ajusta a seleção e clica em **"Aplicar seleção"**; o front envia `DOC-26` (`generationId`, `sectionKeys`, `confirmReplaceFilled?`) com `If-Match` do parecer e `Idempotency-Key`.
8. A API aplica conforme a RN-AI-29 (proveniência de IA por seção, `revision + 1`, versão `SYSTEM` antes de substituir seção preenchida, geração `APPLIED`, auditoria `ai.content_apply`, evento `AiContentApplied`). A situação da `LegalReview`, a ementa e as ressalvas registradas **não** mudam (RN-LGL-117).
9. No editor, cada seção aplicada mostra "Gerado por IA · revisão pendente" e os `[a confirmar]` em destaque (US-122). O procurador completa os dados, resolve as pendências, redige a conclusão, aciona "Marcar seção como revisada" (DOC-27) por seção ou "Revisar todas".
10. Só então finaliza o parecer (DOC-10) e conclui a análise escolhendo a situação (LGL-19, US-155); sem as revisões, ambos respondem 422 `DOCUMENT_INCOMPLETE`. O painel SCR-019 mostra, enquanto isso, "N seções do parecer aguardam revisão" (RN-LGL-119).

## Fluxos alternativos
- **FA-01 — Parecer ainda não criado:** `AI-01` sem `documentId` do parecer responde 422 `AI_PREREQUISITE_MISSING` (`missing: ['OPINION_DOCUMENT']`); o painel orienta "Elabore o parecer antes de usar a IA", com atalho para LGL-20 (US-154).
- **FA-02 — Análise fora de `IN_REVIEW`:** `PENDING`, `DILIGENCE`, conclusiva, `WAIVED` ou `CANCELED` respondem 409 `LEGAL_REVIEW_INVALID_STATE` no pedido e na aplicação; a ação aparece desabilitada com o motivo (RN-LGL-111).
- **FA-03 — Insumo ainda rascunho:** versão do snapshot cujo documento estava em rascunho ao ser salvo (ex.: TR) entra e gera o aviso `USED_DRAFT_INPUTS` com os tipos; o procurador decide se gera assim ou espera a finalização (RN-LGL-112).
- **FA-04 — Entradas opcionais ausentes:** sem pesquisa de preços, sem dotação confirmada, sem minuta do edital ou sem diligência anterior, a geração segue com `MISSING_OPTIONAL_INPUT` (lista dos tipos) e a análise do artefato ausente sai como `[a confirmar: …]`, nunca como afirmação.
- **FA-05 — Orçamento sigiloso:** valores do processo e da dotação ficam fora do contexto; a proposta traz `BUDGET_CONFIDENTIAL_VALUES_OMITTED` e os pontos que dependem de valor saem `[a confirmar: valor]` (RN-LGL-113).
- **FA-06 — Retomada em nova rodada:** com a rodada 2 (US-153) as diligências e respostas da rodada anterior entram como insumo; propostas de rodadas anteriores não aplicadas mostram `INPUTS_OUTDATED` e a recomendação "Gere de novo com as versões da rodada atual"; seções já preenchidas vêm desmarcadas (RN-LGL-120).
- **FA-07 — Seção preenchida:** a seção que o procurador já escreveu só é substituída com `confirmReplaceFilled: true`, e uma `DocumentVersion` `SYSTEM` é criada antes (RN-AI-28/RN-AI-29).
- **FA-08 — Aplicar só algumas seções, inclusive a conclusão:** a seleção é livre; aplicar `CONCLUSION` insere apenas a marcação `[a confirmar: conclusão do parecer]` e mantém `LegalReview.status` (RN-LGL-117).
- **FA-09 — Edição não revisa:** alterar o texto de seção gerada mantém a revisão pendente; nova aplicação sobre seção revisada zera a revisão (US-122).
- **FA-10 — Proposta de outra pessoa:** quem tem `LEGAL_REVIEW_MANAGE` mas não é o solicitante vê a proposta somente leitura, sem aplicar nem descartar; quem não é do jurídico nem Auditor não vê o conteúdo (RN-LGL-121).
- **FA-11 — Descarte, expiração e nova proposta:** seguem RN-AI-31, RN-AI-11 e RN-AI-32 (proposta `SUCCEEDED` vale 7 dias; nova solicitação do mesmo usuário descarta a anterior não aplicada).
- **FA-12 — Saída do provedor com situação conclusiva:** a geração termina `FAILED` com `OUTPUT_INVALID` após uma tentativa de reparo; nada é gravado e o solicitante recebe `AI_GENERATION_FAILED` (RN-LGL-115).

## Regras de negócio
- **RN-LGL-21** — A IA do parecer nunca propõe a conclusão: a seção de conclusão sai como `[a confirmar]` (`DECISION`) e `output` nunca carrega situação conclusiva; o `GroundingGuard` rejeita a saída com `OUTPUT_INVALID` se vier (DEC-202). *(regra da feature, adotada)*
- **RN-LGL-22** — A situação do parecer é escolhida só por pessoa com `LEGAL_REVIEW_CONCLUDE`; aplicar a seção de conclusão não altera `LegalReview.status` (DEC-202, POL-18 estendida). *(regra da feature, adotada)*
- **RN-LGL-23** — Gerar exige `AI_GENERATE` mais `LEGAL_REVIEW_MANAGE` cobrindo o processo (POL-18 estendida, POL-19, POL-24); a IA precisa estar ligada (`ai.enabled`). *(regra da feature, adotada)*
- **RN-LGL-24** — As entradas são as versões da cadeia de documentos; a proposta guarda as versões usadas (`inputRefs`) e avisa se algum insumo era rascunho. *(regra da feature, adotada)*
- **RN-LGL-25** — Nada é inventado: números, valores, prazos e fundamentos ausentes das entradas aparecem como `[a confirmar]`; valores de orçamento sigiloso nunca vão ao prompt (DEC-030, RN-AI-05). *(regra da feature, adotada)*
- **RN-LGL-26** — O texto aplicado fica "gerado por IA" até a revisão humana por seção; o parecer só é finalizado, e a análise só é concluída, com todas as seções revisadas (US-122). *(regra da feature, adotada)*
- **RN-LGL-27** — Valem `ai.monthlyTokenLimit`, `ai.userDailyRequestLimit` e o custo incluído no plano, sem cobrança por uso; o consumo do gerador novo aparece no relatório por órgão (DEC-203). *(regra da feature, adotada)*
- **RN-LGL-110** — Habilitação para gerar: `AI_GENERATE` e `LEGAL_REVIEW_MANAGE` cobrindo o processo, sem conflito de POL-19 (`LEGAL_REVIEW_SEGREGATION`), `ai.enabled`, provedor e limites (POL-18 estendida, revalidada no worker com `CANCELED_BY_POLICY` se falhar). Para **aplicar** e **revisar** basta `LEGAL_REVIEW_MANAGE` cobrindo o processo (POL-02 do tipo, POL-19, POL-24), como em RN-AI-29 e RN-AI-56: `AI_GENERATE` não é exigida, de modo que a revisão continua possível com a IA desligada. Só o solicitante aplica ou descarta a própria proposta (RN-AI-13). A designação (`assigneeId`) não é exigida para gerar, aplicar ou revisar, apenas para concluir (POL-19, US-155).
- **RN-LGL-111** — Pré-requisitos de `AI-01` com `targetModule = LEGAL_OPINION`: o `documentId` é o `PARECER_JURIDICO` apontado por `LegalReview.opinionDocumentId` (senão 422 `VALIDATION_ERROR`); sem parecer criado, 422 `AI_PREREQUISITE_MISSING` (`missing: ['OPINION_DOCUMENT']`); `LegalReview` em `IN_REVIEW` (senão 409 `LEGAL_REVIEW_INVALID_STATE`); processo `IN_PROGRESS` com a etapa `JURIDICO` ativa (senão 409 `INVALID_PROCESS_STATUS`); parecer em `DRAFT` (senão 409 `DOCUMENT_NOT_EDITABLE`). Verificados no pedido, no worker e na aplicação (DOC-26).
- **RN-LGL-112** — Entradas, cada uma vira `inputRef`: (a) o processo (`PROCESS`: objeto, modalidade, tipo de contratação, unidade requisitante por nome, sem pessoas) e seus itens (`PROCESS_ITEMS`); (b) as **versões exatas do snapshot da rodada corrente** (`LegalReviewDocument`, RN-LGL-41) de DFD, ETP, mapa de riscos, pesquisa de preços, TR, `EDITAL` e `MINUTA_CONTRATO` (`DOCUMENT_VERSION`, com `versionId`, `versionNumber` e `statusAtCreation`); (c) as dotações confirmadas (`BUDGET_ALLOCATIONS`: classificação e situação de cobertura `COVERED`, `PARTIAL` ou `NOT_COVERED`, nunca valores nem a razão de cobertura); (d) o cabeçalho tipado do edital (`TENDER`: modalidade, critério de julgamento, modo de disputa, regime, exigências de habilitação, prazos e condições, sem valores); (e) a análise (`LEGAL_REVIEW`: rodada e, na retomada, as diligências e respostas das rodadas anteriores); (f) a versão do template do parecer (`TEMPLATE_VERSION`: seções, `legalBasis` e dicas); (g) `instruction` opcional (≤ 500). A fonte é o **snapshot**, não a versão mais recente do documento, para que o rascunho fale do que o procurador de fato analisa (RN-LGL-09); a diferença só gera aviso (RN-LGL-120). Insumo cuja versão foi salva em rascunho gera `USED_DRAFT_INPUTS`; tipo ausente, `MISSING_OPTIONAL_INPUT`.
- **RN-LGL-113** — Minimização e sigilo: o `ContextSanitizer` remove pessoas (nomes, CPF, e-mail, telefone), fornecedores e cotações individuais da pesquisa de preços (só método, número de cotações e resultado por item) e dados pessoais do texto livre de diligências; com orçamento sigiloso, `process.estimatedValue`, valores da pesquisa de preços e valores da dotação saem do contexto (aviso `BUDGET_CONFIDENTIAL_VALUES_OMITTED`), mesmo para quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`. O contexto não é persistido: só `contextHash` e `inputRefs` ficam na geração.
- **RN-LGL-114** — A saída tem só `sections` (uma por seção do template fixado no parecer, com `legalBasis` preservada); não há campo de riscos tipados, de situação, de ementa, de ressalvas estruturadas nem de diligências. As "ressalvas sugeridas" são **texto da seção** `RESERVATIONS`, com pontos de atenção redigidos a partir das entradas; a IA não cria, altera nem atende `LegalReviewReservation` e não pede diligência: ressalvas e diligências são atos do procurador (US-153, US-154).
- **RN-LGL-115** — Conclusão: a seção de chave reservada `CONCLUSION` é sempre gravada pelo servidor como um único nó `toConfirm` (`category = DECISION`, `label = "conclusão do parecer"`, `origin = AI`); texto devolvido pelo provedor nessa seção é descartado quando for só pontuação ou o próprio marcador, e é **rejeitado** (`OUTPUT_INVALID`, após uma tentativa de reparo, sem gravar `output`) quando contiver fórmula conclusiva ou quando a saída trouxer qualquer campo de situação (`status`, `outcome`, `conclusion`, `FAVORABLE*`, `UNFAVORABLE`). Falha fechada (RN-AI-54).
- **RN-LGL-116** — Fórmulas conclusivas fora da seção `CONCLUSION` (por exemplo, "opino pela regularidade da contratação", "parecer favorável", "desfavorável", "apto a prosseguir"): o `GroundingGuard` as troca por `toConfirm` da categoria `DECISION`, conta em `groundingReplacements` e emite o aviso `CONCLUSIVE_LANGUAGE_REPLACED`. Frases descritivas sobre um artefato ("o ETP descreve a necessidade") não são conclusivas. A lista de padrões é versionada com o prompt e coberta pelo `pnpm ai:eval`.
- **RN-LGL-117** — Aplicação (DOC-26) segue RN-AI-28/RN-AI-29 e acrescenta: aplicar qualquer seção, inclusive `CONCLUSION`, **não** altera `LegalReview.status`, `conclusionSummary`, `assigneeId`, `LegalReviewReservation`, `LegalReviewDocument` nem o `If-Match` da análise; a ementa e a situação são digitadas e escolhidas por pessoa em LGL-19. Por padrão vêm marcadas as seções `EMPTY`, inclusive `CONCLUSION`, que só traz a pendência; o procurador pode desmarcá-la.
- **RN-LGL-118** — Nada inventado (RN-AI-54): valor monetário, quantidade com unidade, prazo, data e percentual que não existam no conjunto de fatos das entradas viram `toConfirm` (`VALUE`, `QUANTITY`, `DEADLINE`, `DATE`); citações legais (lei, artigo, inciso) são preservadas, mas a IA não cria fundamento jurídico: citação fora do `legalBasis` do template, das entradas e do conjunto de artigos da fase preparatória (arts. 18, 22, 23, 53, 72, 92 e 150 da Lei 14.133/2021, configurável pela biblioteca versionada do prompt) vira `[a confirmar: fundamento]` (categoria `DATA`). Referências a artefatos (tipo, número de versão, código do documento) só podem ser as das entradas; outras viram `[a confirmar]`. Não há citação de jurisprudência.
- **RN-LGL-119** — Marcação e revisão: cada seção aplicada recebe `ai = { generationId, appliedAt, appliedById, reviewedAt: null }` (RN-AI-55); a revisão (DOC-27) é ato humano por seção ou em lote, com `LEGAL_REVIEW_MANAGE` cobrindo o processo, e a proveniência pendente bloqueia DOC-10 e LGL-19 com `DOCUMENT_INCOMPLETE` (RN-AI-57, RN-LGL-17). O painel SCR-019 e `LGL-02` mostram `aiReviewPendingSections` (chaves) e `aiPlaceholdersPending` (contagem), derivados do `draftContent`, sem coluna nova. Concluir a análise nunca revisa por conta própria.
- **RN-LGL-120** — Insumos desatualizados: o aviso `INPUTS_OUTDATED` é **derivado na leitura** (AI-02 e painel) quando, depois da geração, (a) a `LegalReview` mudou de rodada, ou (b) algum documento da cadeia ganhou versão nova em relação ao `inputRefs`; lista os tipos e recomenda gerar de novo. Não impede aplicar (a decisão e a revisão são humanas), mas fica visível ao aplicar e no registro de auditoria `ai.content_apply` (`outdatedInputs`).
- **RN-LGL-121** — Visibilidade restrita (POL-24): a proposta de `LEGAL_OPINION` é um rascunho do parecer. `AI-02` e `AI-03` devolvem `output`, `warnings` e `inputRefs` apenas a quem tem `LEGAL_REVIEW_MANAGE` cobrindo o processo ou `AUDITOR` com `AUDIT_VIEW`; quem só tem `PROCESS_VIEW` recebe os metadados (status, datas, modelo, contagens), sem texto. O parecer concluído passa a ser lido como qualquer documento visível.
- **RN-LGL-122** — Limites e consumo (DEC-203): a reserva de tokens do pedido é a estimativa do alvo `LEGAL_OPINION` (calibrada no endurecimento; proposta inicial de 60 mil tokens, ver lacuna), abatida do consumo real ao final; `AI-06` passa a exibir o gerador `draft.legal_opinion`; ao cruzar 80% e 100% do limite mensal vale `AiUsageThresholdReached` (RN-AI-20). Sem cobrança por uso.
- **RN-LGL-123** — Rastreabilidade: auditoria `ai.generation_request`, `ai.generation_complete`/`ai.generation_fail`, `ai.content_apply`, `ai.content_review` e `ai.generation_discard` com `metadata.targetModule = LEGAL_OPINION` e só ids, versões, hashes, contagens e `errorCode`, nunca texto, orientações nem valores; entradas `AI_CONTENT_GENERATED`, `AI_CONTENT_APPLIED` e `AI_CONTENT_REVIEWED` na timeline do processo, sem conteúdo.
- **RN-LGL-124** — Disponibilidade (`AI-05`): `canGenerate = false` com `reasons[]` entre `AI_DISABLED`, `AI_PROVIDER_UNAVAILABLE`, `AI_USAGE_LIMIT_REACHED`, `AI_USER_DAILY_LIMIT_REACHED`, `OPINION_DOCUMENT_MISSING`, `LEGAL_REVIEW_NOT_IN_PROGRESS`, `LEGAL_REVIEW_SEGREGATION` e `PERMISSION_DENIED`; as razões não revelam dado do processo a quem não pode ver a análise.
- **Herdadas, sem repetir:** pipeline, fila, limites e minimização (RN-AI-01..24, US-115 e US-116); aplicação seletiva, descarte e acompanhamento (RN-AI-25..32, US-117); `toConfirm`, `GroundingGuard`, proveniência e revisão (RN-AI-53..58, US-122); snapshot e rodadas (RN-LGL-09, RN-LGL-41, US-152).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Orientações | `instruction` | texto | Não | ≤ 500 caracteres, texto puro | em branco |
| Parecer | `documentId` | uuid | Sim | `PARECER_JURIDICO` da análise (RN-LGL-111) | editor do parecer |
| *(sistema)* Alvo | `targetModule`, `kind`, `promptKey` | enum, enum, texto | Sim | `LEGAL_OPINION`, `DRAFT`, `draft.legal_opinion` | fixos |
| Seções a aplicar | `sectionKeys` | lista de checkboxes | Sim (mín. 1) | chaves da proposta; `EMPTY` marcadas, `FILLED` desmarcadas; `CONCLUSION` sempre com selo "Decisão sua" | `EMPTY` marcadas |
| Substituir texto atual | `confirmReplaceFilled` | booleano | Condicional | obrigatório se marcar seção `FILLED`/`NOT_APPLICABLE` (RN-AI-28) | `false` |
| Versão do parecer | `If-Match` (ETag) | texto | Sim (DOC-26) | ETag do documento | `GET` do parecer |
| Chave de idempotência | `Idempotency-Key` | texto | Sim (AI-01, DOC-26) | 24 h | gerada pelo front |
| Seções a revisar | `sectionKeys`, `expectedRevisions`, `confirmAll` | lista, mapa, booleano | Sim (DOC-27) | como em US-122 | seção em foco ou todas as pendentes |
| *(saída)* Avisos | `warnings[].code` | enum | — | `USED_DRAFT_INPUTS`, `MISSING_OPTIONAL_INPUT`, `BUDGET_CONFIDENTIAL_VALUES_OMITTED`, `CONTEXT_TRUNCATED`, `CONCLUSIVE_LANGUAGE_REPLACED`, `INPUTS_OUTDATED` (derivado) | gerado |
| *(saída)* Entradas | `inputRefs[]` | lista | — | `kind` em `PROCESS`, `PROCESS_ITEMS`, `DOCUMENT_VERSION`, `BUDGET_ALLOCATIONS`, `TENDER`, `LEGAL_REVIEW`, `TEMPLATE_VERSION`, `USER_INSTRUCTION` | gerado |
| *(saída)* Contagens | `placeholdersCount`, `groundingReplacements` | inteiros | — | por seção e total | `GroundingGuard` |
| *(saída)* Pendências do parecer | `aiReviewPendingSections[]`, `aiPlaceholdersPending` | lista, inteiro | — | derivados do `draftContent` (RN-LGL-119) | LGL-02 |

**Seções do parecer e origem do conteúdo gerado** (chaves do template v2 do parecer; a confirmar na semente, ver lacunas):
| Seção | Chave | O que a IA escreve | Se faltar dado |
|---|---|---|---|
| Relatório | `REPORT` | Resumo do processo, do objeto e dos documentos analisados (tipo e versão do snapshot) | `[a confirmar: …]` por dado omisso |
| Fundamentação | `FOUNDATION` | Base legal do `legalBasis` do template e das entradas (art. 18, 53, 72 conforme o caso) | `[a confirmar: fundamento]` |
| Análise dos artefatos | `ANALYSIS` | Apontamentos descritivos por artefato (DFD, ETP, riscos, preços, TR, dotação, edital), sem juízo conclusivo | análise do artefato ausente: `[a confirmar: …]` |
| Ressalvas | `RESERVATIONS` | Pontos de atenção sugeridos como texto, sem criar ressalva | seção pode sair vazia (`EMPTY`) |
| Conclusão | `CONCLUSION` | Nada: só o marcador `[a confirmar: conclusão do parecer]` (`DECISION`) | sempre pendente |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `instruction` acima de 500 caracteres; `documentId` que não é o parecer da análise | Front + API (Zod) | "Revise as orientações e abra o parecer da análise." | `VALIDATION_ERROR` |
| V-02 | Pedido sem parecer criado | API | "Elabore o parecer antes de gerar o rascunho com IA." | `AI_PREREQUISITE_MISSING` (`OPINION_DOCUMENT`) |
| V-03 | Análise fora de `IN_REVIEW` | API | "A análise não está em andamento." | `LEGAL_REVIEW_INVALID_STATE` (409) |
| V-04 | Processo fora de `IN_PROGRESS` ou sem etapa `JURIDICO` ativa | API | "O processo não está disponível para análise no momento." | `INVALID_PROCESS_STATUS` (409) |
| V-05 | Parecer fora de `DRAFT` ou tipo não permitido na etapa | API | "O parecer não pode ser editado agora." | `DOCUMENT_NOT_EDITABLE` / `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-06 | Já existe geração ativa do parecer no processo | API | "Já há um rascunho do parecer sendo gerado." | `AI_GENERATION_IN_PROGRESS` |
| V-07 | IA desligada, provedor indisponível ou limite atingido | API | "A IA não está disponível agora." | `AI_DISABLED` / `AI_PROVIDER_UNAVAILABLE` / `AI_USAGE_LIMIT_REACHED` / `AI_USER_DAILY_LIMIT_REACHED` |
| V-08 | Seção preenchida marcada sem confirmação | Front + API | "Confirme a substituição do texto atual." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-09 | `sectionKeys` vazio ou fora da proposta; geração não `SUCCEEDED`, expirada ou de outro documento | Front + API | "Selecione seções de uma proposta ainda válida." | `VALIDATION_ERROR` / `AI_GENERATION_NOT_APPLICABLE` |
| V-10 | `If-Match` ausente ou divergente na aplicação | API | "O parecer foi alterado. Recarregue para continuar." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-11 | Usuário em conflito de segregação (POL-19) | API | "Você participou da elaboração deste processo e não pode usar a IA neste parecer." | `LEGAL_REVIEW_SEGREGATION` (403) |
| V-12 | Lote de revisão sem `confirmAll` ou revisão esperada divergente (DOC-27) | Front + API | "Confirme que leu e revisou as seções." / "A seção foi alterada. Leia a versão atual antes de revisar." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) / `VERSION_CONFLICT` |
| V-13 | Finalizar ou concluir com seção não revisada ou com `[a confirmar]` | API | "Revise o conteúdo gerado por IA e resolva os itens [a confirmar]." | `DOCUMENT_INCOMPLETE` |

## Permissões
- **Permissão:** `AI_GENERATE` mais `LEGAL_REVIEW_MANAGE` cobrindo o processo para gerar; `LEGAL_REVIEW_MANAGE` para aplicar (`DOC-26`) e revisar (`DOC-27`); `LEGAL_REVIEW_VIEW` para o painel e `PROCESS_VIEW` para consultar metadados da geração; `LEGAL_REVIEW_CONCLUDE` para escolher a situação (nunca a IA); `SETTINGS_MANAGE` para ligar a IA, definir limites e ver o consumo (SCR-041, `AI-06`).
- **Políticas:** POL-18 estendida a `LEGAL_OPINION` (revalidada no worker), POL-19 (segregação), POL-24 (rascunho restrito, inclusive a proposta), POL-02 (edição do parecer: `DRAFT`, tipo permitido na etapa, processo editável), POL-09 e DEC-030 (sigilo no contexto), DEC-024 (visibilidade).
- **MFA:** não exigido (`AI_GENERATE` e `LEGAL_REVIEW_MANAGE` são risco `M`), salvo `security.mfaPolicy = ALL`; a conclusão (`LEGAL_REVIEW_CONCLUDE`, `H`) é da US-155.
- **Sem permissão:** "Gerar rascunho com IA" fica oculto sem `AI_GENERATE` e desabilitado com o motivo em conflito de POL-19 ou análise fora de `IN_REVIEW`; a API responde 403 `PERMISSION_DENIED`, `LEGAL_REVIEW_SEGREGATION` ou `AI_GENERATION_NOT_OWNED` e grava `access.denied`; análise ou parecer de outro tenant, ou de processo invisível, responde 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `AiGenerationRequested` | `ai.generation_requested` | Commit de `AI-01` | `targetModule = LEGAL_OPINION`, `kind = DRAFT`; sem conteúdo |
| `AiGenerationCompleted` | `ai.generation_completed` | Worker grava `SUCCEEDED` | modelo, `promptKey = draft.legal_opinion`, `promptVersion`, tokens, `sectionsCount`, `placeholdersCount`; projeta `AI_CONTENT_GENERATED` |
| `AiGenerationFailed` | `ai.generation_failed` | Worker grava `FAILED` | `errorCode` (inclusive `OUTPUT_INVALID`), `attempts` |
| `AiContentApplied` | `document.ai_content_applied.parecer_juridico` | Commit de `DOC-26` | `sectionKeys[]`, `replacedFilledSections`; projeta `AI_CONTENT_APPLIED` (sem notificação) |
| `DocumentVersionCreated` | `document.version_created.parecer_juridico` | Mesmo commit, se substituir seção preenchida | `reason = SYSTEM` |
| `AiContentReviewed` | `document.ai_content_reviewed.parecer_juridico` | Commit de `DOC-27` | `sectionKeys[]`, `generationIds[]`; projeta `AI_CONTENT_REVIEWED` |
| `AiUsageThresholdReached` | `ai.usage_threshold_reached` | Consumo cruza 80% e 100% do mês | por órgão; notifica `SETTINGS_MANAGE` (US-116) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `AI_GENERATION_READY` | solicitante | in-app | geração `SUCCEEDED`; link para o parecer com `?ia=<id>` |
| `AI_GENERATION_FAILED` | solicitante | in-app | geração `FAILED` após as tentativas |
| `AI_USAGE_LIMIT_WARNING` | quem tem `SETTINGS_MANAGE` | in-app + e-mail | `AiUsageThresholdReached` (tipo do MVP 1, inalterado) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerar o rascunho do parecer jurídico com IA

  Background:
    Given que o tenant "Prefeitura A" está ativo com "ai.enabled" igual a "true"
    And o provedor de IA de teste responde com a fixture "draft.legal_opinion"
    And o processo "0045/2026" está "IN_PROGRESS" na etapa "JURIDICO"
    And a análise jurídica "LR-0045" está "IN_REVIEW" na rodada 1, designada a "Dr. André Nunes"
    And o snapshot da rodada 1 tem DFD v2, ETP v3, mapa de riscos v1, pesquisa de preços v2, TR v4 e edital v1
    And a dotação do processo está confirmada com cobertura "COVERED" e a minuta do edital existe
    And o parecer "PJ 0007/2026" está em "DRAFT" com as seções "REPORT", "FOUNDATION", "ANALYSIS", "RESERVATIONS" e "CONCLUSION" vazias
    And "Dr. André Nunes" tem vínculo ativo no perfil "JURIDICO", com "AI_GENERATE", "LEGAL_REVIEW_MANAGE" e "LEGAL_REVIEW_CONCLUDE", e não participou da elaboração
    And "Carla Mendes", da "Secretaria de Obras", criou o processo e é autora do TR

  Scenario: [Sucesso] Gerar o rascunho do parecer sem sugerir a conclusão
    When "Dr. André Nunes" solicitar o rascunho do parecer com IA com a chave "K1"
    Then a API deve responder 202 e a geração deve ficar "QUEUED" com "targetModule" "LEGAL_OPINION" e "promptKey" "draft.legal_opinion"
    And deve gerar a auditoria "ai.generation_request" e o evento "AiGenerationRequested"
    When o worker processar a geração
    Then a geração deve ficar "SUCCEEDED" com "inputRefs" das 6 versões do snapshot, da dotação, do edital, da análise e do template
    And a proposta deve ter as 5 seções e a seção "CONCLUSION" deve conter só "[a confirmar: conclusão do parecer]" da categoria "DECISION"
    And deve gerar o evento "AiGenerationCompleted" e a notificação "AI_GENERATION_READY"
    And o parecer e a análise "LR-0045" não devem ser alterados

  Scenario: [Sucesso] Aplicar todas as seções mantém a situação e a ementa em aberto
    Given que a geração está "SUCCEEDED" e foi solicitada por "Dr. André Nunes"
    When "Dr. André Nunes" aplicar todas as seções com o "If-Match" atual
    Then a API deve responder 200 com as 5 seções aplicadas e a geração "APPLIED"
    And cada seção deve ficar "Gerado por IA — revisão pendente" e "CONCLUSION" deve conter apenas "[a confirmar]"
    And a análise "LR-0045" deve continuar "IN_REVIEW", sem "conclusionSummary" e sem ressalvas novas
    And deve gerar a auditoria "ai.content_apply" e o evento "AiContentApplied"
    And o painel deve exibir "5 seções do parecer aguardam revisão"

  Scenario: [Sucesso] Nada inventado, sigilo e referências só das entradas
    Given que o orçamento é sigiloso e a pesquisa de preços v2 não tem prazo de validade informado
    And o provedor de teste escreve "R$ 480.000,00", "validade de 90 dias" e "ETP v9" na análise dos artefatos
    When o worker concluir a geração
    Then o contexto enviado ao provedor de teste não deve conter valores monetários do processo nem da dotação
    And a proposta deve trazer "BUDGET_CONFIDENTIAL_VALUES_OMITTED"
    And "R$ 480.000,00", "90 dias" e "ETP v9" devem virar "[a confirmar]" e "groundingReplacements" deve ser maior que 0
    And as citações "art. 53" e "art. 23" presentes no template devem ser preservadas

  Scenario: [Sucesso] Fórmula conclusiva fora da conclusão vira pendência de decisão
    Given que o provedor de teste escreve "opino pela regularidade da contratação" em "FOUNDATION"
    When o worker concluir a geração
    Then a frase deve virar "[a confirmar]" da categoria "DECISION" e a proposta deve trazer "CONCLUSIVE_LANGUAGE_REPLACED"

  Scenario: [Sucesso] Insumo em rascunho e entradas ausentes geram avisos
    Given que o TR v4 foi salvo como rascunho e o processo não tem pesquisa de preços concluída
    When o worker concluir a geração
    Then a proposta deve trazer "USED_DRAFT_INPUTS" com "TR" e "MISSING_OPTIONAL_INPUT" com "PRICE_RESEARCH"
    And a análise da pesquisa de preços deve sair como "[a confirmar: pesquisa de preços]"

  Scenario: [Sucesso] Retomada na rodada 2 usa as diligências e avisa propostas antigas
    Given que a análise teve diligência sobre o TR e voltou em nova rodada 2 com o TR v5 no snapshot
    And existe uma proposta "SUCCEEDED" não aplicada da rodada 1
    When "Dr. André Nunes" abrir a proposta antiga
    Then a resposta deve trazer o aviso "INPUTS_OUTDATED" com o tipo "TR" e a recomendação de gerar de novo
    When "Dr. André Nunes" gerar uma nova proposta
    Then os "inputRefs" devem incluir a diligência e a resposta da rodada 1 e o TR v5
    And as seções "FILLED" devem vir desmarcadas com o aviso de substituição

  Scenario: [Sucesso] Revisar todas as seções, finalizar e concluir com a situação escolhida
    Given que as 5 seções foram aplicadas e todas as pendências "[a confirmar]" foram resolvidas, inclusive a conclusão redigida por "Dr. André Nunes"
    When "Dr. André Nunes" marcar todas as seções como revisadas com "confirmAll" igual a "true"
    Then a API deve responder 200 e deve gerar o evento "AiContentReviewed" com as 5 chaves
    When "Dr. André Nunes" finalizar o parecer e concluir a análise com a situação "FAVORABLE_WITH_RESERVATIONS" e a ementa
    Then a análise deve ficar "FAVORABLE_WITH_RESERVATIONS" com a situação escolhida por ele e nenhuma situação proposta pela IA

  Scenario: [Validação] Parecer não criado, análise fora de andamento e conclusão pendente
    Given que o parecer ainda não foi criado
    When "Dr. André Nunes" solicitar o rascunho com IA sem "documentId"
    Then a API deve responder 422 com código "AI_PREREQUISITE_MISSING" e "meta.missing" igual a ["OPINION_DOCUMENT"] e nenhuma geração deve ser registrada
    Given que a análise "LR-0045" está em "DILIGENCE"
    When "Dr. André Nunes" solicitar o rascunho
    Then a API deve responder 409 com código "LEGAL_REVIEW_INVALID_STATE"
    Given que o parecer tem a seção "ANALYSIS" gerada por IA sem revisão e a seção "CONCLUSION" com "[a confirmar]"
    When "Dr. André Nunes" tentar finalizar o parecer
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE" e as violações "SECTION_AI_REVIEW_PENDING" e "SECTION_PLACEHOLDER_PENDING"
    And o parecer deve continuar "DRAFT"

  Scenario: [Validação] Substituição sem confirmação e limite de uso atingido
    Given que a seção "REPORT" já está preenchida pelo procurador
    When "Dr. André Nunes" aplicar "REPORT" sem "confirmReplaceFilled"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" e o parecer não deve ser alterado
    Given que o limite mensal de tokens do órgão foi atingido
    When "Dr. André Nunes" solicitar o rascunho
    Then a API deve responder 422 com código "AI_USAGE_LIMIT_REACHED" e nenhuma geração deve ser registrada

  Scenario: [Permissão] Sem LEGAL_REVIEW_MANAGE, segregação, IA desligada e leitura restrita
    Given que "Bruno Lopes" tem "AI_GENERATE" mas não tem "LEGAL_REVIEW_MANAGE"
    When "Bruno Lopes" solicitar o rascunho do parecer
    Then a API deve responder 403 com código "PERMISSION_DENIED", gerar a auditoria "access.denied" e não chamar o provedor de IA
    Given que "Carla Mendes" também tem o perfil "JURIDICO" com "AI_GENERATE" e "LEGAL_REVIEW_MANAGE"
    When "Carla Mendes" solicitar o rascunho do parecer
    Then a API deve responder 403 com código "LEGAL_REVIEW_SEGREGATION"
    Given que "Dra. Helena Prado", com "LEGAL_REVIEW_MANAGE", tenta aplicar a geração solicitada por "Dr. André Nunes"
    Then a API deve responder 403 com código "AI_GENERATION_NOT_OWNED"
    Given que "Carla Mendes" tem "PROCESS_VIEW" e consulta a geração pela API
    When "Carla Mendes" chamar "GET /ai-generations/{id}"
    Then a resposta deve trazer apenas os metadados, sem "output", "warnings" nem "inputRefs"
    Given que a IA foi desligada no órgão
    When "Dr. André Nunes" solicitar o rascunho
    Then a API deve responder 403 com código "AI_DISABLED"

  Scenario: [Tenant incorreto] Parecer e geração de outro órgão
    Given que o parecer "PJ 0003/2026" e uma geração pertencem ao tenant "Prefeitura B"
    When "Dr. André Nunes", da "Prefeitura A", solicitar o rascunho para esse parecer ou consultar essa geração
    Then a API deve responder 404 nas duas chamadas
    And o contexto de nenhuma geração deve conter dado da "Prefeitura B"

  Scenario: [Duplicidade] Reenvio com a mesma chave e geração ativa
    Given que "Dr. André Nunes" solicitou o rascunho com a chave "K1" e recebeu 202
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 202 com "Idempotent-Replayed: true" e existir uma única geração
    When "Dr. André Nunes" solicitar com a chave "K2" enquanto a geração está ativa
    Then a API deve responder 409 com código "AI_GENERATION_IN_PROGRESS" e "meta.generationId" da geração ativa
    When "Dr. André Nunes" reenviar a aplicação já concluída com a mesma chave
    Then a API deve responder 200 com o mesmo resultado e existir um único evento "AiContentApplied"

  Scenario: [Concorrência] Parecer editado entre a proposta e a aplicação
    Given que "Dr. André Nunes" abriu a proposta com o parecer na versão 3
    When "Dra. Helena Prado" salvar a seção "FOUNDATION", gerando a versão 4, e "Dr. André Nunes" aplicar com "If-Match: \"3\""
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    When "Dr. André Nunes" recarregar o parecer e aplicar "FOUNDATION" sem "confirmReplaceFilled"
    Then a API deve responder 422 com erro "CONDITIONAL_REQUIRED" e o texto de "Dra. Helena Prado" deve ser preservado
    And duas aplicações simultâneas da mesma geração devem resultar em uma sucesso e a outra 409 "AI_GENERATION_NOT_APPLICABLE"
    Given que "Carla Mendes" salva o TR v5 durante a geração
    Then a geração deve usar o TR v4 do snapshot e a proposta deve trazer "INPUTS_OUTDATED" com "TR"

  Scenario: [Falha de banco] Banco indisponível durante a aplicação
    Given que o banco de dados fica indisponível durante a transação de aplicação
    When "Dr. André Nunes" aplicar as seções selecionadas
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhuma seção deve ser alterada, a geração deve continuar "SUCCEEDED" e nenhum evento ou auditoria deve ser gravado

  Scenario: [Falha de integração] Provedor limitado, indisponível ou com saída conclusiva
    Given que o provedor de IA de teste responde 429 na primeira tentativa e sucesso na segunda
    When o worker processar a geração
    Then a geração deve ficar "SUCCEEDED" com "attempts" igual a 2
    Given que o provedor responde 503 nas 3 tentativas
    Then a geração deve ficar "FAILED" com "errorCode" "PROVIDER_UNAVAILABLE", "Dr. André Nunes" deve receber "AI_GENERATION_FAILED" e o parecer não deve ser alterado
    Given que o provedor devolve a situação "FAVORABLE" ou texto conclusivo na seção "CONCLUSION", mesmo após o reparo
    Then a geração deve ficar "FAILED" com "errorCode" "OUTPUT_INVALID" e nenhum "output" deve ser gravado

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Dr. André Nunes" aplicar a proposta com sucesso
    Then as seções devem ser atualizadas e a API deve responder 200
    And o evento "AiContentApplied" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Parecer não criado | 422 | `AI_PREREQUISITE_MISSING` | "Elabore o parecer antes de gerar o rascunho com IA." | Atalho para elaborar o parecer |
| Orientação ou `documentId` inválidos | 422 | `VALIDATION_ERROR` | "Revise as orientações e abra o parecer da análise." | Marca o campo |
| Análise fora de `IN_REVIEW` | 409 | `LEGAL_REVIEW_INVALID_STATE` | "A análise não está em andamento." | Oculta a ação com o motivo |
| Processo fora de `IN_PROGRESS` ou sem etapa `JURIDICO` | 409 | `INVALID_PROCESS_STATUS` | "O processo não está disponível para análise no momento." | Desabilita a ação |
| Parecer não editável / etapa | 409 / 422 | `DOCUMENT_NOT_EDITABLE` / `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O parecer não pode ser editado agora." | Oculta a ação |
| Geração ativa | 409 | `AI_GENERATION_IN_PROGRESS` | "Já há um rascunho do parecer sendo gerado." | Abre a geração ativa |
| IA desligada, provedor indisponível ou limite | 403 / 503 / 422 | `AI_DISABLED` / `AI_PROVIDER_UNAVAILABLE` / `AI_USAGE_LIMIT_REACHED` / `AI_USER_DAILY_LIMIT_REACHED` | "A IA não está disponível agora." | Ação desabilitada com explicação; respeita `Retry-After` |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerar conteúdo com IA neste parecer." | Botão oculto |
| Segregação | 403 | `LEGAL_REVIEW_SEGREGATION` | "Você participou da elaboração deste processo e não pode usar a IA neste parecer." | Oculta a ação e explica na dica |
| Geração de outro usuário | 403 | `AI_GENERATION_NOT_OWNED` | "Só quem pediu a geração pode aplicá-la." | Painel somente leitura |
| Geração, parecer ou análise inexistentes / de outro tenant | 404 | `AI_GENERATION_NOT_FOUND` / `LEGAL_REVIEW_NOT_FOUND` / `NOT_FOUND` | "Registro não encontrado." | Fecha o painel |
| Proposta não aplicável | 409 | `AI_GENERATION_NOT_APPLICABLE` | "Esta proposta não pode mais ser aplicada." | Oferece nova geração |
| Falta confirmar substituição | 422 | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) | "Confirme a substituição do texto atual." | Destaca a seção |
| `If-Match` ausente / divergente | 428 / 412 | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` | "O parecer foi alterado. Recarregue para continuar." | Oferece "Ver versão atual" |
| Seção não revisada ou com pendência ao finalizar/concluir | 422 | `DOCUMENT_INCOMPLETE` | "Revise o conteúdo gerado por IA e resolva os itens [a confirmar]." | Lista as seções com link |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente." | Mantém a seleção; respeita `Retry-After` |
| Falha da geração (assíncrona) | — | `errorCode` `TIMEOUT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`, `CONTENT_FILTERED`, `CONTEXT_TOO_LARGE`, `OUTPUT_INVALID`, `CANCELED_BY_POLICY` | "Não foi possível gerar o rascunho." | Estado "falhou" com "Tentar de novo" |

## Dependências
- **Stories:** US-115 (camada de IA, `AiGeneration`, pipeline e `GroundingGuard` plugável), US-116 (ativação, limites, `AI-05`/`AI-06`, `AI_GENERATE`), US-122 (`toConfirm`, `GroundingGuard`, proveniência e revisão `DOC-27`), US-154 (documento `PARECER_JURIDICO`, template, seções e edição pelo procurador; LGL-20). Indiretas: US-117 (fluxo genérico de solicitar, acompanhar, aplicar e descartar, painel `SCR-117`), US-152 (snapshot da rodada, fonte do contexto), US-153 (diligências e rodadas), US-155 (conclusão que revalida a revisão), US-146/US-147 (dotação confirmada), EP-027 (minuta do edital, `Tender`), US-110 (template do parecer).
- **Decisões/ADRs:** DEC-030, DEC-037, DEC-079, DEC-196, DEC-199, DEC-202, DEC-203; ADR-013 (PEND-21, provedor real; `FakeAiProvider` até lá).
- **Configurações:** `ai.enabled`, `ai.termsAcceptedVersion`, `ai.monthlyTokenLimit`, `ai.userDailyRequestLimit`; plataforma `AI_PROVIDER` e `AI_MODEL_DRAFT`.
- **Lacunas nas fontes canônicas:**
  1. **Chaves das seções do parecer:** o template v2 (entities.md §9) lista relatório, fundamentação, análise dos artefatos, ressalvas e conclusão, sem as chaves; a US-155 usa `ANALYSIS` e a feature usa `CONCLUSION`. A story adota `REPORT`, `FOUNDATION`, `ANALYSIS`, `RESERVATIONS`, `CONCLUSION`, com `CONCLUSION` como chave reservada; confirmar na semente (US-110/US-154) e impedir, na validação de template (US-107), um parecer sem `CONCLUSION` ou com outra seção usando essa chave.
  2. **Fonte das entradas:** a feature diz "versões vigentes"; a story usa as versões do **snapshot da rodada** (RN-LGL-09), que coincidem com as vigentes no início e divergem só se um documento mudar depois (aviso `INPUTS_OUTDATED`). **Dúvida de produto:** bloquear a aplicação quando a rodada mudou, em vez de só avisar.
  3. **Permissões de aplicar e revisar:** a feature cita `AI_GENERATE` e `LEGAL_REVIEW_MANAGE` para "solicitar, aplicar e revisar"; a story segue a US-117/US-122 (aplicar e revisar só com a permissão de edição do tipo, `LEGAL_REVIEW_MANAGE`), para a revisão não depender de a IA estar ligada.
  4. **Avisos e campos novos:** `CONCLUSIVE_LANGUAGE_REPLACED`, `INPUTS_OUTDATED` (derivado), `OPINION_DOCUMENT` em `missing`, as razões de `AI-05` (`OPINION_DOCUMENT_MISSING`, `LEGAL_REVIEW_NOT_IN_PROGRESS`, `LEGAL_REVIEW_SEGREGATION`) e os campos aditivos `aiReviewPendingSections`/`aiPlaceholdersPending` em LGL-02 não constam em `events.md`, `permissions.md` nem no catálogo de API; consolidar no card 9.
  5. **Visibilidade restrita de AI-02/AI-03 para `LEGAL_OPINION`** (RN-LGL-121) é decisão desta story para cumprir a POL-24; hoje AI-02 exige só `PROCESS_VIEW`. Confirmar com a segurança.
  6. **Estimativa de tokens do alvo `LEGAL_OPINION`:** a DEC-203 manda calibrar como os demais (DFD 15 mil, ETP 40 mil, TR 40 mil); a story propõe 60 mil por causa da cadeia de até 7 documentos, a calibrar no endurecimento. **Dúvida de produto:** limite de contexto e prioridade de truncamento (ordem sugerida: diligências, dotação, edital, TR, preços, riscos, ETP, DFD).
  7. **Padrões de linguagem conclusiva e conjunto de artigos aceitos** (RN-LGL-116/RN-LGL-118) não estão em fonte canônica; ficam na biblioteca versionada do prompt e precisam de validação do jurídico do piloto (a validar). **Dúvida de produto:** lista de artigos aceitos por tipo de contratação (art. 72 só em contratação direta).
  8. **Pasta do prompt:** a feature cita `prompts/legal_opinion/`; a DEC-202 e o padrão do MVP 1 usam `prompts/<promptKey>/`, ou seja, `prompts/draft.legal_opinion/`. A story segue a DEC-202.
  9. **Tipos de notificação:** não há tipo novo; usam-se `AI_GENERATION_READY`, `AI_GENERATION_FAILED` e `AI_USAGE_LIMIT_WARNING` do MVP 1 (events.md do MVP 2 declara os eventos `AiGeneration*` e `AiContent*` inalterados).

## Impacto técnico
- O gerador `LegalOpinionDraftGenerator` monta um conjunto de fatos normalizado (`LegalOpinionDraftContext`) que alimenta o prompt e o `GroundingGuard`; a lista de artefatos e versões nasce do snapshot e dos campos tipados, nunca do modelo. O contexto pode ser grande (até sete documentos): o gerador resume cada documento em fatos e trechos relevantes e reduz por prioridade, emitindo `CONTEXT_TRUNCATED` ou terminando `FAILED`/`CONTEXT_TOO_LARGE`.
- O prompt `draft.legal_opinion` é versionado em `apps/api/src/modules/ai/prompts/draft.legal_opinion/`; mudar o texto exige nova `promptVersion` e o `pnpm ai:eval` passa a incluir o conjunto "a IA nunca conclui" (fixtures que tentam induzir favorável, desfavorável e ressalvas decididas), parecer sem dotação, sem edital, com orçamento sigiloso, em retomada, e o teste de propriedade "nenhuma saída gravada traz situação conclusiva". Metas p95 de 90 s (rascunho) e 1 s (`AI-01`) vão para a suíte de performance, medidas no endurecimento.
- Sem tabela nova: reaproveita `AiGeneration` (check de `targetModule` ampliado em M2, entities.md §5.12), `Document.draftContent` e `AiSuggestionSource`; o único parcial de geração ativa cobre a RN-AI-12 para `LEGAL_OPINION`. Regra D9: o módulo `ai` só lê `legal-review`, `budget`, `tender`, `document` e `process` por fachadas de leitura (`ai-read-only`); a aplicação é comando de `document` e a leitura de `legal-review` expõe só `getRoundContext(legalReviewId)`.
- O `GroundingGuard` ganha dois detectores (conclusão e fundamento) no gancho de pós-processamento da US-115, antes da checagem de `maxChars`; continua puro, determinístico e idempotente.
- Restrição POL-24: a projeção de `AI-02`/`AI-03` omite `output` para quem não tem `LEGAL_REVIEW_MANAGE` cobrindo o processo nem `AUDIT_VIEW`; o painel de pendências de revisão é derivado em memória do `draftContent` já carregado em LGL-02.
- Compatibilidade: nenhum contrato do MVP 1 muda; `AI-01`, `AI-02`, `AI-04`, `AI-05`, `AI-06`, `DOC-26` e `DOC-27` ganham apenas o alvo e o tipo de documento novos, com `eventVersion = 1` nos eventos especializados `document.*.parecer_juridico`.
- Sigilo: contexto, log, evento e auditoria sem valores de orçamento sigiloso e sem texto do parecer (DEC-030).

## Backend
- **Módulo(s):** `ai` (gerador, geração, `GroundingGuard`), `document` (aplicação `DOC-26`, revisão `DOC-27`, completude e proveniência), `legal-review` (fachada de leitura da rodada, snapshot e diligências; indicador de pendências em LGL-02), `budget` e `tender` (fachadas de leitura), `process`, `catalog`, `tenancy`, `access`, `timeline`, `notification`, `audit`, `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `LegalOpinionDraftGenerator`, registrado no registro de geradores da US-115 para `LEGAL_OPINION`/`DRAFT` (valida pré-requisitos, monta o contexto, renderiza o prompt, mapeia a saída, trata `CONCLUSION`); `AI-01`, `AI-02`, `AI-04`, `DOC-26` e `DOC-27` são os comandos genéricos das US-115, US-117 e US-122, com a política de visibilidade de `LEGAL_OPINION` na projeção de leitura.
- **Domínio e integrações:** `LegalOpinionDraftContext` (fatos, `inputRefs`, avisos), `LegalOpinionSourceResolver` (snapshot da rodada, `statusAtCreation`), `ConclusionGuard` e `ConclusiveLanguageDetector` (RN-LGL-115/RN-LGL-116), `LegalBasisGuard` (RN-LGL-118), `AiProvider` (`FakeAiProvider` em dev/test/CI), `AuthorizationService.assertCan('AI_GENERATE', { processId })` com `LegalReviewSegregationPolicy` (compartilhada com US-152/US-155), `AiSuggestionSource.loadForApply`/`markApplied`, `OpinionPendingReviewProjector`.
- **Transação:** `AI-01` grava geração, reserva de tokens, auditoria e outbox numa transação e enfileira após o commit; o worker lê em transação do tenant, chama o provedor fora dela e grava a proposta em transação curta; `DOC-26` aplica seções, versão condicional, `markApplied`, auditoria e outbox numa única transação, sem tocar a `LegalReview`.

## Frontend
- **Tela(s):** SCR-019 (`/juridico/[reviewId]`, editor do parecer e indicação de seções pendentes de revisão) com o painel `SCR-117` (`?ia=<generationId>`); SCR-041 (seção "Inteligência artificial": limites e consumo, inclusive do gerador novo).
- **Componentes:** `AiDraftButton`, `AiAssistantPanel`, `AiRequestForm` (entradas por tipo e versão, avisos de insumo rascunho, aviso fixo sobre a conclusão, consumo estimado), `AiGenerationProgress`, `AiProposalSectionList` (selo "Decisão sua" na conclusão), `AiSectionDiffView`, `AiDisclaimer`; após aplicar, `AiGeneratedBadge`, `ToConfirmChip`, `MarkReviewedButton` e `ReviewAllDialog` (US-122); `OpinionReviewPendingBanner` no painel da análise.
- **Estados:** carregando a disponibilidade (skeleton); formulário; gerando (cancelável); proposta pronta; aplicada; falhou (`errorCode` traduzido); vazio (sem parecer, com atalho); desabilitado com explicação; somente leitura para quem não é o solicitante; sem acesso ao conteúdo para quem não é do jurídico.
- **Acessibilidade e responsividade:** progresso anunciado por `aria-live`; foco movido ao painel e devolvido ao botão; checkboxes e diff por teclado; selos de IA, de revisão e de decisão com texto e ícone, nunca só cor; `ToConfirmChip` com `aria-label` "Pendência a confirmar: {label}"; abaixo de 768 px o painel ocupa a tela e o diff vira abas "Atual" / "Sugerido"; contraste AA nos temas claro e escuro.

## Banco de dados
- **Tabelas:** `ai_generations` (insert/update de status; `target_module = 'LEGAL_OPINION'`), `documents` (`draft_content`, `draft_revision`), `document_versions` (insert condicional), `audit_logs`, `outbox_events`, `timeline_entries`, `notifications`; `legal_reviews`, `legal_review_documents`, `legal_review_diligences`, `budget_allocations`, `tenders` apenas lidas.
- **Migrações e índices:** nenhuma além da ampliação do check de `target_module` e de `AiInputRef.kind` já prevista na M2 (entities.md §5.12); único parcial `(tenant_id, process_id, target_module) WHERE kind = 'DRAFT' AND status IN ('QUEUED','RUNNING')` já cobre a RN-AI-12; RLS por `tenant_id` em todo o contexto.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `AI-01` | POST | `/api/v1/processes/{id}/ai-generations` | `{ targetModule: 'LEGAL_OPINION', documentId, kind: 'DRAFT', instruction? }` + `Idempotency-Key` | `202 { data: AiGeneration, meta: { pollAfterMs } }` + `Location` | 202, 401, 403, 404, 409, 422, 429, 503 |
| `AI-02` | GET | `/api/v1/ai-generations/{generationId}` | — | `200 { data: AiGeneration }` (com `output`, `warnings`, `inputRefs` só para quem tem `LEGAL_REVIEW_MANAGE`/`AUDIT_VIEW`; `INPUTS_OUTDATED` derivado) | 200, 403, 404 |
| `AI-04` | POST | `/api/v1/ai-generations/{generationId}/discard` | — | `200` | 200, 403, 404, 409 |
| `AI-05` | GET | `/api/v1/ai/availability?processId=&documentId=` | — | `200 { enabled, canGenerate, reasons[] }` (RN-LGL-124) | 200, 401 |
| `AI-06` | GET | `/api/v1/ai/usage?month=` | `SETTINGS_MANAGE` | consumo por gerador, documento e usuário, com `draft.legal_opinion` | 200, 403 |
| `DOC-26` | POST | `/api/v1/documents/{id}/ai-apply` | `{ generationId, sectionKeys, confirmReplaceFilled? }` + `If-Match` + `Idempotency-Key` | `200 { data: { document, appliedSectionKeys, versionCreated } }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `DOC-27` | POST | `/api/v1/documents/{id}/ai-review` | `{ sectionKeys, expectedRevisions, confirmAll? }` | `200 { data: { document, reviewedSectionKeys } }` | 200, 403, 404, 409, 412, 422, 503 |
| `LGL-02` | GET | `/api/v1/legal-reviews/{id}` | — (US-149) | painel; ganha `aiReviewPendingSections[]` e `aiPlaceholdersPending` | 200, 401, 403, 404 |

## Logs
- `info` `ai.generation_requested` e `ai.generation_completed` — `generationId`, `processId`, `legalReviewId`, `round`, `targetModule`, `promptKey`, `promptVersion`, tokens, `latencyMs`, `placeholdersCount`, `groundingReplacements`; `info` `ai.content_applied` — `generationId`, `sectionKeys`; `info` `ai.content_reviewed` — `documentId`, `sectionsCount`.
- `warn` `ai.prerequisite_missing` (`missing`), `ai.conclusive_language_replaced` (contagem) e `idempotency.store_unavailable`; `error` `ai.generation_failed` — `errorCode`, `attempts`, `correlationId`; `error` `ai.conclusion_guard_rejected` — `generationId`, motivo resumido (campo de situação ou texto na conclusão), sem o texto.
- **Nunca logar:** orientações, contexto enviado, saída do modelo, texto de seções ou de diligências, valores do processo, nomes de pessoas ou fornecedores.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `ai.generation_request` | `DATA_CHANGE` | Commit de `AI-01` | `metadata`: `generationId`, `targetModule = LEGAL_OPINION`, `kind`, `promptKey`, `promptVersion`, `legalReviewId`, `round` |
| `ai.generation_complete` / `ai.generation_fail` | `SYSTEM` | Fim da geração | `metadata`: `model`, `inputRefs` (ids, versões, hashes), `contextHash`, `outputHash`, tokens, `costUsd`, `errorCode`; nunca texto |
| `ai.content_apply` / `ai.generation_discard` | `DATA_CHANGE` | `DOC-26` / `AI-04` | `changes`: chaves das seções; `metadata`: `generationId`, `replacedFilledSections`, `outdatedInputs` (tipos), `idempotencyKey` |
| `ai.content_review` | `DATA_CHANGE` | `DOC-27` | `changes`: `reviewedAt` das seções; `metadata`: `documentId`, `targetModule`, `sectionKeys`, `generationIds`, `confirmAll` |
| `access.denied` | `ACCESS` | Tentativa sem permissão ou em conflito de POL-19 | `reasonCode` = `AI_GENERATE`, `LEGAL_REVIEW_MANAGE` ou `LEGAL_REVIEW_SEGREGATION` |

## Testes necessários
- **Unitários:** `LegalOpinionDraftContext` e `ContextSanitizer` (sem pessoas, fornecedores nem valores sigilosos; dotação só com cobertura categórica; diligências sem dado pessoal); fonte pelo snapshot da rodada e `statusAtCreation`; prompt `draft.legal_opinion` com fixtures (insumo presente × ausente × rascunho); `ConclusionGuard` (campo de situação, texto na conclusão, marcador único); `ConclusiveLanguageDetector` (fórmulas conclusivas × frases descritivas); `LegalBasisGuard`; `GroundingGuard` com valor, prazo, data e versão inventados e citação legal preservada; derivação de `INPUTS_OUTDATED` e de `aiReviewPendingSections`.
- **Integração (Testcontainers PostgreSQL + Redis):** worker ponta a ponta com `FakeAiProvider` (sucesso, 429 com nova tentativa, 503, `OUTPUT_INVALID` por conclusão, cancelamento por política); aplicação sem alterar `legal_reviews`; versão `SYSTEM` condicional; revisão e bloqueio de DOC-10 e LGL-19; outbox e timeline na mesma transação; RLS; projeção restrita de AI-02 por papel.
- **API/contrato:** `AI-01`, `AI-02`, `AI-04`, `AI-05`, `AI-06`, `DOC-26`, `DOC-27` e o acréscimo de LGL-02 conforme o api.md (`Location`, `Idempotent-Replayed`, `If-Match`); contrato do `FakeAiProvider` com o prompt novo.
- **RBAC e multi-tenant:** `AI_GENERATE` × `LEGAL_REVIEW_MANAGE` × POL-19 × POL-24 por perfil e escopo (`CONTROLE_INTERNO` e `CONSULTOR_EXTERNO` sem geração); parecer e geração de outro tenant → 404; teste novo na suíte `test/tenant-leak` (contexto da geração sem dados de outro tenant; `AI-02` sem texto para quem não é do jurídico).
- **Concorrência:** duas solicitações simultâneas (202 e 409); duas aplicações da mesma geração; edição do parecer entre proposta e aplicação (412); seção preenchida depois da proposta (422); novo documento durante a geração.
- **E2E (Playwright):** análise iniciada → elaborar parecer → gerar com `FakeAiProvider` → aplicar todas as seções → conclusão sempre `[a confirmar]` → tentar finalizar (bloqueado) → resolver pendências e revisar → finalizar → concluir escolhendo a situação.
- **Acessibilidade/performance:** axe sem violações sérias no painel, no diff e nos selos; 360 px; p95 de `AI-01` ≤ 1 s e do rascunho ≤ 90 s na suíte de performance (medidos no endurecimento); `pnpm ai:eval` com o conjunto de conclusão.

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
- [ ] Testes provam que a IA nunca propõe a conclusão (seção `CONCLUSION` sempre `toConfirm` `DECISION`, saída com situação rejeitada) e que aplicar texto não altera `LegalReview.status`
- [ ] Prompt `draft.legal_opinion` versionado e coberto pelo `pnpm ai:eval`, sem chamada ao provedor dentro de transação e sem valores sigilosos no contexto
- [ ] Parecer com texto de IA não finalizável nem concluível sem a revisão humana por seção (DOC-10 e LGL-19)

## Estimativa
**L** — o pipeline, a fila, o painel e a aplicação existem (US-115, US-117, US-122); o esforço está no gerador de cadeia longa (sete tipos de documento, dotação, edital e diligências, com contexto grande e truncamento), nas travas da conclusão (`ConclusionGuard`, detector de linguagem conclusiva, fundamento), na fonte pelo snapshot da rodada, na visibilidade restrita da proposta (POL-24) e na bateria de avaliação "a IA nunca conclui".

## Prioridade
**P1** — acelera a redação do parecer (art. 53 da Lei 14.133/2021) com os limites da DEC-202, mas o fluxo manual do parecer (US-154) segue completo sem a IA, como no EP-020.

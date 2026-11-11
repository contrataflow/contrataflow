---
id: US-169
title: "Gerar o rascunho do edital com IA"
epic: EP-027
feature: FT-079
mvp: 2
priority: P1
estimate: L
status: Especificada
depends_on: [US-115, US-116, US-122, US-164]
modules: [ai, document, tender, term, price-research, risk, process, tenancy, access, catalog, timeline, notification, audit, platform]
screens: [SCR-021, SCR-117, SCR-041]
endpoints: [AI-01, AI-02, AI-04, AI-05, AI-06, DOC-08, DOC-26, DOC-27]
permissions: [AI_GENERATE, TENDER_UPDATE, PROCESS_VIEW, SETTINGS_MANAGE]
events: [AiGenerationRequested, AiGenerationCompleted, AiGenerationFailed, AiContentApplied, AiContentReviewed, DocumentVersionCreated, AiUsageThresholdReached]
---

# US-169 — Gerar o rascunho do edital com IA

## Título
Gerar o rascunho do edital com IA

## Descrição
**Como** pessoa de Licitações responsável pela minuta do edital, **quero** pedir à IA um rascunho das seções narrativas do edital a partir do TR, da pesquisa de preços, do mapa de riscos e do cabeçalho tipado da minuta, aplicá-lo seção a seção e revisá-lo, **para** chegar à primeira versão do edital em minutos, no formato do template do órgão, sem abrir mão das decisões que continuam sendo da equipe.

A story acrescenta ao fluxo genérico do EP-020 (solicitar `AI-01`, acompanhar `AI-02`, descartar `AI-04`, aplicar `DOC-26`, revisar `DOC-27`, painel `SCR-117`) o gerador e o prompt `draft.tender`, o alvo `TENDER` e as regras próprias do edital: **a IA escreve só texto**; o cabeçalho tipado (modalidade, critério de julgamento, modo de disputa, regime, adjudicação, prazos, garantia, habilitação), os lotes, os valores e a matriz de alocação de riscos continuam com as pessoas; o que não está nas entradas sai como `[a confirmar]`; a matriz de riscos proposta entra só como texto da seção, nunca como `TenderRiskAllocation`; e o edital só é concluído (US-168) com todas as seções geradas revisadas por uma pessoa (US-122). Não há endpoint novo de geração.

## Contexto
- A DEC-202 estende a camada de IA do MVP 1 (DEC-037, DEC-079) ao edital: gerador `draft.tender`, `AiGeneration.targetModule = TENDER`, entradas em cadeia (TR, pesquisa de preços, mapa de riscos e `Tender`), mesmos `ContextSanitizer` e `GroundingGuard`, mesmos princípios (a IA não decide, nada inventado, revisão humana por seção, opt-in e limites por órgão). Na DEC-203 o custo é incluído no plano, sem cobrança por uso. O provedor é o da ADR-013; enquanto a PEND-21 estiver aberta, roda o `FakeAiProvider`.
- O edital (`Document` `EDITAL`, módulo `TENDER`) tem o cabeçalho tipado do `Tender` (US-163) e as seções narrativas do template do órgão. Seções importadas do TR (US-164) chegam preenchidas; a IA, por padrão, só propõe texto para as seções vazias e nunca altera o cabeçalho, os lotes (US-165) nem a matriz (US-166).
- O edital não é um documento de acesso restrito: quem tem `PROCESS_VIEW` lê o documento e a proposta, como no TR (RN-AI-13). Não há segregação nem regra de rascunho restrito como no parecer (POL-19 e POL-24 não se aplicam). A POL-18 é estendida a `TENDER` com `AI_GENERATE` mais `TENDER_UPDATE` (permissions.md); `AI_GENERATE` foi ampliada ao perfil `LICITACOES` e continua fora de `CONSULTOR_EXTERNO`.
- O orçamento sigiloso (DEC-030, POL-09, art. 24) nunca vai ao prompt, ao log, ao evento nem à auditoria, nem para quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`. O valor estimado só vem da pesquisa de preços concluída e só quando o edital divulga o valor (`estimatedValueDisclosed`).
- A revisão obrigatória (US-122) já bloqueia finalizar (DOC-10) e a conclusão do edital (TND-14, US-168) com seção `SECTION_AI_REVIEW_PENDING` ou `SECTION_PLACEHOLDER_PENDING`; esta story só garante que o conteúdo do edital gerado por IA entre nesse circuito.
- Fora de escopo (FT-079): preencher cabeçalho, lotes, valores, prazos ou a matriz; IA para a minuta do contrato (US-167), para o parecer (US-157) ou para a manifestação do Controle Interno; publicação ou qualquer ato sobre o edital (MVP 3).

## Objetivo
Entregar, em até 90 s (p95, medido no endurecimento), uma proposta das seções narrativas do edital com 100% dos fatos vindos das entradas rastreadas, todo dado ausente marcado `[a confirmar]`, cabeçalho, lotes, valores e matriz intactos (0 números inventados na minuta final), com pelo menos 60% das propostas concluídas aplicadas e 100% dos editais com texto de IA só concluídos depois de revisados seção a seção.

## Persona
- **Principal:** Licitações (perfil `LICITACOES`) com `AI_GENERATE` e `TENDER_UPDATE`.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, `AI_GENERATE` e `TENDER_UPDATE`); Consultoria externa (`CONSULTOR_EXTERNO`: não gera nem aplica, mas, como participante com `TENDER_UPDATE`, revisa seções); Administrador do órgão (`ADMIN_ORGAO`, `SETTINGS_MANAGE`: liga a IA, define limites e acompanha o consumo); Auditor (`AUDITOR`) e Controle Interno (rastreiam a proveniência); Planejamento e Compras (autores do TR, conferem a fidelidade).

## Pré-condições
- IA ligada no órgão (`ai.enabled = true`, com os termos aceitos), provedor disponível e limites mensal e diário não atingidos (US-115, US-116).
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`, com `AI_GENERATE` e `TENDER_UPDATE` cobrindo o processo, e custódia (POL-01) ou participação `COLLABORATOR`/`CONSULTANT` conforme a POL-02.
- Processo `IN_PROGRESS` com etapa ativa que permita o tipo `EDITAL` (na v2 padrão, `MINUTA_EDITAL`).
- `Tender` criado (US-163) com o documento `EDITAL` em `DRAFT` ou `RETURNED`.
- Para o rascunho completo: documento TR não cancelado no processo (de preferência concluído e importado para o edital, US-164). Para o ajuste de seção basta o `Tender` (RN-TND-153).

## Fluxo principal
1. Na minuta do edital (SCR-021, `/processos/[id]/edital/[tenderId]`), a pessoa com `AI_GENERATE` vê **"Gerar rascunho com IA"** (`AiDraftButton`); o front consulta `AI-05` e desabilita a ação, com explicação, se `canGenerate = false` (IA desligada, limite, TR ausente, edital não criado ou não editável).
2. O painel `SCR-117` abre no formulário (`AiRequestForm`): lista as entradas previstas (TR com versão e situação, pesquisa de preços concluída, mapa de riscos, condições do TR, cabeçalho do `Tender` e lotes), as seções do edital vazias e preenchidas, o campo opcional de orientações, o aviso fixo "A IA escreve só o texto das seções. Critério de julgamento, modalidade, lotes, valores, prazos e a matriz de riscos continuam com a equipe; o que faltar sairá como [a confirmar]" e o consumo estimado de tokens.
3. A pessoa clica em **"Gerar rascunho"**; o front envia `AI-01` (`targetModule = TENDER`, `documentId` do edital, `kind = DRAFT`, `instruction?`) com `Idempotency-Key`. A API valida a POL-18 estendida, o estado do edital e do processo (RN-TND-141), a geração ativa (RN-AI-12) e os limites; grava `AiGeneration` em `QUEUED` com `promptKey = draft.tender`, reserva os tokens, enfileira após o commit e responde 202 com `Location` e `pollAfterMs`.
4. O painel mostra o progresso (`AiGenerationProgress`); a pessoa pode continuar editando o edital (RN-AI-30).
5. O worker revalida POL-18, o estado e os pré-requisitos; monta o contexto por fachadas de leitura (RN-TND-142 a RN-TND-144) com o `ContextSanitizer`; chama o provedor fora de transação com o prompt `draft.tender`; valida o esquema (só `sections`); aplica o `GroundingGuard` e as travas do edital (RN-TND-147 a RN-TND-150) e grava a proposta `SUCCEEDED` com `inputRefs`, `warnings`, `placeholdersCount` e `groundingReplacements`.
6. O solicitante recebe `AI_GENERATION_READY` e o painel exibe a proposta (`AiProposalSectionList`): `[a confirmar]` por seção, avisos (insumo em rascunho, pesquisa de preços ausente, sigilo, truncamento), seções `EMPTY` marcadas, seções `FILLED` (por exemplo, importadas do TR) desmarcadas com "substituirá o texto atual" e a seção da alocação de riscos com o selo "Sugestão — decisão da equipe".
7. A pessoa lê a prévia (`AiSectionDiffView` nas já preenchidas), ajusta a seleção e clica em **"Aplicar seleção"**; o front envia `DOC-26` (`generationId`, `sectionKeys`, `confirmReplaceFilled?`) com `If-Match` do edital e `Idempotency-Key`.
8. A API aplica conforme a RN-AI-29 (proveniência de IA por seção, `revision + 1`, versão `SYSTEM` antes de substituir seção preenchida, geração `APPLIED`, auditoria `ai.content_apply`, evento `AiContentApplied`). O `Tender` (cabeçalho, lotes, matriz) e a minuta do contrato **não** mudam (RN-TND-152).
9. No editor, cada seção aplicada mostra "Gerado por IA · revisão pendente" e os `[a confirmar]` em destaque (US-122). A pessoa completa os dados, resolve as pendências e aciona "Marcar seção como revisada" (DOC-27) por seção ou "Revisar todas". Se precisar, usa o menu de IA por seção (reescrever, completar, resumir; RN-TND-153).
10. Só então conclui a minuta (TND-14, US-168); sem as revisões, a análise e a conclusão respondem 422 `DOCUMENT_INCOMPLETE`. A aba mostra, enquanto isso, "N seções do edital aguardam revisão" (RN-TND-151).

## Fluxos alternativos
- **FA-01 — TR ou minuta ausentes:** `AI-01` sem TR responde 422 `AI_PREREQUISITE_MISSING` (`missing: ['TR']`); sem `Tender`, `missing: ['TENDER']`; o painel orienta "Importe ou elabore o TR antes de usar a IA" ou "Crie a minuta do edital antes de usar a IA", com atalho (RN-TND-141).
- **FA-02 — Edital não editável:** edital `FINALIZED`, `APPROVED`, `IN_REVIEW` ou `CANCELED`, ou processo fora de `IN_PROGRESS`, responde 409 `DOCUMENT_NOT_EDITABLE` ou `INVALID_PROCESS_STATUS` no pedido e na aplicação; a ação aparece desabilitada com o motivo.
- **FA-03 — TR ainda não concluído:** o TR entra com a precedência aprovado, finalizado, rascunho; com rascunho, a proposta traz o aviso `USED_DRAFT_INPUTS` e a pessoa decide se gera assim ou espera (RN-TND-143).
- **FA-04 — Entradas opcionais ausentes:** sem pesquisa de preços concluída, a geração segue com `MISSING_PRICE_RESEARCH` e o valor sai `[a confirmar: valor estimado da pesquisa de preços]`; sem mapa de riscos nem riscos, `MISSING_OPTIONAL_INPUT` (tipos) e a seção da alocação de riscos sai vazia ou `[a confirmar]`.
- **FA-05 — Orçamento sigiloso ou valor não divulgado:** valores do processo, da pesquisa, dos itens e dos lotes ficam fora do contexto e do texto; a proposta traz `BUDGET_CONFIDENTIAL_VALUES_OMITTED` e a seção do valor estimado diz apenas que o valor é sigiloso (art. 24), ou fica vazia se o template não tiver essa seção (RN-TND-144).
- **FA-06 — Edital já importado do TR:** seções importadas vêm preenchidas e desmarcadas; a IA completa as vazias e pode propor texto para as preenchidas, que só são substituídas com `confirmReplaceFilled = true` e depois de uma `DocumentVersion` `SYSTEM` (RN-AI-28/29).
- **FA-07 — Cabeçalho incompleto:** campos ausentes do `Tender` (critério, modo de disputa, validade da proposta, prazos) aparecem no texto como `[a confirmar]` da categoria adequada; a IA nunca escolhe (RN-TND-146).
- **FA-08 — Alocação de riscos:** a seção da matriz traz uma sugestão textual por risco do mapa, cada uma com `[a confirmar]` de decisão; a matriz registrada (US-166) não muda; se já houver linhas registradas, o texto apenas as descreve (RN-TND-148).
- **FA-09 — Insumo mudou depois da geração:** TR, pesquisa de preços ou mapa de riscos com versão nova, ou cabeçalho do `Tender` editado, geram o aviso derivado `INPUTS_OUTDATED` com a recomendação "Gere de novo"; aplicar continua possível (RN-TND-154).
- **FA-10 — Ajuste de uma seção:** reescrever, completar ou resumir uma seção narrativa do edital (`kind = SECTION`), com comparação lado a lado e "Desfazer" (RN-TND-153).
- **FA-11 — Edição não revisa:** alterar o texto de seção gerada mantém a revisão pendente; nova aplicação sobre seção revisada zera a revisão (US-122, RN-TND-151).
- **FA-12 — Proposta de outra pessoa:** quem não é o solicitante vê a proposta somente leitura, sem aplicar nem descartar (RN-AI-13).
- **FA-13 — Descarte, expiração e nova proposta:** seguem RN-AI-31, RN-AI-11 e RN-AI-32 (proposta `SUCCEEDED` vale 7 dias; nova solicitação do mesmo usuário descarta a anterior não aplicada).
- **FA-14 — Saída do provedor com decisão ou campo estrutural:** a saída que traga campo de cabeçalho, lote, valor ou risco estruturado, ou escolha critério e modalidade fora de `[a confirmar]`, termina `FAILED` com `OUTPUT_INVALID` após uma tentativa de reparo; nada é gravado e o solicitante recebe `AI_GENERATION_FAILED` (RN-TND-145).
- **FA-15 — Conclusão durante a geração:** a conclusão do edital (US-168) prossegue; a geração ativa termina `CANCELED` por política e a proposta pronta deixa de ser aplicável (409 `AI_GENERATION_NOT_APPLICABLE`).

## Regras de negócio
- **RN-TND-11** *(da feature, adotada)* — O gerador exige o TR como antecessor e a minuta (`Tender`) criada; sem eles, 422 `AI_PREREQUISITE_MISSING` (DEC-202).
- **RN-TND-12** *(da feature, adotada)* — Gerar exige `AI_GENERATE` mais `TENDER_UPDATE` sobre o processo (POL-18 estendida a `TENDER`); aplicar só o solicitante (DEC-202).
- **RN-TND-13** *(da feature, adotada)* — A IA nunca decide: critério de julgamento, modalidade, lotes, valores e prazos ausentes das entradas saem como `[a confirmar]` (DEC-202, princípio 16).
- **RN-TND-14** *(da feature, adotada)* — Valor estimado só da pesquisa de preços concluída; com orçamento sigiloso, nunca vai à IA nem ao texto (DEC-202, DEC-030).
- **RN-TND-15** *(da feature, adotada)* — A matriz de riscos proposta é texto de seção e nunca grava `TenderRiskAllocation` (DEC-202).
- **RN-TND-16** *(da feature, adotada)* — Revisão humana por seção é obrigatória antes de finalizar o `EDITAL` (US-122, DEC-202).
- **RN-TND-17** *(da feature, adotada)* — Opt-in e limites por órgão (`ai.enabled`, `ai.monthlyTokenLimit`, `ai.userDailyRequestLimit`); IA incluída no plano, sem cobrança por uso (DEC-203).
- **RN-TND-18** *(da feature, adotada)* — A proposta guarda as versões usadas (`inputRefs`); se o TR mudar depois, aparece aviso para gerar de novo (DEC-202).
- **RN-TND-140** — Habilitação para gerar: `AI_GENERATE` e `TENDER_UPDATE` cobrindo o processo, custódia ou participação (POL-02), `ai.enabled`, provedor e limites (POL-18 estendida, revalidada no worker com `CANCELED_BY_POLICY` se falhar). Para **aplicar** (`DOC-26`) e **revisar** (`DOC-27`) basta `TENDER_UPDATE` + POL-02 (`AI_GENERATE` não é exigida, de modo que a revisão continua possível com a IA desligada, RN-AI-29 e RN-AI-56); só o solicitante aplica ou descarta a própria proposta (RN-AI-13). `CONSULTOR_EXTERNO` não gera (sem `AI_GENERATE`), mas pode revisar seções como participante. Consultar a proposta exige `PROCESS_VIEW`.
- **RN-TND-141** — Pré-requisitos de `AI-01` com `targetModule = TENDER`: o `documentId` é o `EDITAL` do `Tender` do processo (`Tender.id = Tender.documentId`; outro documento, como a `MINUTA_CONTRATO`, responde 422 `VALIDATION_ERROR`); `Tender` ausente: 422 `AI_PREREQUISITE_MISSING` (`missing: ['TENDER']`); TR ausente ou cancelado (só no `kind = DRAFT`): `missing: ['TR']`; `EDITAL` em `DRAFT`/`RETURNED` (senão 409 `DOCUMENT_NOT_EDITABLE`); processo `IN_PROGRESS` (senão 409 `INVALID_PROCESS_STATUS`) com etapa que permita o tipo (senão 422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`). Verificados no pedido, no worker e na aplicação.
- **RN-TND-142** — Entradas do rascunho (cada uma vira `inputRef`): (a) o processo (`PROCESS`: objeto, modalidade, tipo de contratação, registro de preços, unidade requisitante por nome, sem pessoas) e seus itens (`PROCESS_ITEMS`: descrição, unidade e quantidade, sem preços); (b) o TR (`DOCUMENT_VERSION`: seções e conteúdo) e suas condições tipadas (`TERM_CONDITIONS`: vigência, prazo de execução e tipo de contagem, local de entrega, prazo de pagamento, garantias, subcontratação, critério e adjudicação do TR); (c) a pesquisa de preços concluída (`DOCUMENT_VERSION` do tipo `PRICE_RESEARCH`: método, número de cotações e, se permitido, valor, nunca fornecedores nem cotações individuais); (d) o mapa de riscos (`DOCUMENT_VERSION` do tipo `RISK_MAP`, quando emitido) e os riscos do processo (`RISKS`: título, categoria, nível, fase, tratamentos, sem responsáveis, prazos nem pessoas); (e) o `Tender` (`TENDER`: cabeçalho tipado, lotes com número, nome e quantidade de itens e, se já registradas, as alocações de risco com parte, justificativa e mitigação, sem valores); (f) a versão do template do edital (`TEMPLATE_VERSION`: seções, `legalBasis`, `helpText` e `aiHints`); (g) `instruction` opcional (≤ 500). Cada entrada guarda `contentHash`; o contexto não é persistido (só `contextHash` e `inputRefs`).
- **RN-TND-143** — Versão das entradas: o TR e os demais documentos entram pela precedência da RN-AI-33 (versão aprovada mais recente, senão finalizada, senão o rascunho atual com o aviso `USED_DRAFT_INPUTS` e `kind = DOCUMENT_DRAFT`); a pesquisa de preços só entra se concluída (senão `MISSING_PRICE_RESEARCH`); tipo opcional ausente gera `MISSING_OPTIONAL_INPUT`. O `Tender` é lido no pedido e relido no worker: se o cabeçalho mudou entre os dois, vale o do worker e a proposta guarda o `contentHash` usado.
- **RN-TND-144** — Minimização e sigilo: o `ContextSanitizer` remove pessoas (nomes, CPF, e-mail, telefone), fornecedores e cotações individuais e aplica a redação de dados pessoais ao texto livre (RN-AI-05). O **valor estimado** só entra se vier da pesquisa de preços concluída **e** `Process.isBudgetConfidential = false` **e** `Tender.estimatedValueDisclosed = true`; senão valores de pesquisa, itens e lotes (`TenderLot.estimatedValue`) saem do contexto, mesmo para quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`, com o aviso `BUDGET_CONFIDENTIAL_VALUES_OMITTED`. Valor que mesmo assim apareça é trocado por `toConfirm` pelo `GroundingGuard`. Com valor omitido, a seção de divulgação do valor diz só que o orçamento é sigiloso (art. 24) quando o template a prevê.
- **RN-TND-145** — A saída tem só `sections` (uma por seção narrativa do template fixado no edital, com `legalBasis` preservada); não há campo de `risks`, de cabeçalho, de lotes, de valores nem de matriz estruturada. Seções com `render` ≠ `TEXT` (itens, matriz, valor) recebem só texto complementar e apenas com `allowNarrative = true`; com `false` ficam fora da proposta ("não coberta pela IA", RN-AI-37). O esquema (Zod) recusa campo extra: a saída inválida é reparada uma vez e, persistindo, termina `FAILED` com `OUTPUT_INVALID`, sem gravar `output` (falha fechada, RN-AI-54).
- **RN-TND-146** — A IA não decide o cabeçalho: o texto que descreve modalidade, critério de julgamento, modo de disputa, regime de execução, adjudicação, forma eletrônica, benefício a pequenas empresas, validade da proposta, prazos, garantia e habilitação só **repete** o valor tipado do `Tender` (ou do TR, nas condições); campo ausente vira `toConfirm` com a categoria mais próxima (`DECISION` para critério, modalidade, modo de disputa, regime, adjudicação e composição dos lotes; `DEADLINE` para validade da proposta, prazo de execução e vigência; `VALUE` para garantia; `DATA` para os demais). Com `awardType = BY_LOT` e sem lotes, a seção de julgamento traz `[a confirmar: composição dos lotes]`. A IA nunca cria nem altera lote, item, quantidade, valor ou prazo.
- **RN-TND-147** — Coerência com o cabeçalho (`HeaderConsistencyGuard`, determinístico): o nome (ou apelido) de uma modalidade ou de um critério de julgamento do catálogo do tenant, diferente do registrado no `Tender`, que apareça no texto é trocado por `toConfirm` da categoria `DECISION`, contado em `groundingReplacements`, com o aviso `HEADER_MISMATCH_REPLACED`. A lista de padrões nasce do catálogo (`MODALITY`, `JUDGMENT_CRITERION`) e é coberta pelo `pnpm ai:eval`.
- **RN-TND-148** — Matriz de riscos como texto (RN-TND-15): a seção da alocação de riscos descreve, por risco do mapa, a **sugestão** de parte que assume (`CONTRATANTE`, `CONTRATADA` ou `COMPARTILHADO` em linguagem do texto) e a razão, sempre com um `toConfirm` `DECISION` ("alocação do risco: confirmar") por risco, de modo que o texto não pode ser finalizado sem uma pessoa decidir. Com alocações já registradas (US-166), o texto só as descreve (sem sugestão). Gerar e aplicar nunca criam, alteram ou apagam `TenderRiskAllocation`, nem mudam `riskMatrixRequired`; o texto **não** satisfaz a exigência da matriz tipada (`TENDER_RISK_MATRIX_*`, US-168).
- **RN-TND-149** — Nada inventado (RN-AI-54): todo valor monetário, quantidade com unidade, prazo, data e percentual do texto precisa existir no conjunto de fatos das entradas; senão vira `toConfirm` (`VALUE`, `QUANTITY`, `DEADLINE`, `DATE`). Número do edital, data e hora da sessão pública, plataforma eletrônica, endereços eletrônicos e dados de contato do órgão que não estejam nas entradas saem `[a confirmar]` (`DATE` ou `DATA`); número do edital e publicação são do MVP 3. Referências a itens e lotes só podem ser as das entradas (número, nome).
- **RN-TND-150** — Normas: citações da Lei 14.133/2021 (artigo, inciso) e da Lei Complementar 123/2006 são preservadas; qualquer outra norma (decreto, instrução normativa, súmula, portaria) só se constar do `legalBasis` do template ou das entradas, senão vira `[a confirmar: fundamento]` (`DATA`) e conta em `groundingReplacements`; a IA não cita jurisprudência.
- **RN-TND-151** — Marcação e revisão: cada seção aplicada recebe `ai = { generationId, appliedAt, appliedById, reviewedAt: null }` (RN-AI-55); a revisão (DOC-27) é ato humano por seção ou em lote, com `TENDER_UPDATE` + POL-02, e a proveniência pendente bloqueia DOC-10 e a conclusão (TND-14) com `DOCUMENT_INCOMPLETE` (RN-AI-57, RN-TND-127 da US-168). A SCR-021 mostra `aiReviewPendingSections` (chaves) e `aiPlaceholdersPending` (contagem), derivados das violações de DOC-08, sem coluna nova. Concluir nunca revisa por conta própria.
- **RN-TND-152** — Aplicação (DOC-26) segue RN-AI-28 e RN-AI-29 e acrescenta: aplicar qualquer seção **não** altera o `Tender` (cabeçalho, `importedFromTermVersionId`, lotes e alocações), a `MINUTA_CONTRATO` nem os valores; por padrão vêm marcadas as seções `EMPTY`, e as `FILLED` (inclusive as importadas do TR) desmarcadas; a substituição exige `confirmReplaceFilled = true` e cria antes uma `DocumentVersion` `SYSTEM`. `If-Match` é o do edital.
- **RN-TND-153** — Ajuste por seção (`kind = SECTION`, `action` `REWRITE`, `COMPLETE` ou `SUMMARIZE`, RN-AI-47 a RN-AI-52): disponível nas seções narrativas do `EDITAL` em `DRAFT`/`RETURNED`, com POL-18 estendida (`AI_GENERATE` + `TENDER_UPDATE`); `REWRITE` e `SUMMARIZE` exigem 50 caracteres (`AI_SECTION_EMPTY`); seção fora do template ou sem narrativa responde 422 `AI_SECTION_NOT_SUPPORTED`; não exige TR nem outro antecessor além do `Tender` (faltas viram `MISSING_OPTIONAL_INPUT`); `baseRevision` e 410 `AI_SUGGESTION_STALE` como no EP-020; o ajuste consome 6 mil tokens e conta no limite diário; o texto atual entra como fato (inputRef `SECTION`) e as regras RN-TND-144 a RN-TND-150 valem do mesmo modo. A `MINUTA_CONTRATO` não tem ajuste de IA.
- **RN-TND-154** — Insumos desatualizados (RN-TND-18): o aviso `INPUTS_OUTDATED` é **derivado na leitura** (AI-02 e painel) quando, depois da geração, o TR, a pesquisa de preços ou o mapa de riscos ganharam versão nova, ou o `contentHash` do `Tender` ou das condições do TR deixou de coincidir com o de `inputRefs` (cabeçalho, lotes ou alocações editados); lista os tipos e recomenda gerar de novo. Não impede aplicar (a decisão e a revisão são humanas), mas fica visível ao aplicar e em `ai.content_apply` (`outdatedInputs`).
- **RN-TND-155** — Limites e consumo (RN-TND-17, DEC-203): a reserva de tokens do pedido é a estimativa do alvo `TENDER` (proposta inicial de 50 mil tokens para o rascunho, calibrada no endurecimento; 6 mil para o ajuste de seção), abatida do consumo real ao final; `AI-06` passa a exibir o gerador `draft.tender` e os ajustes com `targetModule = TENDER`; ao cruzar 80% e 100% do limite mensal vale `AiUsageThresholdReached` (RN-AI-20). Sem cobrança por uso.
- **RN-TND-156** — Concorrência de gerações: uma geração ativa (`QUEUED`/`RUNNING`) por (processo, `targetModule = TENDER`) para `DRAFT` e por (documento, `sectionKey`) para `SECTION` (RN-AI-12); nova solicitação responde 409 `AI_GENERATION_IN_PROGRESS` com `meta.generationId`. Pedido novo de rascunho descarta a proposta `SUCCEEDED` anterior não aplicada do mesmo usuário (RN-AI-32). A proposta vale 7 dias (RN-AI-11).
- **RN-TND-157** — Disponibilidade (`AI-05`): `canGenerate = false` com `reasons[]` entre `AI_DISABLED`, `AI_PROVIDER_UNAVAILABLE`, `AI_USAGE_LIMIT_REACHED`, `AI_USER_DAILY_LIMIT_REACHED`, `PERMISSION_DENIED`, `DOCUMENT_NOT_EDITABLE`, `TENDER_NOT_CREATED` e `TERM_MISSING`.
- **RN-TND-158** — Rastreabilidade: auditoria `ai.generation_request`, `ai.generation_complete`/`ai.generation_fail`, `ai.content_apply`, `ai.content_review` e `ai.generation_discard` com `metadata.targetModule = TENDER` e só ids, versões, hashes, contagens e `errorCode`, nunca texto, orientações nem valores; entradas `AI_CONTENT_GENERATED`, `AI_CONTENT_APPLIED` e `AI_CONTENT_REVIEWED` na timeline do processo, sem conteúdo.
- **RN-TND-159** — Provedor e avaliação: o `ai` fala com o provedor só pela porta `AiProvider` (ADR-013); `FakeAiProvider` em dev, test e CI enquanto a PEND-21 estiver aberta; o prompt `draft.tender` é versionado em `apps/api/src/modules/ai/prompts/draft.tender/`, e mudar o texto exige nova `promptVersion`. O `pnpm ai:eval` inclui o conjunto de avaliação do `draft.tender` (DoD do épico): saídas que invadem o cabeçalho, números e normas inventados, orçamento sigiloso, edital sem pesquisa de preços, sem mapa de riscos e sem lotes, e a propriedade "nenhuma saída gravada decide o cabeçalho, os lotes ou os valores".
- **Herdadas, sem repetir:** pipeline, fila, limites e minimização (RN-AI-01..24, US-115 e US-116); aplicação seletiva, descarte e acompanhamento (RN-AI-25..32, US-117); ajuste de seção (RN-AI-47..52, US-121); `toConfirm`, `GroundingGuard`, proveniência e revisão (RN-AI-53..58, US-122); importação do TR e versão de origem (US-164).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Orientações | `instruction` | texto | Não | ≤ 500 caracteres, texto puro | em branco |
| Edital | `documentId` | uuid | Sim | `EDITAL` do `Tender` do processo (RN-TND-141) | aba do edital |
| *(sistema)* Alvo | `targetModule`, `kind`, `promptKey` | enum, enum, texto | Sim | `TENDER`, `DRAFT` ou `SECTION`, `draft.tender` ou `section.*` | fixos |
| Ação do ajuste | `action`, `sectionKey` | enum, texto | Condicional (`SECTION`) | `REWRITE`, `COMPLETE`, `SUMMARIZE`; seção narrativa do template | menu de IA da seção |
| Seções a aplicar | `sectionKeys` | lista de checkboxes | Sim (mín. 1) | chaves da proposta; `EMPTY` marcadas, `FILLED` desmarcadas | `EMPTY` marcadas |
| Substituir texto atual | `confirmReplaceFilled` | booleano | Condicional | obrigatório se marcar seção `FILLED`/`NOT_APPLICABLE` (RN-AI-28) | `false` |
| Versão do edital | `If-Match` (ETag) | texto | Sim (DOC-26) | ETag do documento | `GET` do edital |
| Chave de idempotência | `Idempotency-Key` | texto | Sim (AI-01, DOC-26) | 24 h | gerada pelo front |
| Seções a revisar | `sectionKeys`, `expectedRevisions`, `confirmAll` | lista, mapa, booleano | Sim (DOC-27) | como em US-122 | seção em foco ou todas as pendentes |
| *(saída)* Avisos | `warnings[].code` | enum | — | `USED_DRAFT_INPUTS`, `MISSING_PRICE_RESEARCH`, `MISSING_OPTIONAL_INPUT`, `BUDGET_CONFIDENTIAL_VALUES_OMITTED`, `CONTEXT_TRUNCATED`, `HEADER_MISMATCH_REPLACED`, `INPUTS_OUTDATED` (derivado) | gerado |
| *(saída)* Entradas | `inputRefs[]` | lista | — | `kind` em `PROCESS`, `PROCESS_ITEMS`, `DOCUMENT_VERSION`, `DOCUMENT_DRAFT`, `TERM_CONDITIONS`, `TENDER`, `RISKS`, `TEMPLATE_VERSION`, `USER_INSTRUCTION`, `SECTION` | gerado |
| *(saída)* Contagens | `placeholdersCount`, `groundingReplacements` | inteiros | — | por seção e total | `GroundingGuard` |
| *(saída)* Pendências do edital | `aiReviewPendingSections[]`, `aiPlaceholdersPending` | lista, inteiro | — | derivados de DOC-08 (RN-TND-151) | SCR-021 |

**Seções do edital e origem do conteúdo gerado** (chaves **indicativas**; a fonte é o template v2 fixado no edital, a confirmar na semente, ver lacuna 1):
| Seção | Chave indicativa | O que a IA escreve | Se faltar dado |
|---|---|---|---|
| Do objeto | `OBJECT` | Objeto e descrição resumida a partir do TR, do processo e dos itens | `[a confirmar: objeto]` (`DATA`) |
| Das condições de participação | `PARTICIPATION` | Benefício a pequenas empresas, registro de preços e forma da disputa conforme o `Tender` | `[a confirmar: …]` por campo (`DECISION`) |
| Da proposta | `PROPOSAL` | Apresentação e validade da proposta, forma eletrônica | `[a confirmar: validade da proposta]` (`DEADLINE`); forma não eletrônica sem justificativa: `[a confirmar: justificativa]` |
| Do julgamento | `JUDGMENT` | Critério de julgamento, modo de disputa, adjudicação e lotes como registrados | `[a confirmar: critério de julgamento]`, `[a confirmar: modo de disputa]`, `[a confirmar: composição dos lotes]` (`DECISION`) |
| Da habilitação | `HABILITATION` | Exigências de `habilitationRequirements` com a base legal do template | exigência ausente: `[a confirmar: …]` (`DATA`) |
| Do valor estimado | `ESTIMATED_VALUE` | Valor da pesquisa de preços concluída, ou a menção ao orçamento sigiloso | `[a confirmar: valor estimado da pesquisa de preços]` (`VALUE`) |
| Da execução e da entrega | `EXECUTION` | Prazo, local e condições a partir de `TERM_CONDITIONS` e do `Tender` | `[a confirmar: prazo de execução]`, `[a confirmar: local de entrega]` |
| Do pagamento e das garantias | `PAYMENT`, `GUARANTEES` | Prazo de pagamento e garantias do TR e do `Tender` | `[a confirmar: prazo de pagamento]`, `[a confirmar: garantia contratual]` |
| Da alocação de riscos | `RISK_ALLOCATION` | Sugestão textual por risco, sempre com decisão pendente (RN-TND-148) | seção vazia sem riscos; ou `[a confirmar]` |
| Dos recursos e das penalidades | `APPEALS`, `PENALTIES` | Texto com a base legal do template e as sanções do TR, sem percentuais novos | percentual ausente: `[a confirmar]` (`VALUE`) |
| Da fiscalização e da gestão | `OVERSIGHT` | Modelo de fiscalização do TR | `[a confirmar: …]` por dado omisso |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `instruction` acima de 500 caracteres; `documentId` que não é o edital do processo | Front + API (Zod) | "Revise as orientações e abra o edital do processo." | `VALIDATION_ERROR` |
| V-02 | Pedido sem TR ou sem minuta de edital criada | API | "Importe ou elabore o TR e crie a minuta do edital antes de gerar o rascunho com IA." | `AI_PREREQUISITE_MISSING` (`TR`, `TENDER`) |
| V-03 | Edital fora de `DRAFT`/`RETURNED` ou processo fora de `IN_PROGRESS` | API | "O edital não pode ser editado agora." | `DOCUMENT_NOT_EDITABLE` / `INVALID_PROCESS_STATUS` |
| V-04 | Tipo não permitido na etapa | API | "O edital não pode ser editado nesta etapa." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-05 | Já existe geração ativa do alvo | API | "Já há um rascunho do edital sendo gerado." | `AI_GENERATION_IN_PROGRESS` |
| V-06 | IA desligada, provedor indisponível ou limite atingido | API | "A IA não está disponível agora." | `AI_DISABLED` / `AI_PROVIDER_UNAVAILABLE` / `AI_USAGE_LIMIT_REACHED` / `AI_USER_DAILY_LIMIT_REACHED` |
| V-07 | `REWRITE` ou `SUMMARIZE` em seção com menos de 50 caracteres; seção sem narrativa ou fora do template | Front + API | "Escreva ao menos 50 caracteres na seção ou use Completar." / "Esta seção não aceita texto gerado por IA." | `AI_SECTION_EMPTY` / `AI_SECTION_NOT_SUPPORTED` |
| V-08 | Seção preenchida marcada sem confirmação | Front + API | "Confirme a substituição do texto atual." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-09 | `sectionKeys` vazio ou fora da proposta; geração não `SUCCEEDED`, expirada ou de outro documento | Front + API | "Selecione seções de uma proposta ainda válida." | `VALIDATION_ERROR` / `AI_GENERATION_NOT_APPLICABLE` |
| V-10 | `If-Match` ausente ou divergente na aplicação | API | "O edital foi alterado. Recarregue para continuar." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-11 | Seção de ajuste com revisão diferente da lida pela IA | API | "A seção mudou depois do pedido. Peça o ajuste de novo." | `AI_SUGGESTION_STALE` (410) |
| V-12 | Lote de revisão sem `confirmAll` ou revisão esperada divergente (DOC-27) | Front + API | "Confirme que leu e revisou as seções." / "A seção foi alterada. Leia a versão atual antes de revisar." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) / `VERSION_CONFLICT` |
| V-13 | Concluir o edital com seção não revisada ou com `[a confirmar]` | API | "Revise o conteúdo gerado por IA e resolva os itens [a confirmar]." | `DOCUMENT_INCOMPLETE` |

## Permissões
- **Permissão:** `AI_GENERATE` mais `TENDER_UPDATE` cobrindo o processo para gerar (`AI-01`, rascunho e ajuste); `TENDER_UPDATE` para aplicar (`DOC-26`) e revisar (`DOC-27`); `PROCESS_VIEW` para consultar a geração e o edital; `SETTINGS_MANAGE` para ligar a IA, definir limites e ver o consumo (SCR-041, `AI-06`).
- **Políticas:** POL-18 estendida a `TENDER` (revalidada no worker), POL-02 (edição do edital: `DRAFT`/`RETURNED`, tipo permitido na etapa, processo editável; `EDITAL` ← `TENDER_UPDATE`), POL-01 (custódia), POL-09 e DEC-030 (sigilo no contexto), DEC-024 (visibilidade). Não se aplicam POL-19 nem POL-24.
- **MFA:** não exigido (`AI_GENERATE` e `TENDER_UPDATE` são risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** "Gerar rascunho com IA" fica oculto sem `AI_GENERATE` e desabilitado com o motivo quando o edital não é editável, falta TR ou a IA está indisponível; a API responde 403 `PERMISSION_DENIED`, `NOT_PROCESS_CUSTODIAN` ou `AI_GENERATION_NOT_OWNED` e grava `access.denied`; edital, geração ou processo de outro tenant responde 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `AiGenerationRequested` | `ai.generation_requested` | Commit de `AI-01` | `targetModule = TENDER`, `kind`; sem conteúdo |
| `AiGenerationCompleted` | `ai.generation_completed` | Worker grava `SUCCEEDED` | modelo, `promptKey = draft.tender`, `promptVersion`, tokens, `sectionsCount`, `placeholdersCount`; projeta `AI_CONTENT_GENERATED` |
| `AiGenerationFailed` | `ai.generation_failed` | Worker grava `FAILED` | `errorCode` (inclusive `OUTPUT_INVALID`), `attempts` |
| `AiContentApplied` | `document.ai_content_applied.edital` | Commit de `DOC-26` | `sectionKeys[]`, `replacedFilledSections`; projeta `AI_CONTENT_APPLIED` (sem notificação) |
| `DocumentVersionCreated` | `document.version_created.edital` | Mesmo commit, se substituir seção preenchida | `reason = SYSTEM` |
| `AiContentReviewed` | `document.ai_content_reviewed.edital` | Commit de `DOC-27` | `sectionKeys[]`, `generationIds[]`; projeta `AI_CONTENT_REVIEWED` |
| `AiUsageThresholdReached` | `ai.usage_threshold_reached` | Consumo cruza 80% e 100% do mês | por órgão; notifica `SETTINGS_MANAGE` (US-116) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `AI_GENERATION_READY` | solicitante | in-app | geração `SUCCEEDED`; link para o edital com `?ia=<id>` |
| `AI_GENERATION_FAILED` | solicitante | in-app | geração `FAILED` após as tentativas |
| `AI_USAGE_LIMIT_WARNING` | quem tem `SETTINGS_MANAGE` | in-app + e-mail | `AiUsageThresholdReached` (tipo do MVP 1, inalterado) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerar o rascunho do edital com IA

  Background:
    Given que o tenant "Prefeitura A" está ativo com "ai.enabled" igual a "true"
    And o provedor de IA de teste responde com a fixture "draft.tender"
    And o processo "0012/2026" está "IN_PROGRESS" na etapa "MINUTA_EDITAL" e tem orçamento não sigiloso
    And o TR "TR 0003/2026" está "FINALIZED" na versão 2 e a pesquisa de preços está concluída na versão 1 com valor total estimado de "R$ 480.000,00"
    And o mapa de riscos tem a versão 1 com 3 riscos
    And o "Tender" tem modalidade "PREGAO", critério "Menor preço", modo de disputa "OPEN", adjudicação "BY_LOT" com 2 lotes, validade da proposta de 60 dias, garantia de 5% e "executionTermDays" em branco
    And a matriz de alocação de riscos é exigida e ainda não tem linhas registradas
    And o edital "ED 0004/2026" está em "DRAFT", com a seção "OBJECT" preenchida (importada do TR) e as demais seções vazias
    And "Lia Santos" tem vínculo ativo no perfil "LICITACOES", com "AI_GENERATE" e "TENDER_UPDATE" no processo, e custódia dele
    And "Carla Mendes", do perfil "PLANEJAMENTO", elaborou o TR

  Scenario: [Sucesso] Gerar o rascunho do edital sem decidir cabeçalho, lotes nem valores
    When "Lia Santos" solicitar o rascunho do edital com IA com a chave "K1"
    Then a API deve responder 202 e a geração deve ficar "QUEUED" com "targetModule" "TENDER" e "promptKey" "draft.tender"
    And deve gerar a auditoria "ai.generation_request" e o evento "AiGenerationRequested"
    When o worker processar a geração
    Then a geração deve ficar "SUCCEEDED" com "inputRefs" do processo, dos itens, do TR v2, das condições do TR, da pesquisa de preços v1, do mapa de riscos v1, dos riscos, do "Tender" e do template
    And a proposta deve trazer só "sections" e a seção "EXECUTION" deve conter "[a confirmar: prazo de execução]" da categoria "DEADLINE"
    And o "Tender", os lotes e a minuta do edital não devem ser alterados
    And deve gerar o evento "AiGenerationCompleted" e a notificação "AI_GENERATION_READY"

  Scenario: [Sucesso] Aplicar as seções vazias preserva a seção importada e o cabeçalho
    Given que a geração está "SUCCEEDED" e foi solicitada por "Lia Santos", com a seção "OBJECT" desmarcada por já estar preenchida
    When "Lia Santos" aplicar as seções marcadas com o "If-Match" atual
    Then a API deve responder 200 com as seções aplicadas e a geração "APPLIED"
    And cada seção aplicada deve ficar "Gerado por IA — revisão pendente" e a seção "OBJECT" deve manter o texto importado
    And o cabeçalho, os lotes, as alocações e "importedFromTermVersionId" do "Tender" devem permanecer idênticos
    And deve gerar a auditoria "ai.content_apply" e o evento "AiContentApplied"
    And o painel deve exibir "N seções do edital aguardam revisão"

  Scenario: [Sucesso] A matriz de riscos proposta é só texto com decisão pendente
    When o worker concluir a geração
    Then a seção "RISK_ALLOCATION" deve descrever os 3 riscos do mapa com a sugestão de parte que assume e um "[a confirmar]" da categoria "DECISION" por risco
    When "Lia Santos" aplicar todas as seções
    Then nenhuma "TenderRiskAllocation" deve ter sido criada e "riskMatrixRequired" deve continuar "true"
    And a análise da conclusão deve continuar apontando "TENDER_RISK_MATRIX_REQUIRED"

  Scenario: [Sucesso] Nada inventado: valores, prazos e normas ausentes viram pendência
    Given que o provedor de teste escreve "R$ 500.000,00", "prazo de 90 dias", "garantia de 8%", "Decreto 9.999/2020" e "sessão pública em 10/12/2026" no edital
    When o worker concluir a geração
    Then esses trechos devem virar "[a confirmar]" das categorias "VALUE", "DEADLINE", "DATE" e "DATA" e "groundingReplacements" deve ser maior que 0
    And "R$ 480.000,00" da pesquisa de preços concluída, "60 dias" e "5%" do "Tender" e a citação "art. 33 da Lei 14.133/2021" devem ser preservados
    And nenhum número de edital deve aparecer no texto

  Scenario: [Sucesso] A IA não decide critério nem modalidade
    Given que o "Tender" não tem modo de disputa registrado
    And o provedor de teste escreve "o julgamento será pelo critério de maior desconto" e "modo de disputa fechado"
    When o worker concluir a geração
    Then o critério divergente deve virar "[a confirmar]" da categoria "DECISION" com o aviso "HEADER_MISMATCH_REPLACED"
    And a seção "JUDGMENT" deve trazer "[a confirmar: modo de disputa]" e o critério "Menor preço" registrado

  Scenario: [Sucesso] Orçamento sigiloso não chega ao provedor nem ao texto
    Given que o orçamento do processo é sigiloso e "Lia Santos" tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    When "Lia Santos" gerar o rascunho do edital
    Then o contexto enviado ao provedor de teste não deve conter valor estimado, valor de item nem valor de lote
    And a proposta deve trazer "BUDGET_CONFIDENTIAL_VALUES_OMITTED" e a seção "ESTIMATED_VALUE" deve dizer apenas que o orçamento é sigiloso
    And a auditoria, o log e os eventos não devem conter valor algum

  Scenario: [Sucesso] Sem pesquisa de preços concluída o valor fica pendente
    Given que a pesquisa de preços do processo não está concluída
    When o worker concluir a geração
    Then a proposta deve trazer "MISSING_PRICE_RESEARCH" e a seção "ESTIMATED_VALUE" deve conter "[a confirmar: valor estimado da pesquisa de preços]" da categoria "VALUE"

  Scenario: [Sucesso] Ajustar uma seção do edital com IA
    Given que a seção "PROPOSAL" do edital tem 300 caracteres escritos por "Lia Santos"
    When "Lia Santos" pedir "REWRITE" da seção "PROPOSAL" com a chave "K3"
    Then a geração deve ficar "QUEUED" com "kind" "SECTION", "action" "REWRITE" e "baseRevision" da seção
    When o worker concluir e "Lia Santos" aplicar a comparação com "confirmReplaceFilled" igual a "true"
    Then a seção deve ficar "Gerado por IA — revisão pendente", os fatos e as marcações da seção devem ser preservados e o "Tender" não deve ser alterado

  Scenario: [Sucesso] Revisar todas as seções libera a conclusão
    Given que as seções geradas foram aplicadas e as pendências "[a confirmar]" foram resolvidas por "Lia Santos"
    When "Lia Santos" marcar todas as seções como revisadas com "confirmAll" igual a "true"
    Then a API deve responder 200 e deve gerar o evento "AiContentReviewed" com as chaves revisadas
    And a validação do edital não deve mais apontar "SECTION_AI_REVIEW_PENDING" nem "SECTION_PLACEHOLDER_PENDING"

  Scenario: [Sucesso] Insumo alterado depois da geração gera aviso
    Given que existe uma proposta "SUCCEEDED" não aplicada gerada com o TR v2
    When "Carla Mendes" concluir a versão 3 do TR e "Lia Santos" abrir a proposta
    Then a resposta deve trazer o aviso "INPUTS_OUTDATED" com o tipo "TR" e a recomendação de gerar de novo
    And a proposta ainda deve poder ser aplicada
    When "Lia Santos" editar o critério de julgamento do "Tender"
    Then o aviso "INPUTS_OUTDATED" deve incluir o tipo "TENDER"

  Scenario: [Sucesso] Metas de desempenho na suíte de performance
    Given um edital com TR de 14 seções, 200 itens, 20 lotes e mapa de riscos com 30 riscos
    When a suíte de performance executar 50 rascunhos com o "FakeAiProvider" calibrado
    Then o p95 de "AI-01" deve ser de até 1 s e o do rascunho, da solicitação à proposta pronta, de até 90 s

  Scenario: [Validação] TR ausente, minuta ausente, documento errado e limite de uso
    Given que o processo não tem TR
    When "Lia Santos" solicitar o rascunho do edital
    Then a API deve responder 422 com código "AI_PREREQUISITE_MISSING" e "meta.missing" igual a ["TR"] e nenhuma geração deve ser registrada
    Given que o "Tender" ainda não foi criado
    When "Lia Santos" solicitar o rascunho
    Then a API deve responder 422 com código "AI_PREREQUISITE_MISSING" e "meta.missing" igual a ["TENDER"]
    Given que a minuta do contrato "MC 0001/2026" existe
    When "Lia Santos" solicitar o rascunho informando o "documentId" da minuta do contrato
    Then a API deve responder 422 com código "VALIDATION_ERROR" e nenhuma geração deve ser registrada
    Given que o limite mensal de tokens do órgão foi atingido
    When "Lia Santos" solicitar o rascunho
    Then a API deve responder 422 com código "AI_USAGE_LIMIT_REACHED" e nenhuma geração deve ser registrada

  Scenario: [Validação] Edital concluído, substituição sem confirmação e seção sem texto
    Given que o edital "ED 0004/2026" está "FINALIZED"
    When "Lia Santos" solicitar o rascunho
    Then a API deve responder 409 com código "DOCUMENT_NOT_EDITABLE"
    Given que o edital voltou a "DRAFT" e a seção "OBJECT" está preenchida
    When "Lia Santos" aplicar "OBJECT" sem "confirmReplaceFilled"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" e o edital não deve ser alterado
    Given que a seção "APPEALS" tem 10 caracteres
    When "Lia Santos" pedir "SUMMARIZE" da seção "APPEALS"
    Then a API deve responder 422 com código "AI_SECTION_EMPTY"
    Given que o edital tem a seção "PAYMENT" gerada por IA sem revisão
    When "Lia Santos" tentar concluir a minuta do edital
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE" e a violação "SECTION_AI_REVIEW_PENDING"

  Scenario: [Permissão] Sem TENDER_UPDATE, consultor externo, outro usuário e IA desligada
    Given que "Bruno Lopes" tem "AI_GENERATE" mas não tem "TENDER_UPDATE"
    When "Bruno Lopes" solicitar o rascunho do edital
    Then a API deve responder 403 com código "PERMISSION_DENIED", gerar a auditoria "access.denied" e não chamar o provedor de IA
    Given que "Paulo Dias", do perfil "CONSULTOR_EXTERNO", é participante com "TENDER_UPDATE" e não tem "AI_GENERATE"
    When "Paulo Dias" solicitar o rascunho
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    When "Paulo Dias" marcar como revisada uma seção gerada por IA
    Then a API deve responder 200 e o evento "AiContentReviewed" deve ser gerado
    Given que "Marcos Pires", do perfil "GESTOR_CONTRATACOES", com "AI_GENERATE" e "TENDER_UPDATE", tenta aplicar a geração solicitada por "Lia Santos"
    Then a API deve responder 403 com código "AI_GENERATION_NOT_OWNED"
    Given que "Marcos Pires" consulta a geração pela API
    Then a resposta deve trazer o "output", os "warnings" e os "inputRefs"
    Given que a IA foi desligada no órgão
    When "Lia Santos" solicitar o rascunho
    Then a API deve responder 403 com código "AI_DISABLED"

  Scenario: [Tenant incorreto] Edital e geração de outro órgão
    Given que o edital "ED 0003/2026" e uma geração pertencem ao tenant "Prefeitura B"
    When "Lia Santos", da "Prefeitura A", solicitar o rascunho para esse edital ou consultar essa geração
    Then a API deve responder 404 nas duas chamadas
    And o contexto de nenhuma geração deve conter dado da "Prefeitura B"

  Scenario: [Duplicidade] Reenvio com a mesma chave e geração ativa
    Given que "Lia Santos" solicitou o rascunho com a chave "K1" e recebeu 202
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 202 com "Idempotent-Replayed: true" e existir uma única geração
    When "Lia Santos" solicitar com a chave "K2" enquanto a geração está ativa
    Then a API deve responder 409 com código "AI_GENERATION_IN_PROGRESS" e "meta.generationId" da geração ativa
    When "Lia Santos" reenviar a aplicação já concluída com a mesma chave
    Then a API deve responder 200 com o mesmo resultado e existir um único evento "AiContentApplied"

  Scenario: [Concorrência] Edital editado entre a proposta e a aplicação, e conclusão durante a geração
    Given que "Lia Santos" abriu a proposta com o edital na versão 3
    When "Marcos Pires" salvar a seção "JUDGMENT", gerando a versão 4, e "Lia Santos" aplicar com "If-Match: \"3\""
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    When "Lia Santos" recarregar o edital e aplicar "JUDGMENT" sem "confirmReplaceFilled"
    Then a API deve responder 422 com erro "CONDITIONAL_REQUIRED" e o texto de "Marcos Pires" deve ser preservado
    And duas aplicações simultâneas da mesma geração devem resultar em uma sucesso e a outra 409 "AI_GENERATION_NOT_APPLICABLE"
    Given que "Carla Mendes" conclui a versão 3 do TR durante a geração
    Then a geração deve usar o TR v2 lido no início e a proposta deve trazer "INPUTS_OUTDATED" com "TR"
    Given que há uma geração "RUNNING" e "Lia Santos" conclui a minuta do edital
    Then a geração deve terminar "CANCELED" com "CANCELED_BY_POLICY" e o edital não deve receber texto da IA

  Scenario: [Falha de banco] Banco indisponível durante a aplicação
    Given que o banco de dados fica indisponível durante a transação de aplicação
    When "Lia Santos" aplicar as seções selecionadas
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhuma seção deve ser alterada, a geração deve continuar "SUCCEEDED" e nenhum evento ou auditoria deve ser gravado

  Scenario: [Falha de integração] Provedor limitado, indisponível ou com saída fora do esquema
    Given que o provedor de IA de teste responde 429 na primeira tentativa e sucesso na segunda
    When o worker processar a geração
    Then a geração deve ficar "SUCCEEDED" com "attempts" igual a 2
    Given que o provedor responde 503 nas 3 tentativas
    Then a geração deve ficar "FAILED" com "errorCode" "PROVIDER_UNAVAILABLE", "Lia Santos" deve receber "AI_GENERATION_FAILED" e o edital não deve ser alterado
    Given que o provedor devolve campos de cabeçalho, de lotes, de valores ou "risks" estruturados, mesmo após o reparo
    Then a geração deve ficar "FAILED" com "errorCode" "OUTPUT_INVALID" e nenhum "output" deve ser gravado

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Lia Santos" aplicar a proposta com sucesso
    Then as seções devem ser atualizadas e a API deve responder 200
    And o evento "AiContentApplied" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| TR ou minuta do edital ausentes | 422 | `AI_PREREQUISITE_MISSING` | "Importe ou elabore o TR e crie a minuta do edital antes de gerar o rascunho com IA." | Atalho para o TR ou para criar a minuta |
| Orientação ou `documentId` inválidos | 422 | `VALIDATION_ERROR` | "Revise as orientações e abra o edital do processo." | Marca o campo |
| Edital não editável / processo fora de `IN_PROGRESS` | 409 | `DOCUMENT_NOT_EDITABLE` / `INVALID_PROCESS_STATUS` | "O edital não pode ser editado agora." | Desabilita a ação com o motivo |
| Tipo fora da etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O edital não pode ser editado nesta etapa." | Oculta a ação |
| Geração ativa | 409 | `AI_GENERATION_IN_PROGRESS` | "Já há um rascunho do edital sendo gerado." | Abre a geração ativa |
| IA desligada, provedor indisponível ou limite | 403 / 503 / 422 | `AI_DISABLED` / `AI_PROVIDER_UNAVAILABLE` / `AI_USAGE_LIMIT_REACHED` / `AI_USER_DAILY_LIMIT_REACHED` | "A IA não está disponível agora." | Ação desabilitada com explicação; respeita `Retry-After` |
| Seção sem texto suficiente / sem narrativa | 422 | `AI_SECTION_EMPTY` / `AI_SECTION_NOT_SUPPORTED` | "Escreva ao menos 50 caracteres na seção ou use Completar." | Orienta a ação certa |
| Sem permissão | 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | "Você não tem permissão para gerar conteúdo com IA neste edital." | Botão oculto |
| Geração de outro usuário | 403 | `AI_GENERATION_NOT_OWNED` | "Só quem pediu a geração pode aplicá-la." | Painel somente leitura |
| Geração, edital ou processo inexistentes / de outro tenant | 404 | `AI_GENERATION_NOT_FOUND` / `NOT_FOUND` | "Registro não encontrado." | Fecha o painel |
| Proposta não aplicável | 409 | `AI_GENERATION_NOT_APPLICABLE` | "Esta proposta não pode mais ser aplicada." | Oferece nova geração |
| Ajuste sobre seção alterada | 410 | `AI_SUGGESTION_STALE` | "A seção mudou depois do pedido. Peça o ajuste de novo." | Oferece repetir o ajuste |
| Falta confirmar substituição | 422 | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) | "Confirme a substituição do texto atual." | Destaca a seção |
| `If-Match` ausente / divergente | 428 / 412 | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` | "O edital foi alterado. Recarregue para continuar." | Oferece "Ver versão atual" |
| Seção não revisada ou com pendência ao concluir | 422 | `DOCUMENT_INCOMPLETE` | "Revise o conteúdo gerado por IA e resolva os itens [a confirmar]." | Lista as seções com link |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente." | Mantém a seleção; respeita `Retry-After` |
| Falha da geração (assíncrona) | — | `errorCode` `TIMEOUT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`, `CONTENT_FILTERED`, `CONTEXT_TOO_LARGE`, `OUTPUT_INVALID`, `CANCELED_BY_POLICY` | "Não foi possível gerar o rascunho." | Estado "falhou" com "Tentar de novo" |

## Dependências
- **Stories:** US-115 (camada de IA, `AiGeneration`, pipeline e `GroundingGuard` plugável), US-116 (ativação, limites, `AI-05`/`AI-06`, `AI_GENERATE`), US-122 (`toConfirm`, `GroundingGuard`, proveniência e revisão `DOC-27`), US-164 (importação do TR para o edital: seções preenchidas e versão de origem). Indiretas: US-117 e US-121 (fluxo genérico de aplicar, descartar e ajustar seção, painel `SCR-117`), US-120 (rascunho do TR, mesma convenção de condições e marcadores), US-163 (`Tender`, cabeçalho e template do edital), US-165 e US-166 (lotes e matriz, lidos como entrada), US-168 (conclusão que revalida a revisão), US-110 (template do edital), US-157 (rascunho do parecer, mesmo contrato de IA, com regras de conclusão e restrição próprias).
- **Decisões/ADRs:** DEC-016, DEC-030, DEC-037, DEC-079, DEC-196, DEC-201, DEC-202, DEC-203; ADR-013 (PEND-21, provedor real; `FakeAiProvider` até lá).
- **Configurações:** `ai.enabled`, `ai.termsAcceptedVersion`, `ai.monthlyTokenLimit`, `ai.userDailyRequestLimit`; plataforma `AI_PROVIDER` e `AI_MODEL_DRAFT`; `Tender.estimatedValueDisclosed`.
- **Lacunas nas fontes canônicas:**
  1. **Chaves das seções do edital:** `entities.md` §9 descreve o template do edital sem listar as seções; a story usa chaves indicativas (`OBJECT`, `PARTICIPATION`, `PROPOSAL`, `JUDGMENT`, `HABILITATION`, `ESTIMATED_VALUE`, `EXECUTION`, `PAYMENT`, `GUARANTEES`, `RISK_ALLOCATION`, `APPEALS`, `PENALTIES`, `OVERSIGHT`). Alinhar com a semente definida na US-163/US-110.
  2. **Rota de solicitação:** a feature FT-079 cita `POST /tenders/{id}/ai-drafts` como indicativa; esta story reutiliza `AI-01` (`POST /processes/{id}/ai-generations`, com `targetModule = TENDER` e `documentId` = edital), conforme o EP-020, e não cria rota nova. Retirar a rota indicativa do `api.md` do MVP 2.
  3. **Entradas em `entities.md` §7.11:** o texto lista `TENDER` e `RISKS` sem detalhar lotes, alocações já registradas e `TERM_CONDITIONS` (tipo que já existe em `AiInputRef.kind`, MVP 1). A story inclui lotes e alocações dentro do `TENDER` (sem valores) e usa `TERM_CONDITIONS` para as condições do TR; atualizar §7.11.
  4. **Avisos, razões e campos novos:** `HEADER_MISMATCH_REPLACED`, `INPUTS_OUTDATED` (derivado), `meta.missing` com `TR` e `TENDER`, as razões de `AI-05` (`TENDER_NOT_CREATED`, `TERM_MISSING`) e os campos aditivos `aiReviewPendingSections`/`aiPlaceholdersPending` na leitura do edital não constam de `events.md`, `permissions.md` nem do catálogo de API; consolidar no `api.md` do MVP 2.
  5. **Estimativa de tokens do alvo `TENDER`:** a DEC-203 manda calibrar como os demais (DFD 15 mil, ETP 40 mil, TR 40 mil); a story propõe 50 mil para o rascunho e 6 mil para o ajuste, a calibrar no endurecimento. **Dúvida de produto:** limite de contexto e prioridade de truncamento (ordem sugerida: alocações já registradas, riscos, pesquisa de preços, condições do TR, TR, cabeçalho).
  6. **`estimatedValueDisclosed` e valor no edital:** se o edital divulga o valor e a pesquisa está concluída, o texto pode citá-lo (RN-TND-144). **Dúvida de produto:** se o valor estimado deve vir sempre de uma seção estruturada e nunca de texto livre da IA, mesmo quando divulgado.
  7. **Normas aceitas e padrões do `HeaderConsistencyGuard`** (RN-TND-147 e RN-TND-150) não estão em fonte canônica; ficam na biblioteca versionada do prompt e precisam de validação do jurídico do piloto.
  8. **Pasta do prompt:** segue a DEC-202 (`prompts/draft.tender/`); os ajustes por seção usam os prompts `section.*` do EP-020 com `targetModule = TENDER`.
  9. **Tipos de notificação:** não há tipo novo; usam-se `AI_GENERATION_READY`, `AI_GENERATION_FAILED` e `AI_USAGE_LIMIT_WARNING` do MVP 1 (events.md do MVP 2 declara os eventos `AiGeneration*` e `AiContent*` inalterados, com `<type>` = `edital`).
  10. **Aplicar e revisar sem `AI_GENERATE`:** a feature cita `AI_GENERATE` e `TENDER_UPDATE` para "solicitar, aplicar e revisar"; a story segue a US-117 e a US-122 (aplicar e revisar com a permissão de edição do tipo, `TENDER_UPDATE`), para que a revisão não dependa de a IA estar ligada e para que o consultor externo possa revisar.

## Impacto técnico
- O gerador `TenderDraftGenerator` monta um conjunto de fatos normalizado (`TenderDraftContext`) que alimenta o prompt e o `GroundingGuard`: cabeçalho, lotes, condições do TR e riscos nascem dos campos tipados, nunca do modelo; as seções do TR e da pesquisa são resumidas em fatos e trechos relevantes e reduzidas por prioridade, emitindo `CONTEXT_TOO_LARGE`/`CONTEXT_TRUNCATED` quando necessário.
- O prompt `draft.tender` é versionado em `apps/api/src/modules/ai/prompts/draft.tender/`; mudar o texto exige nova `promptVersion` e o `pnpm ai:eval` passa a incluir o conjunto do edital (RN-TND-159) e o teste de propriedade "nenhuma saída gravada decide cabeçalho, lotes ou valores". Metas p95 de 90 s (rascunho) e 1 s (`AI-01`) vão para a suíte de performance, medidas no endurecimento.
- Sem tabela nova: reaproveita `AiGeneration` (check de `targetModule` ampliado em M2, entities.md §5.12), `Document.draftContent` e `AiSuggestionSource`; o único parcial de geração ativa cobre a RN-AI-12 para `TENDER`. Regra D9: o módulo `ai` só lê `tender`, `term`, `price-research`, `risk`, `document` e `process` por fachadas de leitura (`ai-read-only`); a aplicação é comando de `document` e a leitura de `tender` expõe só `getDraftContext(tenderId)`.
- O `GroundingGuard` ganha o `HeaderConsistencyGuard` e o detector de normas no gancho de pós-processamento da US-115, antes da checagem de `maxChars`; continua puro, determinístico e idempotente.
- Isolamento do cabeçalho: um teste de propriedade compara o *hash* de `tenders`, `tender_lots`, `tender_lot_items` e `tender_risk_allocations` antes e depois de gerar e de aplicar; a igualdade é invariante do produto.
- Compatibilidade: nenhum contrato do MVP 1 muda; `AI-01`, `AI-02`, `AI-04`, `AI-05`, `AI-06`, `DOC-26` e `DOC-27` ganham apenas o alvo e o tipo de documento novos, com `eventVersion = 1` nos eventos especializados `document.*.edital`.
- Sigilo: contexto, log, evento e auditoria sem valores de orçamento sigiloso e sem texto do edital (DEC-030).

## Backend
- **Módulo(s):** `ai` (gerador, geração, `GroundingGuard`), `document` (aplicação `DOC-26`, revisão `DOC-27`, completude e proveniência), `tender` (fachada de leitura do cabeçalho, lotes e alocações), `term` e `price-research` e `risk` (fachadas de leitura), `process`, `catalog`, `tenancy`, `access`, `timeline`, `notification`, `audit`, `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `TenderDraftGenerator`, registrado no registro de geradores da US-115 para `TENDER`/`DRAFT` (valida pré-requisitos, monta o contexto, renderiza o prompt, mapeia a saída, aplica as travas do edital) e `TenderSectionAdjuster` para `TENDER`/`SECTION`; `AI-01`, `AI-02`, `AI-04`, `DOC-26` e `DOC-27` são os comandos genéricos das US-115, US-117, US-121 e US-122.
- **Domínio e integrações:** `TenderDraftContext` (fatos, `inputRefs`, avisos), `TenderSourceResolver` (precedência de versão do TR, pesquisa concluída, `contentHash` do `Tender`), `HeaderConsistencyGuard` (RN-TND-147), `LegalNormGuard` (RN-TND-150), `RiskAllocationTextGuard` (RN-TND-148), `AiProvider` (`FakeAiProvider` em dev/test/CI), `AuthorizationService.assertCan('AI_GENERATE', { processId })` com `TENDER_UPDATE`, `AiSuggestionSource.loadForApply`/`markApplied`, `OutdatedInputsProjector` (derivação de `INPUTS_OUTDATED`).
- **Transação:** `AI-01` grava geração, reserva de tokens, auditoria e outbox numa transação e enfileira após o commit; o worker lê em transação do tenant, chama o provedor fora dela e grava a proposta em transação curta; `DOC-26` aplica seções, versão condicional, `markApplied`, auditoria e outbox numa única transação, sem tocar o `Tender`.

## Frontend
- **Tela(s):** SCR-021 (`/processos/[id]/edital/[tenderId]`, badges "Gerado por IA", menu de IA por seção, chips `[a confirmar]` e aviso de seções pendentes de revisão) com o painel `SCR-117` (`?ia=<generationId>`); SCR-041 (seção "Inteligência artificial": limites e consumo, inclusive do gerador novo).
- **Componentes:** `AiDraftButton`, `AiAssistantPanel`, `AiRequestForm` (entradas por tipo e versão, avisos de insumo em rascunho, aviso fixo sobre o que a IA não decide, consumo estimado), `AiGenerationProgress`, `AiProposalSectionList` (selo "Sugestão — decisão da equipe" na alocação de riscos), `AiSectionDiffView`, `AiSectionMenu` (reescrever, completar, resumir), `AiDisclaimer`; após aplicar, `AiGeneratedBadge`, `ToConfirmChip`, `MarkReviewedButton` e `ReviewAllDialog` (US-122); `TenderReviewPendingBanner` no painel da minuta.
- **Estados:** carregando a disponibilidade (skeleton); formulário; gerando (cancelável); proposta pronta; aplicada; falhou (`errorCode` traduzido); vazio (sem TR ou sem minuta, com atalho); desabilitado com explicação; somente leitura para quem não é o solicitante.
- **Acessibilidade e responsividade:** progresso anunciado por `aria-live`; foco movido ao painel e devolvido ao botão; checkboxes e diff por teclado; selos de IA, de revisão e de decisão com texto e ícone, nunca só cor; `ToConfirmChip` com `aria-label` "Pendência a confirmar: {rótulo}"; abaixo de 768 px o painel ocupa a tela e o diff vira abas "Atual" e "Sugerido"; contraste AA nos temas claro e escuro.

## Banco de dados
- **Tabelas:** `ai_generations` (insert/update de status; `target_module = 'TENDER'`), `documents` (`draft_content`, `draft_revision`), `document_versions` (insert condicional), `audit_logs`, `outbox_events`, `timeline_entries`, `notifications`; `tenders`, `tender_lots`, `tender_lot_items`, `tender_risk_allocations`, `terms_of_reference`, `risks` e versões de documentos apenas lidas.
- **Migrações e índices:** nenhuma além da ampliação do check de `target_module` e de `AiInputRef.kind` já prevista na M2 (entities.md §5.12); único parcial `(tenant_id, process_id, target_module) WHERE kind = 'DRAFT' AND status IN ('QUEUED','RUNNING')` já cobre a RN-AI-12; RLS por `tenant_id` em todo o contexto.

## API
_Indicativa; reutiliza os contratos do EP-020 (MVP 1). IDs de edital (TND-01 a TND-14) são das US-163 a US-168._

| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `AI-01` | POST | `/api/v1/processes/{id}/ai-generations` | `{ targetModule: 'TENDER', documentId, kind: 'DRAFT' \| 'SECTION', action?, sectionKey?, instruction? }` + `Idempotency-Key` | `202 { data: AiGeneration, meta: { pollAfterMs } }` + `Location` | 202, 401, 403, 404, 409, 422, 429, 503 |
| `AI-02` | GET | `/api/v1/ai-generations/{generationId}` | — | `200 { data: AiGeneration }` (com `output`, `warnings`, `inputRefs`; `INPUTS_OUTDATED` derivado) | 200, 403, 404 |
| `AI-04` | POST | `/api/v1/ai-generations/{generationId}/discard` | — | `200` | 200, 403, 404, 409 |
| `AI-05` | GET | `/api/v1/ai/availability?processId=&documentId=` | — | `200 { enabled, canGenerate, reasons[] }` (RN-TND-157) | 200, 401 |
| `AI-06` | GET | `/api/v1/ai/usage?month=` | `SETTINGS_MANAGE` | consumo por gerador, documento e usuário, com `draft.tender` | 200, 403 |
| `DOC-26` | POST | `/api/v1/documents/{id}/ai-apply` | `{ generationId, sectionKeys, confirmReplaceFilled? }` + `If-Match` + `Idempotency-Key` | `200 { data: { document, appliedSectionKeys, versionCreated } }` | 200, 403, 404, 409, 410, 412, 422, 428, 503 |
| `DOC-27` | POST | `/api/v1/documents/{id}/ai-review` | `{ sectionKeys, expectedRevisions, confirmAll? }` | `200 { data: { document, reviewedSectionKeys } }` | 200, 403, 404, 409, 412, 422, 503 |
| `DOC-08` | GET | `/api/v1/documents/{id}/validation` | — | `violations[]` com `SECTION_AI_REVIEW_PENDING` e `SECTION_PLACEHOLDER_PENDING` | 200, 403, 404 |

## Logs
- `info` `ai.generation_requested` e `ai.generation_completed` — `generationId`, `processId`, `tenderId`, `targetModule`, `promptKey`, `promptVersion`, tokens, `latencyMs`, `placeholdersCount`, `groundingReplacements`; `info` `ai.content_applied` — `generationId`, `sectionKeys`; `info` `ai.content_reviewed` — `documentId`, `sectionsCount`.
- `warn` `ai.prerequisite_missing` (`missing`), `ai.header_mismatch_replaced` (contagem), `ai.norm_replaced` (contagem) e `idempotency.store_unavailable`; `error` `ai.generation_failed` — `errorCode`, `attempts`, `correlationId`; `error` `ai.output_invalid` — `generationId`, motivo resumido (campo estrutural fora do esquema), sem o texto.
- **Nunca logar:** orientações, contexto enviado, saída do modelo, texto de seções, valores do processo, dos itens ou dos lotes, nomes de pessoas ou fornecedores.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `ai.generation_request` | `DATA_CHANGE` | Commit de `AI-01` | `metadata`: `generationId`, `targetModule = TENDER`, `kind`, `action?`, `sectionKey?`, `promptKey`, `promptVersion`, `tenderId` |
| `ai.generation_complete` / `ai.generation_fail` | `SYSTEM` | Fim da geração | `metadata`: `model`, `inputRefs` (ids, versões, hashes), `contextHash`, `outputHash`, tokens, `costUsd`, `errorCode`; nunca texto |
| `ai.content_apply` / `ai.generation_discard` | `DATA_CHANGE` | `DOC-26` / `AI-04` | `changes`: chaves das seções; `metadata`: `generationId`, `replacedFilledSections`, `outdatedInputs` (tipos), `idempotencyKey` |
| `ai.content_review` | `DATA_CHANGE` | `DOC-27` | `changes`: `reviewedAt` das seções; `metadata`: `documentId`, `targetModule`, `sectionKeys`, `generationIds`, `confirmAll` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode` = `AI_GENERATE` ou `TENDER_UPDATE` |

## Testes necessários
- **Unitários:** `TenderDraftContext` e `ContextSanitizer` (sem pessoas, fornecedores nem valores sigilosos; lotes e itens sem valor; alocações só com texto); precedência de versão do TR e pesquisa só concluída; prompt `draft.tender` com fixtures (cabeçalho completo × incompleto, com e sem lotes, com e sem alocações, insumo presente × ausente × rascunho); `HeaderConsistencyGuard` (modalidade e critério divergentes); `LegalNormGuard` (Lei 14.133 e LC 123 preservadas, decreto inventado trocado); `RiskAllocationTextGuard` (marcador `DECISION` por risco); `GroundingGuard` com valor, prazo, data, percentual e número de edital inventados; esquema que recusa campo estrutural; derivação de `INPUTS_OUTDATED`.
- **Integração (Testcontainers PostgreSQL + Redis):** worker ponta a ponta com `FakeAiProvider` (sucesso, 429 com nova tentativa, 503, `OUTPUT_INVALID` por campo estrutural, cancelamento por política e por conclusão); aplicação sem alterar `tenders`, `tender_lots`, `tender_lot_items` nem `tender_risk_allocations` (hash antes e depois); versão `SYSTEM` condicional; revisão e bloqueio de DOC-10 e TND-14; ajuste por seção com `baseRevision`; outbox e timeline na mesma transação; RLS.
- **API/contrato:** `AI-01`, `AI-02`, `AI-04`, `AI-05`, `AI-06`, `DOC-26`, `DOC-27` e `DOC-08` conforme o `api.md` (`Location`, `Idempotent-Replayed`, `If-Match`); contrato do `FakeAiProvider` com o prompt novo.
- **RBAC e multi-tenant:** `AI_GENERATE` × `TENDER_UPDATE` × POL-02 por perfil e escopo (`CONSULTOR_EXTERNO` sem geração, com revisão; `CONTROLE_INTERNO` sem geração); edital e geração de outro tenant → 404; teste novo na suíte `test/tenant-leak` (contexto da geração sem dados de outro tenant; `AI-02` isolado por tenant).
- **Concorrência:** duas solicitações simultâneas (202 e 409); duas aplicações da mesma geração; edição do edital entre proposta e aplicação (412); seção preenchida depois da proposta (422); novo TR durante a geração; conclusão durante a geração.
- **E2E (Playwright):** criar a minuta → importar do TR → gerar com `FakeAiProvider` → aplicar as seções vazias → resolver `[a confirmar]`, registrar a matriz de riscos pela tela própria → tentar concluir (bloqueado) → revisar → concluir; variantes com orçamento sigiloso e com TR novo depois da geração.
- **Acessibilidade/performance:** axe sem violações sérias no painel, no diff e nos selos; 360 px; p95 de `AI-01` ≤ 1 s e do rascunho ≤ 90 s na suíte de performance (medidos no endurecimento); `pnpm ai:eval` com o conjunto do `draft.tender`.

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
- [ ] Testes provam que a IA nunca decide: cabeçalho, lotes, valores e matriz intactos depois de gerar e aplicar, e saída com campo estrutural rejeitada (`OUTPUT_INVALID`)
- [ ] Teste prova que a matriz de riscos proposta nunca cria `TenderRiskAllocation` e que cada risco sugerido traz `[a confirmar]` de decisão
- [ ] Prompt `draft.tender` versionado e coberto pelo `pnpm ai:eval`, sem chamada ao provedor dentro de transação e sem valores sigilosos no contexto
- [ ] Edital com texto de IA não concluível sem a revisão humana por seção (DOC-10 e TND-14)
- [ ] Conjunto de avaliação do `draft.tender` executado e registrado (DoD do épico)

## Estimativa
**L** — o pipeline, a fila, o painel e a aplicação existem (US-115, US-117, US-121, US-122); o esforço está no gerador de cadeia (TR, pesquisa de preços, mapa de riscos, condições, cabeçalho e lotes, com contexto grande e truncamento), nas travas do edital (cabeçalho intocável, `HeaderConsistencyGuard`, normas, matriz só como texto com decisão pendente), no sigilo do valor estimado, no ajuste por seção sobre o `EDITAL` e na bateria de avaliação.

## Prioridade
**P1** — acelera a redação do edital (art. 25 da Lei 14.133/2021) com os limites da DEC-202 e responde a um diferencial do concorrente, mas o fluxo manual da minuta (US-163 a US-168) segue completo sem a IA, como no EP-020.

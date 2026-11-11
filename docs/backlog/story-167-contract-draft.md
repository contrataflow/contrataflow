---
id: US-167
title: "Elaborar a minuta do contrato"
epic: EP-027
feature: FT-078
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-038, US-163]
modules: [tender, document, term, process, catalog, tenancy, access, timeline, audit, platform]
screens: [SCR-021]
endpoints: [TND-11, TND-12, DOC-03, DOC-04, DOC-05, DOC-13, DOC-20]
permissions: [TENDER_CREATE, TENDER_UPDATE, DOCUMENT_CANCEL, PROCESS_VIEW]
events: [DocumentCreated, DocumentVersionCreated, TenderUpdated, TenderImportedFromTerm]
---

# US-167 — Elaborar a minuta do contrato

## Título
Elaborar a minuta do contrato

## Descrição
**Como** pessoa de Licitações responsável pela minuta do edital, **quero** criar a minuta do contrato a partir do modelo do órgão e importar do Termo de Referência a vigência, as garantias, as obrigações, os prazos e as condições de pagamento, **para** que o contrato acompanhe o edital como anexo, siga o que o TR aprovou e seja redigido sem copiar e colar.

A story entrega a `MINUTA_CONTRATO` como segundo documento do `Tender` (RN-TND-08): a criação a partir do template publicado do órgão (TND-11), o vínculo com a minuta do edital (`Tender.contractDraftDocumentId`), a importação seletiva do TR em duas fases, prévia e aplicação (TND-12, como o TR importa do ETP), a edição pelo ciclo de vida do documento (POL-02) e o sigilo do orçamento. Concluir (finalizar) a minuta do contrato junto com o edital é da US-168; esta story termina com o contrato em `DRAFT`, importado, editável e vinculado.

## Contexto
- A DEC-201 define a `MINUTA_CONTRATO` como documento gerado de template, que importa do TR pelos `importMappings` (como TR ← ETP) e é apontado pelo `Tender`. Em `entities.md` (§9) o tipo é `FREE_TEXT`, numerado `MC {seq:4}/{year}`, com `requiresApproval = false`: não há tabela de cabeçalho própria; os valores tipados de prazos e garantia que o edital precisa ficam no `Tender` (US-163, US-164) e o contrato os recebe como texto.
- O contrato acompanha o edital (art. 25 e § 1º da Lei 14.133/2021: minutas padronizadas de edital e de contrato) e tem as cláusulas necessárias do art. 92 (objeto, vigência, preço e pagamento, garantias, obrigações, sanções, fiscalização). O Jurídico (EP-025) analisa edital e contrato juntos, e a autoridade os aprova na etapa `AUTORIZACAO_LICITACAO` (DEC-196).
- O TR já traz o que o contrato precisa: seções `CONTRACTOR_OBLIGATIONS`, `CONTRACTING_PARTY_OBLIGATIONS`, `DEADLINES`, `DELIVERY`, `PAYMENT`, `OVERSIGHT`, `GUARANTEES` e `SANCTIONS` (US-036) e as condições tipadas `contractDurationMonths`, `executionDeadline`, `deliveryLocation`, `paymentTermDays`, `productWarrantyMonths`, `contractGuaranteePercent` e `allowsSubcontracting` (US-038). A importação do TR para o edital (US-164) trata do `Tender`; esta trata só do texto do contrato.
- A regra de saída padrão da etapa `MINUTA_EDITAL` trata a existência da minuta do contrato como aviso (`WARNING`), não bloqueio (DEC-196): a story existe para que, no caso comum, ela exista e esteja pronta.
- Sigilo (DEC-030, art. 24): a minuta do contrato não leva valor estimado nem preço de referência; o valor da contratação só existe depois da adjudicação (formalização do contrato fica no MVP 4). A IA não redige a minuta do contrato (FT-079, fora de escopo).
- Gestão, assinatura e publicação do contrato estão fora do MVP 2 (assinatura no MVP 3, gestão no MVP 4); aqui só a minuta.

## Objetivo
Permitir que ao menos 90% das minutas de contrato nasçam com importação do TR, sem redigitar cláusulas, com 100% das condições ausentes do TR marcadas como `[a confirmar]` (nunca preenchidas por suposição), nenhum valor sigiloso no texto e vínculo único e auditável com o edital; criar a minuta em até 500 ms (p95, medido no endurecimento).

## Persona
- **Principal:** Licitações (perfil `LICITACOES`, `TENDER_CREATE` e `TENDER_UPDATE`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, mesmas permissões); Planejamento e Compras (`PLANEJAMENTO`, `COMPRAS`, conferem a fidelidade ao TR); Consultoria externa (`CONSULTOR_EXTERNO`, edita com `TENDER_UPDATE` quando participante, não cria); Jurídico e autoridade (leem as versões concluídas, US-168).

## Pré-condições
- Processo `IN_PROGRESS` com etapa ativa que permita os tipos `EDITAL` e `MINUTA_CONTRATO` (`WorkflowStage.documentTypeCodes`; na v2 padrão, `MINUTA_EDITAL`).
- `Tender` criado (US-163) e documento `EDITAL` em `DRAFT` ou `RETURNED`.
- Usuário com vínculo ativo, `TENDER_CREATE` (criar) ou `TENDER_UPDATE` (importar e editar) cobrindo o processo, com custódia (POL-01) ou participação `COLLABORATOR`/`CONSULTANT` conforme a POL-02.
- Tipo de documento `MINUTA_CONTRATO` ativo no tenant, com template padrão e versão publicada (US-110); versão publicada do template com `importMappings` de origem `TR` para a importação.
- Para importar: documento TR não cancelado no processo (US-036); idealmente concluído (US-039).

## Fluxo principal
1. Na aba "Minuta do contrato" de SCR-021 (`/processos/[id]/edital/[tenderId]`), a pessoa de Licitações vê o estado vazio ("Este edital ainda não tem minuta de contrato") e a ação **"Criar minuta do contrato"**, habilitada com `TENDER_CREATE` e o edital editável.
2. O diálogo (`ContractDraftCreateDialog`) mostra o modelo que será usado (nome e versão do template publicado), o título sugerido "Minuta do contrato — {código do processo}" (editável, 5 a 250 caracteres) e a opção **"Importar do TR logo após criar"** marcada quando existe TR.
3. Ao confirmar, o front envia `POST /tenders/{id}/contract-draft` (TND-11) com `Idempotency-Key`. A API valida estado, permissão e tipo permitido na etapa, trava o `Tender` (`SELECT … FOR UPDATE`) e confere que não há minuta de contrato ativa vinculada.
4. Na mesma transação, o módulo `document` cria o `Document` `MINUTA_CONTRATO` em `DRAFT` com `draftContent` das seções do template (variáveis resolvidas) e código `MC {seq:4}/{year}`; o `tender` grava `Tender.contractDraftDocumentId`; gravam-se auditoria, eventos e timeline. A API responde 201 com o documento e `Location`.
5. Se a importação foi marcada, o front chama `POST /tenders/{id}/contract-draft/import-term` com `mode = PREVIEW` (TND-12). A API localiza a versão do TR a importar (RN-TND-105), aplica o `importMappings` do template e devolve, sem gravar, a prévia por seção e por condição, os avisos e o `importToken` (validade de 15 minutos).
6. O painel (`TermImportPreview`) mostra o "antes e depois" por seção e a lista de condições tipadas em frase pronta ("Vigência de 12 meses", "Pagamento em até 30 dias"), tudo pré-marcado; condições que o TR não preencheu aparecem com o rótulo **"[a confirmar]"** e a explicação "O TR não informa este dado".
7. A pessoa desmarca o que não quer importar e, se uma seção do contrato já tem texto, confirma **"Substituir o texto atual"**. Aciona **"Aplicar importação"**.
8. O front envia TND-12 com `mode = APPLY`, o `importToken`, a seleção, `confirmReplaceFilled` quando for o caso, `If-Match` (ETag da minuta do contrato) e `Idempotency-Key`. A API revalida o token (TR, minuta e edital inalterados desde a prévia), aplica as seções e as condições escolhidas, cria `DocumentVersion` (`reason = IMPORT`), grava a versão do TR de origem (`contractDraftImportedFromTermVersionId`, `contractDraftImportedAt`), audita e publica `TenderImportedFromTerm` e `DocumentVersionCreated`.
9. O editor mostra o toast "Importação aplicada: 6 seções e 5 condições" e a entrada na linha do tempo; seções com `[a confirmar]` ficam destacadas.
10. A pessoa completa as cláusulas pelo editor de seções do documento (DOC-05, autosave com controle de revisão), resolve cada `[a confirmar]`, confere a pré-visualização em PDF (DOC-20) e deixa a minuta pronta; a conclusão junto com o edital é a US-168.
11. Se o TR ganhar versão nova depois, a aba mostra o aviso "O TR foi atualizado desde a importação da minuta do contrato (v2 → v3)" com atalho para repetir a importação seletiva.

## Fluxos alternativos
- **FA-01 — Criar sem importar:** a pessoa desmarca a importação; a minuta nasce só com o texto do template e a aba oferece "Importar do TR" quando quiser.
- **FA-02 — Sem TR no processo:** a importação fica indisponível ("O processo não tem TR para importar"); TND-12 responde 422 `TERM_REQUIRED_FOR_IMPORT`; a criação continua possível.
- **FA-03 — TR ainda não concluído:** o TR está em `DRAFT`/`IN_REVIEW`; a prévia sai com o aviso `TERM_NOT_FINALIZED` ("O TR ainda não foi concluído; os dados podem mudar") e a importação é permitida.
- **FA-04 — TR mais novo que o do edital:** a versão do TR a importar é posterior à usada no edital (`Tender.importedFromTermVersionId`); a prévia traz `TERM_NEWER_THAN_TENDER_IMPORT` ("O edital foi importado da versão 2 do TR; reimporte o edital para manter a coerência") e não bloqueia.
- **FA-05 — Divergência com o cabeçalho do edital:** vigência ou garantia do TR diferentes do `Tender` (`contractTermMonths`, `guaranteePercent`) aparecem como aviso informativo `TENDER_HEADER_DIVERGENT` na prévia, sem alterar o `Tender` nem a importação (RN-TND-113).
- **FA-06 — Seção do contrato já preenchida:** só é substituída com `confirmReplaceFilled = true`; no modo `APPEND` o texto importado entra ao final com a referência "Importado do TR v{n} em {data}".
- **FA-07 — Orçamento sigiloso:** seções cuja origem traz valor estimado (`render` `ESTIMATED_VALUE` ou `PRICE_SUMMARY`) são omitidas da prévia (`skipped`, motivo `CONFIDENTIAL_VALUE`) e nunca importadas (RN-TND-108).
- **FA-08 — Prévia expirada ou origem alterada:** TND-12 em `APPLY` responde 410 `IMPORT_PREVIEW_EXPIRED` quando passaram 15 minutos ou o TR, a minuta ou o `Tender` mudaram; o painel recarrega a prévia sozinho.
- **FA-09 — Minuta já existe:** nova criação responde 409 `TENDER_CONTRACT_DRAFT_EXISTS` com `meta.documentId`; o painel abre a minuta existente.
- **FA-10 — Cancelar e recriar:** minuta em `DRAFT`/`RETURNED` pode ser cancelada (DOC-13, `DOCUMENT_CANCEL` e custódia); com a anterior `CANCELED`, uma nova pode ser criada e substitui o vínculo, ficando a cancelada no histórico (RN-TND-102).
- **FA-11 — Edital concluído ou fora de etapa:** com o edital `FINALIZED`/`APPROVED`, ou a etapa não permitindo o tipo, criar ou importar responde 409 `DOCUMENT_NOT_EDITABLE` ou 422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`; para alterar, o edital é reaberto pelo fluxo da US-168.
- **FA-12 — Criação direta pelo catálogo de documentos:** DOC-02 com o tipo `MINUTA_CONTRATO` ou `EDITAL` é recusado (`DOCUMENT_TYPE_MANAGED_BY_MODULE`); a minuta só nasce por TND-11 (RN-TND-103).

## Regras de negócio
- **RN-TND-08** *(da feature, adotada)* — A `MINUTA_CONTRATO` é gerada a partir de template e importa do TR; o `Tender` aponta para ela (DEC-201).
- **RN-TND-10** *(da feature, adotada)* — A edição segue o ciclo de vida do documento (DEC-018) e a POL-02 com `TENDER_UPDATE`, apenas em `DRAFT` ou `RETURNED` para o colaborador; valores seguem o sigilo do orçamento (DEC-030).
- **RN-TND-04** *(da feature, adotada)* — A importação é seletiva por seção, registra a versão do TR e a data e nunca altera o TR (DEC-201). Para o contrato, o registro é `contractDraftImportedFromTermVersionId` e `contractDraftImportedAt`.
- **RN-TND-100** — Criação (TND-11): usa o template padrão do tipo `MINUTA_CONTRATO` e sua versão publicada (fixada no documento, `templateVersionId`); o código é `MC {seq:4}/{year}` pelo gerador do módulo `document`; título de 5 a 250 caracteres (padrão "Minuta do contrato — {process.code}"). Sem modelo publicado, 422 `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) com a orientação de falar com o administrador. A minuta nasce `DRAFT`, `confidentiality` herdada do tipo, sem itens.
- **RN-TND-101** — Estado exigido: `Tender` existente do tenant e do processo; processo `IN_PROGRESS`; `EDITAL` em `DRAFT`/`RETURNED`; tipo permitido na etapa ativa (POL-02); `TENDER_CREATE` cobrindo o processo e custódia (POL-01) ou participação conforme a POL-02. Importar e editar exigem `TENDER_UPDATE`.
- **RN-TND-102** — Há no máximo uma minuta de contrato ativa por `Tender`. A restrição é garantida por trava da linha do `Tender` e por índice único parcial em `contract_draft_document_id`; segunda criação com a primeira em `DRAFT`, `RETURNED`, `FINALIZED` ou `APPROVED` responde 409 `TENDER_CONTRACT_DRAFT_EXISTS`. Com a anterior `CANCELED`, a nova substitui o vínculo na mesma transação (a cancelada permanece como documento do processo).
- **RN-TND-103** — O `EDITAL` e a `MINUTA_CONTRATO` são documentos geridos pelo módulo `tender`: DOC-02 não os cria (422 `DOCUMENT_TYPE_MANAGED_BY_MODULE`); a `MINUTA_CONTRATO` nasce em TND-11, na mesma transação do vínculo, e não pode ser finalizada por DOC-10 isoladamente quando vinculada a um `Tender` (RN-TND-132, US-168).
- **RN-TND-104** — Vínculo e anexo: `Tender.contractDraftDocumentId` aponta a minuta; ela é exibida como **anexo do edital** na aba e na pré-visualização do edital, com código e situação. A versão congelada do contrato fica registrada no snapshot do edital na conclusão (RN-TND-133, US-168). O contrato não tem aprovação avulsa: é aprovado em `AUTORIZACAO_LICITACAO` com o edital.
- **RN-TND-105** — Versão do TR a importar: por padrão a mesma usada na importação do edital (`Tender.importedFromTermVersionId`); sem importação do edital, a versão `APPROVED` mais recente, senão a `FINALIZED` mais recente, senão o rascunho atual com o aviso `TERM_NOT_FINALIZED`. A pessoa pode escolher "usar a versão mais recente do TR" (`termVersionId` opcional); se for posterior à do edital, vale `TERM_NEWER_THAN_TENDER_IMPORT`. A importação lê o snapshot da versão do TR (`DocumentFacade.getVersionSnapshot`), nunca o rascunho vivo (regra D11), e não altera o TR.
- **RN-TND-106** — Mapeamento: vem de `DocumentTemplateVersion.importMappings` da versão do template fixada na minuta, com origem `TR`: `sections[]` (alvo, fontes, `REPLACE` ou `APPEND`) e `fields[]` cujas fontes são as condições tipadas do TR (`contractDurationMonths`, `executionDeadline` com `executionDeadlineType`, `deliveryLocation`, `paymentTermDays`, `productWarrantyMonths`, `contractGuaranteePercent`, `allowsSubcontracting`) e cujo alvo é uma seção do contrato; cada condição vira uma **frase padronizada do template** (com o valor da fonte) na seção alvo. Mapeamento padrão semeado (a validar com o piloto): obrigações da contratada e da contratante, prazos e vigência, entrega, pagamento, garantias, fiscalização e sanções.
- **RN-TND-107** — Nada inventado: condição nula no TR gera, na frase do template, um marcador `toConfirm` (`origin = USER`; categoria `DEADLINE`, `VALUE`, `DATA` ou `DECISION` conforme a condição) com o rótulo "vigência do contrato", "prazo de pagamento", "garantia contratual", "possibilidade de subcontratação" etc. Frases do template só contêm números vindos da fonte. Conteúdo do TR com proveniência de IA não revisada chega à minuta do contrato **ainda pendente de revisão** e com seus `[a confirmar]` (regra de conservação da proveniência, US-122): a importação nunca "lava" conteúdo de IA.
- **RN-TND-108** — Sigilo do orçamento (DEC-030, art. 24): a minuta do contrato não importa valor estimado, preço de referência nem memória de cálculo; seções de origem com `render` `ESTIMATED_VALUE`/`PRICE_SUMMARY` saem da prévia quando `Tender.estimatedValueDisclosed = false`, independentemente de a pessoa ter `PROCESS_VIEW_CONFIDENTIAL_BUDGET`; o contrato fala em "valor da proposta vencedora". Valores não sigilosos do TR em texto livre de seções mapeadas (por exemplo, percentuais de multa) são copiados como estão.
- **RN-TND-109** — Importação em duas fases: `PREVIEW` é somente leitura, não grava nada e emite `importToken` assinado (versão do TR, revisão do rascunho da minuta, hash do cabeçalho do `Tender`, seleção padrão; 15 minutos). `APPLY` exige o token; qualquer mudança no TR (versão nova), na minuta (revisão de seção ou versão) ou no `Tender` desde a prévia invalida o token (410 `IMPORT_PREVIEW_EXPIRED`). A aplicação é seletiva: só as seções e condições marcadas são tocadas; seção `FILLED`/`NOT_APPLICABLE` só é substituída com `confirmReplaceFilled = true` (senão 422 `VALIDATION_ERROR`, `CONDITIONAL_REQUIRED`).
- **RN-TND-110** — Efeitos da aplicação, em uma transação: seções e frases gravadas no `draftContent` (`revision + 1` por seção), `DocumentVersion` (`reason = IMPORT`), `tenders.contractDraftImportedFromTermVersionId` e `contractDraftImportedAt`, auditoria `tender.import_term` (`metadata.target = CONTRACT_DRAFT`), eventos `TenderImportedFromTerm` e `DocumentVersionCreated`, entrada na timeline. Não há notificação.
- **RN-TND-111** — Defasagem: a leitura da minuta (e a prévia) calcula `termChangedSinceImport` quando existe versão do TR (`APPROVED`/`FINALIZED`) posterior a `contractDraftImportedFromTermVersionId`; é informativo, não bloqueia (a análise da US-168 o repete como aviso). A reimportação é sempre seletiva e nunca apaga o que a pessoa escreveu sem confirmação.
- **RN-TND-112** — Edição: pelas rotas genéricas do documento (DOC-04, DOC-05) com permissão `TENDER_UPDATE` + POL-02 (DRAFT/RETURNED, tipo permitido na etapa, processo editável), `If-Match` e controle de revisão por seção, presença de edição e autosave como nos demais documentos. Alterar a minuta não cria versão (ajuste de rascunho, DEC-017); a versão nasce na importação, em "salvar versão" (DOC-16) e na conclusão.
- **RN-TND-113** — Coerência com o cabeçalho: a prévia compara a vigência e a garantia contratual do TR com `Tender.contractTermMonths` e `Tender.guaranteePercent` e devolve `TENDER_HEADER_DIVERGENT` (campo, valor do TR, valor do edital) como aviso informativo; a importação não altera o `Tender` (o cabeçalho é do edital, US-163/US-164) e não bloqueia.
- **RN-TND-114** — Idempotência e concorrência: TND-11 e a aplicação de TND-12 exigem `Idempotency-Key` (24 h); a aplicação exige `If-Match`. Duas criações simultâneas resultam em uma 201 e uma 409 `TENDER_CONTRACT_DRAFT_EXISTS`; a prévia não precisa de chave.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Título da minuta | `title` | texto | Não | 5 a 250 caracteres, texto puro | "Minuta do contrato — {process.code}" |
| Modelo | `templateVersionId` | uuid (somente leitura na criação) | Não | versão publicada do template padrão do tipo `MINUTA_CONTRATO` | template padrão do órgão |
| Importar do TR ao criar | `importFromTerm` | booleano | Não | só efetivo se há TR; dispara a prévia, nunca a aplicação | `true` se há TR |
| Modo | `mode` | enum | Sim (TND-12) | `PREVIEW`, `APPLY` | — |
| Versão do TR | `termVersionId` | uuid | Não | versão do TR do mesmo processo; padrão RN-TND-105 | versão usada no edital |
| Seções a importar | `sections[].key`, `sections[].selected` | lista de checkboxes | Não (mín. 1 entre seções e condições) | chave deve existir no mapeamento do template | todas marcadas |
| Condições a importar | `conditions[].source`, `conditions[].selected` | lista de checkboxes | Não | fonte entre as condições do TR (RN-TND-106) | todas marcadas |
| Substituir o texto atual | `confirmReplaceFilled` | booleano | Condicional | obrigatório se marcar seção preenchida | `false` |
| *(sistema)* Token da prévia | `importToken` | texto assinado | Sim (`APPLY`) | emitido em `PREVIEW`; 15 min | gerado |
| *(sistema)* Versão da minuta | `If-Match` (ETag) | texto | Sim (`APPLY`) | ETag do documento | `GET` da minuta |
| *(sistema)* Chave de idempotência | `Idempotency-Key` | texto | Sim (TND-11 e `APPLY`) | 24 h | gerada pelo front |
| *(saída)* Código | `code` | texto | — | `MC {seq:4}/{year}` | gerador de números |
| *(saída)* Origem | `contractDraftImportedFromTermVersionId`, `contractDraftImportedAt` | uuid, timestamptz | — | RN-TND-110 | sistema |
| *(saída)* Defasagem | `termChangedSinceImport` | booleano | — | RN-TND-111 | calculado |
| *(saída)* Avisos da prévia | `warnings[].code` | enum | — | `TERM_NOT_FINALIZED`, `TERM_NEWER_THAN_TENDER_IMPORT`, `TENDER_HEADER_DIVERGENT` | calculado |
| *(saída)* Seções omitidas | `skipped[]` (`key`, `reason`) | lista | — | `CONFIDENTIAL_VALUE` | calculado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Título fora de 5 a 250 caracteres | Front + API (Zod) | "O título deve ter de 5 a 250 caracteres." | `VALIDATION_ERROR` |
| V-02 | Tipo `MINUTA_CONTRATO` sem modelo publicado | API | "Este tipo de documento não tem um modelo publicado. Fale com o administrador." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) |
| V-03 | `Tender` inexistente, de outro processo ou de outro tenant | API | "Edital não encontrado." | `NOT_FOUND` |
| V-04 | Edital fora de `DRAFT`/`RETURNED` ou processo não editável | API | "A minuta do edital não pode ser alterada agora." | `DOCUMENT_NOT_EDITABLE` / `INVALID_PROCESS_STATUS` |
| V-05 | Tipo não permitido na etapa atual | API | "A minuta do contrato não pode ser elaborada nesta etapa." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-06 | Já existe minuta do contrato ativa no edital | API | "Este edital já tem uma minuta de contrato. Abra a existente." | `TENDER_CONTRACT_DRAFT_EXISTS` |
| V-07 | Importar sem TR no processo | API | "Este processo não tem um TR para importar." | `TERM_REQUIRED_FOR_IMPORT` |
| V-08 | Nenhuma seção nem condição selecionada | Front + API (Zod) | "Selecione ao menos uma seção ou condição." | `VALIDATION_ERROR` |
| V-09 | `termVersionId` de outro processo, de outro tenant ou inexistente | API | "Selecione uma versão do TR deste processo." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-10 | `importToken` ausente, inválido, de outra minuta ou expirado; origem alterada | API | "O TR ou a minuta foram alterados. Atualizando a prévia…" | `VALIDATION_ERROR` / `IMPORT_PREVIEW_EXPIRED` |
| V-11 | Seção preenchida selecionada sem confirmar a substituição | Front + API | "Confirme a substituição do texto atual." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-12 | `If-Match` ausente ou divergente na aplicação | API | "A minuta foi alterada. Recarregue para continuar." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-13 | Criação do tipo gerido pelo módulo pelo catálogo de documentos | API | "Crie a minuta do contrato pela aba do edital." | `DOCUMENT_TYPE_MANAGED_BY_MODULE` |
| V-14 | `Idempotency-Key` ausente ou reutilizada com corpo diferente | API | "Esta chave já foi usada em outra solicitação." | `IDEMPOTENCY_KEY_REUSED` |

## Permissões
- **Permissão:** `TENDER_CREATE` com escopo que cubra o processo para criar (TND-11); `TENDER_UPDATE` para importar (TND-12) e editar (DOC-04, DOC-05); `DOCUMENT_CANCEL` para cancelar (DOC-13); `PROCESS_VIEW` para ler e pré-visualizar (DOC-03, DOC-20). Perfis padrão: `LICITACOES` e `GESTOR_CONTRATACOES` com `TENDER_CREATE` e `TENDER_UPDATE`; `CONSULTOR_EXTERNO` só `TENDER_UPDATE`, com efeito onde é participante.
- **Políticas:** POL-01 (custódia) e POL-02 (edição de documento: `DRAFT`/`RETURNED`, tipo permitido na etapa, processo editável; `MINUTA_CONTRATO` ← `TENDER_UPDATE`), POL-09 e DEC-030 (sigilo na importação), DEC-024 (visibilidade do processo).
- **MFA:** não exigido (`TENDER_CREATE` e `TENDER_UPDATE` são risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** "Criar minuta do contrato" e "Importar do TR" ficam ocultos sem `TENDER_CREATE`/`TENDER_UPDATE` e desabilitados com o motivo quando o edital não está editável; o editor fica somente leitura; a API responde 403 `PERMISSION_DENIED` ou `NOT_PROCESS_CUSTODIAN` e grava `access.denied`; edital ou processo de outro tenant responde 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentCreated` | `document.created.minuta_contrato` | Commit de TND-11 | `documentId`, `documentTypeCode = MINUTA_CONTRATO`, `kind = FREE_TEXT`, `code`, `templateVersionId`; projeta `DOCUMENT_CREATED` na timeline |
| `TenderUpdated` | `tender.updated` | Mesmo commit | `tenderId`, `changedFields = ['contractDraftDocumentId']` |
| `TenderImportedFromTerm` | `tender.imported_from_term` | Commit de TND-12 (`APPLY`) | `tenderId`, `termDocumentVersionId`, `sectionsImported[]`, `itemsImported = 0`, `lotsCreated = 0` e, aditivo, `target = CONTRACT_DRAFT` (ver lacuna 3); projeta `TENDER_IMPORTED_FROM_TERM` |
| `DocumentVersionCreated` | `document.version_created.minuta_contrato` | Mesmo commit | `reason = IMPORT` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: criar, importar e editar minuta são ajustes de trabalho, registrados só na timeline e na auditoria (padrão dos demais documentos); a conclusão e o encaminhamento notificam pelos fluxos da US-168 e da tramitação. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Elaborar a minuta do contrato

  Background:
    Given que o tenant "Prefeitura A" está ativo com o workflow padrão v2
    And o processo "0012/2026" está "IN_PROGRESS" na etapa "MINUTA_EDITAL" e tem orçamento não sigiloso
    And o "Tender" do processo existe com o edital "ED 0004/2026" em "DRAFT", importado da versão 2 do TR
    And o TR "TR 0003/2026" está "FINALIZED" na versão 2, com vigência de 12 meses, pagamento em 30 dias, garantia contratual de 5% e a seção "SANCTIONS" preenchida
    And o tipo "MINUTA_CONTRATO" tem modelo publicado com "importMappings" de origem "TR"
    And "Lia Santos" tem vínculo ativo no perfil "LICITACOES", com "TENDER_CREATE" e "TENDER_UPDATE" no processo, e custódia dele
    And "Carla Mendes", do perfil "PLANEJAMENTO", elaborou o TR

  Scenario: [Sucesso] Criar a minuta do contrato vinculada ao edital
    When "Lia Santos" criar a minuta do contrato com a chave "K1"
    Then a API deve responder 201 com o documento "MINUTA_CONTRATO" em "DRAFT", código "MC 0001/2026" e cabeçalho "Location"
    And o "Tender" deve apontar "contractDraftDocumentId" para o documento criado
    And o "draftContent" deve ter as seções do template, sem texto importado
    And deve gerar a auditoria "document.create" e a auditoria "tender.update" com "contractDraftDocumentId"
    And deve gerar os eventos "DocumentCreated" e "TenderUpdated" e a entrada "DOCUMENT_CREATED" na timeline

  Scenario: [Sucesso] Importar vigência, garantia, obrigações e pagamento do TR
    Given que a minuta do contrato existe em "DRAFT" e a seção "PAYMENT" está vazia
    When "Lia Santos" pedir a prévia da importação do TR
    Then a prévia deve trazer as seções mapeadas e as condições "contractDurationMonths", "paymentTermDays", "contractGuaranteePercent", "productWarrantyMonths" e "allowsSubcontracting"
    And a condição de vigência deve sair como a frase "Vigência de 12 meses" e a de pagamento como "Pagamento em até 30 dias"
    And a prévia deve trazer um "importToken" válido por 15 minutos e nada deve ser gravado
    When "Lia Santos" aplicar a importação com o token, "If-Match" atual e a chave "K2"
    Then a API deve responder 200 e as seções e condições marcadas devem estar no "draftContent"
    And deve existir uma "DocumentVersion" com "reason" igual a "IMPORT"
    And "contractDraftImportedFromTermVersionId" deve ser a versão 2 do TR e "contractDraftImportedAt" deve estar preenchido
    And deve gerar a auditoria "tender.import_term" com "target" igual a "CONTRACT_DRAFT" e os eventos "TenderImportedFromTerm" e "DocumentVersionCreated"
    And o TR não deve ter sido alterado

  Scenario: [Sucesso] Condição ausente no TR vira pendência, nunca suposição
    Given que o TR não informa "executionDeadline" nem "productWarrantyMonths"
    When "Lia Santos" aplicar a importação com todas as condições marcadas
    Then a frase de prazo de execução deve conter "[a confirmar: prazo de execução]" da categoria "DEADLINE" e a de garantia do objeto "[a confirmar: garantia do objeto]"
    And nenhum prazo ou garantia deve ter sido preenchido por suposição
    And a validação do documento deve apontar "SECTION_PLACEHOLDER_PENDING" nessas seções

  Scenario: [Sucesso] Orçamento sigiloso nunca entra na minuta do contrato
    Given que o orçamento do processo é sigiloso e o "Tender" tem "estimatedValueDisclosed" igual a "false"
    And o mapeamento traz a seção "ESTIMATED_VALUE" do TR
    When "Lia Santos" pedir a prévia da importação
    Then a seção "ESTIMATED_VALUE" deve constar em "skipped" com o motivo "CONFIDENTIAL_VALUE"
    And depois de aplicar, nenhum valor estimado, preço de referência ou memória de cálculo deve existir no texto da minuta

  Scenario: [Sucesso] Aviso de TR mais novo e divergência com o edital sem bloquear
    Given que o TR ganhou a versão 3 depois da importação do edital e a vigência do TR é 12 meses enquanto "contractTermMonths" do edital é 24
    When "Lia Santos" pedir a prévia da importação com a versão mais recente do TR
    Then a prévia deve trazer "TERM_NEWER_THAN_TENDER_IMPORT" e "TENDER_HEADER_DIVERGENT" com os dois valores
    And a importação deve poder ser aplicada e o "Tender" não deve ser alterado

  Scenario: [Sucesso] Conteúdo de IA do TR chega pendente de revisão
    Given que a seção "SANCTIONS" do TR foi gerada por IA e ainda não foi revisada
    When "Lia Santos" aplicar a importação com a seção "SANCTIONS"
    Then a seção "SANCTIONS" da minuta do contrato deve ficar "Gerado por IA — revisão pendente" e manter os marcadores "[a confirmar]"

  Scenario: [Sucesso] Reimportação seletiva preserva o que a pessoa escreveu
    Given que a minuta do contrato já foi importada e "Lia Santos" reescreveu a seção "PAYMENT"
    When ela importar de novo só as seções "GUARANTEES" e "SANCTIONS", confirmando a substituição do texto atual
    Then apenas essas seções devem ser alteradas e a seção "PAYMENT" deve manter o texto de "Lia Santos"
    And "contractDraftImportedAt" deve ser atualizado

  Scenario: [Sucesso] Metas de desempenho na suíte de performance
    Given um edital com TR de 14 seções e 200 itens
    When a suíte de performance executar 200 criações e importações da minuta do contrato
    Then o p95 de TND-11 deve ser de até 500 ms, o da prévia de TND-12 de até 700 ms e o da aplicação de até 900 ms

  Scenario: [Validação] Sem modelo, sem TR, sem seleção e título inválido
    Given que o tipo "MINUTA_CONTRATO" não tem modelo publicado
    When "Lia Santos" criar a minuta do contrato
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_INACTIVE" e nada deve ser criado
    Given que o modelo foi publicado e o processo não tem TR
    When "Lia Santos" pedir a prévia da importação
    Then a API deve responder 422 com código "TERM_REQUIRED_FOR_IMPORT"
    When "Lia Santos" criar a minuta com o título "abc"
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "title"
    When "Lia Santos" aplicar a importação sem nenhuma seção ou condição marcada
    Then a API deve responder 422 com código "VALIDATION_ERROR"

  Scenario: [Validação] Edital concluído, etapa não permitida e substituição sem confirmação
    Given que o edital "ED 0004/2026" está "FINALIZED"
    When "Lia Santos" criar a minuta do contrato
    Then a API deve responder 409 com código "DOCUMENT_NOT_EDITABLE"
    Given que a etapa ativa do processo não permite o tipo "MINUTA_CONTRATO"
    When "Lia Santos" criar a minuta do contrato
    Then a API deve responder 422 com código "DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE"
    Given que a seção "OVERSIGHT" da minuta já está preenchida
    When "Lia Santos" aplicar a importação com "OVERSIGHT" sem "confirmReplaceFilled"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" e a minuta não deve ser alterada
    When "Lia Santos" tentar criar o documento "MINUTA_CONTRATO" pela rota genérica de criação de documentos
    Then a API deve responder 422 com código "DOCUMENT_TYPE_MANAGED_BY_MODULE"

  Scenario: [Permissão] Sem TENDER_CREATE, sem custódia e consultor externo
    Given que "Bruno Lopes" não tem "TENDER_CREATE" no processo
    When "Bruno Lopes" criar a minuta do contrato
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar a auditoria "access.denied"
    Given que "Paulo Dias", do perfil "CONSULTOR_EXTERNO", é participante do processo com "TENDER_UPDATE"
    When "Paulo Dias" criar a minuta do contrato
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    When "Paulo Dias" importar do TR e editar a seção "DELIVERY" com a minuta em "DRAFT"
    Then a API deve responder 200 nas duas chamadas
    Given que a minuta está "FINALIZED"
    When "Paulo Dias" tentar editar a seção "DELIVERY"
    Then a API deve responder 409 com código "DOCUMENT_NOT_EDITABLE"

  Scenario: [Tenant incorreto] Edital e TR de outro órgão
    Given que o "Tender" "ED 0009/2026" pertence ao tenant "Prefeitura B"
    When "Lia Santos", da "Prefeitura A", criar a minuta do contrato nesse edital
    Then a API deve responder 404 com código "NOT_FOUND"
    When "Lia Santos" informar um "termVersionId" de um TR da "Prefeitura B"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND"
    And nada do tenant "Prefeitura B" deve ser lido nem alterado

  Scenario: [Duplicidade] Reenvio com a mesma chave e segunda minuta
    Given que "Lia Santos" criou a minuta do contrato com a chave "K1" e recebeu 201
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com "Idempotent-Replayed: true" e existir uma única minuta vinculada
    When "Lia Santos" tentar criar outra minuta do contrato com a chave "K9"
    Then a API deve responder 409 com código "TENDER_CONTRACT_DRAFT_EXISTS" e "meta.documentId" da minuta existente
    When "Lia Santos" reenviar a aplicação da importação já concluída com a mesma chave
    Then a API deve responder 200 com o mesmo resultado e existir uma única "DocumentVersion" "IMPORT"

  Scenario: [Concorrência] Criação simultânea e minuta editada durante a importação
    When "Lia Santos" e "Marcos Pires", do perfil "GESTOR_CONTRATACOES", criarem a minuta do contrato ao mesmo tempo
    Then exatamente uma criação deve responder 201 e a outra 409 com código "TENDER_CONTRACT_DRAFT_EXISTS"
    Given que "Lia Santos" abriu a prévia com a minuta na versão 3
    When "Marcos Pires" editar a seção "PAYMENT", gerando a versão 4, e "Lia Santos" aplicar com o token antigo
    Then a API deve responder 410 com código "IMPORT_PREVIEW_EXPIRED" e o texto de "Marcos Pires" deve ser preservado
    When "Lia Santos" aplicar a importação com "If-Match: \"3\"" depois de nova prévia
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    Given que "Carla Mendes" conclui a versão 3 do TR durante a prévia
    When "Lia Santos" aplicar com o token antigo
    Then a API deve responder 410 com código "IMPORT_PREVIEW_EXPIRED"

  Scenario: [Falha de banco] Banco indisponível na criação e na aplicação
    Given que o banco de dados fica indisponível durante a transação de criação
    When "Lia Santos" criar a minuta do contrato
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And não deve existir documento, vínculo, auditoria nem evento
    Given que o banco fica indisponível durante a transação de aplicação da importação
    When "Lia Santos" aplicar a importação
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e a minuta não deve ser alterada

  Scenario: [Falha de integração] Redis e relay do outbox indisponíveis
    Given que o Redis de idempotência está indisponível
    When "Lia Santos" criar a minuta do contrato
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e nada deve ser criado
    Given que o relay do outbox está indisponível
    When "Lia Santos" criar a minuta do contrato com sucesso
    Then a API deve responder 201 e os eventos "DocumentCreated" e "TenderUpdated" devem permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Título ou corpo inválidos | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca o campo |
| Sem modelo publicado | 422 | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) | "Este tipo de documento não tem um modelo publicado. Fale com o administrador." | Mostra a orientação e desabilita a criação |
| Sem TR para importar | 422 | `TERM_REQUIRED_FOR_IMPORT` | "Este processo não tem um TR para importar." | Esconde "Importar do TR" |
| Já existe minuta ativa | 409 | `TENDER_CONTRACT_DRAFT_EXISTS` | "Este edital já tem uma minuta de contrato. Abra a existente." | Abre a minuta existente |
| Edital ou minuta não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "A minuta não pode ser alterada agora." | Editor somente leitura com o motivo |
| Processo fora de `IN_PROGRESS` | 409 | `INVALID_PROCESS_STATUS` | "O processo não está disponível para edição no momento." | Desabilita as ações |
| Tipo fora da etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "A minuta do contrato não pode ser elaborada nesta etapa." | Oculta as ações |
| Tipo gerido pelo módulo | 422 | `DOCUMENT_TYPE_MANAGED_BY_MODULE` | "Crie a minuta do contrato pela aba do edital." | Leva à aba do edital |
| Prévia expirada ou origem alterada | 410 | `IMPORT_PREVIEW_EXPIRED` | "O TR ou a minuta foram alterados. Atualizando a prévia…" | Recarrega a prévia mantendo a seleção |
| Substituição sem confirmar | 422 | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) | "Confirme a substituição do texto atual." | Destaca a seção |
| `If-Match` ausente / divergente | 428 / 412 | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` | "A minuta foi alterada. Recarregue para continuar." | Oferece "Ver versão atual" |
| Sem permissão ou custódia | 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | "Você não tem permissão para elaborar a minuta do contrato." | Oculta as ações |
| Edital, minuta ou TR inexistente ou de outro tenant | 404 | `NOT_FOUND` | "Registro não encontrado." | Volta à aba do edital |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco ou Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém o diálogo; respeita `Retry-After` |

## Dependências
- **Stories:** US-038 (condições contratuais tipadas e itens do TR, fonte da importação), US-163 (`Tender`, documento `EDITAL`, cabeçalho tipado e edição). Indiretas: US-036 (seções do TR), US-037 (padrão de importação com prévia e `importToken`), US-039 (TR concluído), US-164 (importação do TR para o edital, versão de origem), US-065 (ciclo de vida e DOC-04/DOC-05), US-066 (versões), US-067 (PDF e prévia), US-110 (templates e `importMappings`), US-122 (conservação da proveniência de IA), US-168 (conclusão conjunta e análise de pendências).
- **Decisões/ADRs:** DEC-016, DEC-017, DEC-018, DEC-030, DEC-196, DEC-201, DEC-202 (a IA não redige o contrato).
- **Configurações:** template e `importMappings` do tipo `MINUTA_CONTRATO` (biblioteca padrão v2 e versão do órgão); nenhuma chave `tender.*` nova.
- **Lacunas nas fontes canônicas:**
  1. **`importMappings` de origem TR:** o schema de `entities.md` (MVP 1, §5.8) é `fromDocumentType: 'ETP'` com `fields[].target` em campo de cabeçalho. Esta story adota `fromDocumentType: 'ETP' | 'TR'` e, para o contrato (documento `FREE_TEXT`), `fields[]` com fonte numa condição tipada do TR e alvo em **seção** do contrato, escrita como frase padronizada do template (RN-TND-106). A validação de template (`TEMPLATE_INVALID`) precisa aceitar o alvo e rejeitar fontes inexistentes. Alinhar com a US-164 (mapeamento TR → EDITAL) e com o `entities.md` do MVP 2.
  2. **Colunas novas em `tenders`:** `contractDraftImportedFromTermVersionId` (FK `document_versions`, nulo) e `contractDraftImportedAt` (timestamptz, nulo), mais índice único parcial em `contractDraftDocumentId`. `entities.md` §4.5 só traz `importedFromTermVersionId`/`importedAt` (da importação do edital). Incluir na migração M2-14.
  3. **Evento da importação do contrato:** `events.md` §4.7 define `TenderImportedFromTerm` sem distinguir o alvo. Proposta: campo aditivo opcional `target` (`TENDER` por padrão, `CONTRACT_DRAFT`), sem subir `eventVersion`, e o modelo da timeline `TENDER_IMPORTED_FROM_TERM` com variante "para a minuta do contrato".
  4. **Códigos novos de erro e de aviso:** `TENDER_CONTRACT_DRAFT_EXISTS`, `TERM_REQUIRED_FOR_IMPORT`, `DOCUMENT_TYPE_MANAGED_BY_MODULE` e os avisos `TERM_NOT_FINALIZED`, `TERM_NEWER_THAN_TENDER_IMPORT`, `TENDER_HEADER_DIVERGENT` não constam de `api.md`; consolidar no `api.md` do MVP 2. DOC-02 (US-063) precisa recusar `EDITAL` e `MINUTA_CONTRATO` (tipos geridos pelo módulo `tender`).
  5. **Anexo do edital:** não há relação documento ↔ documento nem variável de template `{{tender.contractDraft.*}}` (lista fechada de variáveis, MVP 1 §5.2). A story mostra o anexo na aba e na prévia pelo `Tender.contractDraftDocumentId`; a seção "Anexos" do template do edital depende de uma variável nova ou de um `render` de anexos (decisão do card do template, US-110/US-163).
  6. **Base legal do anexo:** a referência ao art. 25, § 1º, e ao art. 92 vem do briefing do épico; confirmar a redação com o jurídico do piloto.
  7. **`TENDER_CREATE` x criação da minuta do contrato:** `permissions.md` associa `TENDER_CREATE` à criação da minuta do edital e da `MINUTA_CONTRATO`; `CONSULTOR_EXTERNO` só tem `TENDER_UPDATE` e portanto não cria a minuta do contrato. Confirmar com o produto.

## Impacto técnico
- **Documento sem módulo tipado:** `MINUTA_CONTRATO` é `FREE_TEXT`; o módulo `tender` só orquestra criação, vínculo e importação. A completude do contrato vem do serviço genérico (seções e campos do template, `SECTION_*` e `[a confirmar]`), e a conclusão conjunta é da US-168.
- **Importação:** reutiliza o desenho da US-037 (prévia sem gravação, `importToken` assinado, 15 minutos, 410 ao divergir). O contrato lê o **snapshot** do TR por `DocumentFacade.getVersionSnapshot` e as condições tipadas pela fachada de leitura do `term`; o `tender` não escreve em `term` (regra D9).
- **Sigilo:** a omissão de seções com valor é decidida pelo servidor a partir de `estimatedValueDisclosed`; a prévia e o log nunca carregam texto de seção nem valores.
- **Concorrência:** a trava da linha do `Tender` serializa criações; o índice único parcial é a defesa final; a aplicação revalida o token e o `If-Match` dentro da transação.
- **Compatibilidade:** nenhum contrato do MVP 1 muda além de DOC-02 recusar os tipos geridos pelo `tender`; a importação nova só acrescenta a origem `TR` ao `importMappings`.
- **Performance:** a prévia lê um snapshot e as condições tipadas (uma consulta cada); a aplicação grava seções em uma transação curta. Metas p95 de 500 ms (criação), 700 ms (prévia) e 900 ms (aplicação) vão para a suíte de performance, medidas no endurecimento.

## Backend
- **Módulo(s):** `tender` (dono: criação, vínculo, importação), `document` (criação a partir de template, numeração, versões, ciclo de vida), `term` (fachada de leitura das condições), `process`, `catalog`, `tenancy`, `access`, `timeline`, `audit`, `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `CreateContractDraftCommand` (TND-11); `PreviewContractDraftImportQuery` e `ApplyContractDraftImportCommand` (TND-12, `mode`); `GetTenderQuery` (US-163) passa a devolver `contractDraft` (documento, situação, `termChangedSinceImport`).
- **Domínio:** `Tender.linkContractDraft(documentId)` (invariante: no máximo uma ativa); `ContractDraftImportPlanner` (mapeamento, frases, marcadores, omissão por sigilo, `skipped`); `ImportToken` (assinatura e conteúdo, compartilhado com a US-037); `TermConditionsSentenceRenderer` (frase do template por condição e `toConfirm` quando nula).
- **Integrações internas:** `DocumentFacade.createFromTemplate` (documento `MINUTA_CONTRATO`, código `MC`), `DocumentFacade.getVersionSnapshot` (TR), `DocumentFacade.applySections` (seções e proveniência), `TermReadFacade.getConditions`, `AuthorizationService.assertCan('TENDER_CREATE'|'TENDER_UPDATE', { processId })`, `ConfidentialBudgetGuard`, `AuditService`, `TimelineProjector`.
- **Transação:** TND-11: trava do `Tender` → validações → documento + vínculo → auditoria → outbox → commit. TND-12 `APPLY`: revalidação do token → seções e frases → versão `IMPORT` → colunas de origem → auditoria → outbox → commit; a prévia não abre transação de escrita.

## Frontend
- **Tela(s):** SCR-021 (`/processos/[id]/edital/[tenderId]`), aba "Minuta do contrato".
- **Componentes:** `ContractDraftPanel`, `ContractDraftCreateDialog`, `TermImportPreview` (antes e depois por seção, lista de condições em frase, marcadores "[a confirmar]", avisos), `TermChangedBanner`, editor de seções do documento (TipTap) com `AiGeneratedBadge` e `ToConfirmChip` (US-122), `ContractAnnexBadge` (anexo do edital), `ConfirmationDialog`.
- **Estados:** carregando (skeleton); vazio (sem minuta, com ação de criar); criando; prévia carregando, pronta e expirada (recarrega); aplicando; erro por código traduzido; somente leitura (sem permissão, edital concluído ou fora de etapa) com o motivo.
- **Acessibilidade e responsividade:** foco devolvido ao botão após fechar o diálogo; progresso e resultado anunciados por `aria-live`; marcadores `[a confirmar]` com `aria-label` "Pendência a confirmar: {rótulo}" e não só cor; em telas abaixo de 768 px o "antes e depois" vira abas "Atual" e "Importado"; contraste AA nos temas claro e escuro.

## Banco de dados
- **Tabelas:** `documents` (insert, tipo `MINUTA_CONTRATO`), `document_versions` (insert na importação), `tenders` (update de `contract_draft_document_id` e das colunas de origem), `audit_logs`, `outbox_events`, `timeline_entries`; leitura de `document_versions` (TR), `terms_of_reference`, `document_template_versions` e `catalog_items`.
- **Migrações:** na M2-14 (expand de `tenders`), acrescentar `contract_draft_imported_from_term_version_id` (FK, nulo), `contract_draft_imported_at` (nulo) e o índice único parcial; semente da biblioteca padrão v2 (template `MINUTA_CONTRATO` com as cláusulas do art. 92 e `importMappings` de origem `TR`).
- **Índices/constraints relevantes:** único parcial `(tenant_id, contract_draft_document_id) WHERE contract_draft_document_id IS NOT NULL`; FK composta com `tenant_id`; RLS por `tenant_id` em todas as tabelas.

## API
_Indicativa; IDs e contratos finais no `api.md` do MVP 2._

| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `TND-11` | POST | `/api/v1/tenders/{id}/contract-draft` | `{ title?, importFromTerm? }` + `Idempotency-Key` | `201 { data: { document, tender: { contractDraftDocumentId } } }` + `Location`, `ETag` | 201, 401, 403, 404, 409, 422, 503 |
| `TND-12` | POST | `/api/v1/tenders/{id}/contract-draft/import-term` | `{ mode: 'PREVIEW', termVersionId? }` ou `{ mode: 'APPLY', importToken, sections[], conditions[], confirmReplaceFilled? }` + `If-Match` + `Idempotency-Key` (só `APPLY`) | `PREVIEW`: `200 { data: { termVersion, sections[], conditions[], skipped[], warnings[], importToken, expiresAt } }`; `APPLY`: `200 { data: { document, sectionsImported[], conditionsImported[] } }` | 200, 401, 403, 404, 409, 410, 412, 422, 428, 503 |
| `DOC-03` | GET | `/api/v1/documents/{id}` | — | minuta com `draftContent`, `status`, `ETag` (MVP 1) | 200, 403, 404 |
| `DOC-04` / `DOC-05` | PATCH / PUT | `/api/v1/documents/{id}` e `/documents/{id}/sections/{sectionKey}` | MVP 1 | edição do rascunho (POL-02) | 200, 403, 404, 409, 412, 422 |
| `DOC-13` | POST | `/api/v1/documents/{id}/cancel` | MVP 1 | cancela a minuta em `DRAFT`/`RETURNED` | 200, 403, 404, 409, 412, 422 |
| `DOC-20` | POST | `/api/v1/documents/{id}/preview` | MVP 1 | prévia em PDF do rascunho | 202, 403, 404, 422 |

## Logs
- `info` `tender.contract_draft_created` — `tenderId`, `documentId`, `processId`, `durationMs`, `correlationId`.
- `info` `tender.contract_draft_import_previewed` e `tender.contract_draft_import_applied` — `tenderId`, `termVersionNumber`, `sectionsCount`, `conditionsCount`, `skippedCount`, `durationMs`.
- `warn` `tender.contract_draft_exists` (409), `tender.import_preview_expired` (410), `idempotency.store_unavailable`.
- `error` `tender.contract_draft_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** texto das seções, valores do TR ou do orçamento sigiloso, nomes de pessoas, conteúdo do `importToken`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.create` | `DATA_CHANGE` | Commit de TND-11 | `metadata`: `documentTypeCode = MINUTA_CONTRATO`, `templateVersionId`, `code`, `idempotencyKey` |
| `tender.update` | `DATA_CHANGE` | Mesmo commit | `changes`: `contractDraftDocumentId` (de nulo ou do documento cancelado); `metadata`: `tenderId` |
| `tender.import_term` | `DATA_CHANGE` | Commit de TND-12 (`APPLY`) | `metadata`: `target = CONTRACT_DRAFT`, `termDocumentVersionId`, `sectionsImported[]`, `conditionsImported[]`, `replacedFilledSections`, `idempotencyKey`; sem texto |
| `access.denied` | `ACCESS` | 403 em TND-11 ou TND-12 | `reasonCode` (`TENDER_CREATE`, `TENDER_UPDATE`, `NOT_PROCESS_CUSTODIAN`), `tenderId` |

## Testes necessários
- **Unitários:** `ContractDraftImportPlanner` (mapeamento por seção e condição, `REPLACE`/`APPEND`, omissão por sigilo, condição nula vira marcador); `TermConditionsSentenceRenderer` (frases só com números da fonte; todas as condições); `ImportToken` (assinatura, expiração, invalidação por TR, minuta e `Tender`); invariante de vínculo único; precedência da versão do TR (RN-TND-105); detecção de `TENDER_HEADER_DIVERGENT`.
- **Integração (Testcontainers PostgreSQL + Redis):** criação com documento, vínculo, auditoria e outbox na mesma transação; importação com `DocumentVersion` `IMPORT` e colunas de origem; criação simultânea (índice único e trava); cancelar e recriar; rollback total na falha; RLS entre tenants; proveniência de IA conservada na importação.
- **API/contrato:** TND-11 e TND-12 conforme o `api.md` (`Location`, `ETag`, `Idempotent-Replayed`, 410, 412, 428); DOC-02 recusando os tipos geridos pelo módulo; formato `violations[]` do documento.
- **RBAC e multi-tenant:** `TENDER_CREATE` e `TENDER_UPDATE` por perfil e escopo (inclusive `CONSULTOR_EXTERNO` e participação); POL-01 e POL-02; edital, TR e minuta de outro tenant → 404; teste novo na suíte `test/tenant-leak` (criação e importação nunca leem nem gravam em outro tenant).
- **Concorrência:** duas criações simultâneas; prévia x edição da minuta; prévia x nova versão do TR; `If-Match` desatualizado; reenvio idempotente.
- **E2E (Playwright):** criar o edital → criar a minuta do contrato → prévia e aplicação da importação → resolver `[a confirmar]` → pré-visualizar o PDF; variante com orçamento sigiloso e variante com TR novo depois da importação.
- **Acessibilidade/performance:** axe sem violações sérias no painel e no diálogo de importação; 360 px; p95 de TND-11, TND-12 (prévia e aplicação) nas metas acima, na suíte de performance (medidos no endurecimento).

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
- [ ] Teste prova que nenhum valor estimado nem preço de referência entra na minuta do contrato com orçamento sigiloso
- [ ] Teste prova que condição ausente no TR gera `[a confirmar]` e que a proveniência de IA do TR chega pendente
- [ ] Teste de falha induzida comprova a transação única de criação (documento, vínculo, auditoria e evento) e a unicidade do vínculo sob concorrência

## Estimativa
**M** — não há entidade nova nem módulo tipado: o esforço está na criação vinculada com unicidade sob concorrência, na importação em duas fases com `importMappings` de origem TR (frases por condição, marcadores, omissão por sigilo, conservação da proveniência) e nos testes de concorrência e de isolamento.

## Prioridade
**P0** — sem a minuta do contrato o edital segue incompleto para o Jurídico (art. 53 analisa edital e contrato) e a regra de saída da etapa `MINUTA_EDITAL` emite aviso; a importação do TR é o que evita a redigitação e a divergência entre contrato, edital e TR.

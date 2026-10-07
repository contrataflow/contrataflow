---
id: US-036
title: "Criar TR e editar suas seções"
epic: EP-006
feature: FT-024
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-015, US-065, US-110]
modules: [term, document, process, price-research, catalog, access, timeline, audit, platform]
screens: [SCR-012, SCR-006]
endpoints: [TRM-01, TRM-02, TRM-03, TRM-04, DOC-05, DOC-08, DOC-20, TPL-01]
permissions: [TERM_CREATE, TERM_UPDATE, PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [DocumentCreated]
---

# US-036 — Criar TR e editar suas seções

## Título
Criar o Termo de Referência e editar suas seções

## Descrição
**Como** analista de planejamento responsável pela etapa "Termo de Referência", **quero** criar o TR do processo a partir do modelo padrão do órgão e redigi-lo seção por seção, com salvamento automático, orientação legal e indicador de completude, **para** produzir um TR que contenha todos os elementos do art. 6º, XXIII, da Lei 14.133/2021 sem partir de um documento em branco.

A criação gera, em uma única transação, o `Document` do tipo `TR` (numerado, em `DRAFT`, com a versão do template fixada) e o cabeçalho tipado `TermOfReference`. O editor SCR-012 apresenta navegação lateral com as seções do template (estado e obrigatoriedade de cada uma), o painel "Dados do TR" (objeto e valor estimado — as condições contratuais tipadas ficam em US-038) e reutiliza integralmente o mecanismo de autosave por seção de US-015 (DOC-05). O valor estimado vem da pesquisa de preços concluída (`priceResearchId`) ou é informado manualmente com justificativa, sempre respeitando o sigilo do orçamento (POL-09).

## Contexto
- O TR é obrigatório para a contratação de bens e serviços (art. 6º, XXIII; art. 40, § 1º, para compras) e, no regulamento federal, segue a IN SEGES/ME 81/2022. Hoje os órgãos copiam modelos em editores de texto, perdem elementos obrigatórios e redigitam o que já está no ETP (dor da persona Planejamento).
- Modelo documental híbrido (DEC-017): seções narrativas vêm do template (`DocumentTemplateVersion.sections`) e ficam em `Document.draftContent`; campos que o sistema precisa validar e comparar ficam no cabeçalho tipado `TermOfReference`; itens em `DocumentItem` (US-038). Ciclo de vida único (DEC-018); valor estimado por precedência (DEC-032); sigilo (DEC-030).
- No workflow padrão (DEC-015) o TR é elaborado na etapa `TERMO_REFERENCIA`, cuja saída exige "TR completo", e é aprovado em conjunto com ETP, mapa de riscos e pesquisa na etapa `APROVACAO_AUTORIDADE`. No workflow "Contratação direta — art. 72" é elaborado na etapa `INSTRUCAO`, quando cabível.
- Importação do ETP: US-037. Itens e condições: US-038. Validação e conclusão: US-039. Biblioteca com o template de TR semeado: US-110.

### Seções do TR × Lei 14.133/2021, art. 6º, XXIII
As 14 chaves abaixo são as seções do módulo tipado (entities.md §4.8). A coluna `requirement` traz o padrão da biblioteca (US-110), ajustável por template (US-107).

| # | Chave (`key`) | Título padrão | Alínea do art. 6º, XXIII (e outros dispositivos) | `requirement` padrão | `render` |
|---|---|---|---|---|---|
| 1 | `OBJECT` | Definição do objeto | *a* — natureza, quantitativos, prazo do contrato e possibilidade de prorrogação; art. 40, § 1º, I | `REQUIRED` | `TEXT` |
| 2 | `JUSTIFICATION` | Fundamentação da contratação | *b* — referência ao ETP (ou extrato das partes não sigilosas) | `REQUIRED` | `TEXT` |
| 3 | `SPECIFICATIONS` | Descrição da solução e requisitos da contratação | *c* (solução como um todo, ciclo de vida) e *d* (requisitos); art. 40, § 1º, I | `REQUIRED` | `ITEMS_TABLE` |
| 4 | `ACCEPTANCE_CRITERIA` | Recebimento e critérios de aceitação | *g* (critérios de medição); art. 40, § 1º, II; art. 140 | `REQUIRED` | `TEXT` |
| 5 | `CONTRACTOR_OBLIGATIONS` | Obrigações da contratada | *e* (modelo de execução); art. 92, XIV e XVI; art. 122 (subcontratação) | `REQUIRED` | `TEXT` |
| 6 | `CONTRACTING_PARTY_OBLIGATIONS` | Obrigações da contratante | *e* e *f*; art. 92, XIV | `REQUIRED` | `TEXT` |
| 7 | `DEADLINES` | Prazos de vigência e de execução | *a* (prazo e prorrogação) e *e*; arts. 105 a 107 | `REQUIRED` | `TEXT` |
| 8 | `DELIVERY` | Local e condições de entrega ou de execução | *e*; art. 40, § 1º, II | `REQUIRED_OR_JUSTIFY` | `TEXT` |
| 9 | `PAYMENT` | Critérios de medição e de pagamento | *g*; art. 92, V e VI | `REQUIRED` | `TEXT` |
| 10 | `OVERSIGHT` | Modelo de gestão e fiscalização do contrato | *f*; art. 117 | `REQUIRED` | `TEXT` |
| 11 | `GUARANTEES` | Garantias | Art. 40, § 1º, III (garantia do objeto); arts. 96 a 98 (garantia contratual); art. 92, XII e XIII | `REQUIRED_OR_JUSTIFY` | `TEXT` |
| 12 | `SANCTIONS` | Sanções administrativas | Art. 92, XIV; arts. 155 a 163 | `REQUIRED` | `TEXT` |
| 13 | `SELECTION_CRITERIA` | Forma e critérios de seleção do fornecedor | *h*; art. 33 (critério de julgamento); arts. 62 a 70 (habilitação) | `REQUIRED` | `TEXT` |
| 14 | `ESTIMATED_VALUE` | Estimativa do valor da contratação | *i* — preços unitários referenciais e memórias de cálculo; art. 23; art. 24 (sigilo) | `REQUIRED` | `ESTIMATED_VALUE` |
| + | `BUDGET_ADEQUACY` | Adequação orçamentária | *j* — seção adicional semeada pela biblioteca (US-110); dotação estruturada no MVP 2 (`BudgetAllocation`) | `REQUIRED_OR_JUSTIFY` | `TEXT` |

O template pode acrescentar outras seções (ex.: "Modelo de execução" e "Modelo de gestão" separados, para órgãos que adotem literalmente a estrutura da IN SEGES/ME 81/2022, ou exigências de decreto municipal); seções adicionais seguem as mesmas regras de edição e completude.

## Objetivo
Permitir criar o TR em até 1 minuto e redigi-lo integralmente no editor por seções, com 100% dos TRs criados com número único, versão de template fixada, cabeçalho tipado e seções inicializadas, autosave sem perda de conteúdo (conflito apenas na mesma seção) e valor estimado com origem rastreável e mascarado conforme o sigilo.

## Persona
- **Principal:** Planejamento (perfil `PLANEJAMENTO`) — "Paula", responsável pela etapa `TERMO_REFERENCIA`.
- **Secundárias:** Área requisitante (`REQUISITANTE`) e Compras (`COMPRAS`), que também têm `TERM_CREATE`/`TERM_UPDATE`; Gestor de contratações (`GESTOR_CONTRATACOES`); Consultoria externa (`CONSULTOR_EXTERNO`) e servidores de Licitações, Fiscal ou Gestor de contrato convidados como `COLLABORATOR`/`CONSULTANT` (editam seções em `DRAFT`/`RETURNED`).

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` (US-087, US-097).
- Processo visível, em `DRAFT`, `IN_PROGRESS` ou `RETURNED`, cuja etapa atual permite o tipo `TR` (`WorkflowStage.documentTypeCodes` vazio ou contendo `TR`).
- Tipo `TR` ativo com template publicado e padrão definido (US-108, US-110).
- Mecanismo de edição por seção e autosave disponível (US-015) e ciclo de vida de documento (US-065).

## Fluxo principal
1. No detalhe do processo (SCR-006), o painel situacional indica "Elabore o Termo de Referência"; "Paula" clica em **"Criar Termo de Referência"** (painel ou aba Documentos).
2. O sistema abre o diálogo de criação e carrega os templates ativos do tipo `TR` com versão publicada (`TPL-01`, lista resumida), pré-selecionando o padrão do tipo. Campos: **Modelo**, **Título** (padrão "Termo de Referência — {título do processo}") e, se existir ETP no processo, a opção **"Importar dados do ETP em seguida"** (marcada).
3. "Paula" confirma. O front envia `POST /api/v1/processes/{id}/terms` com `Idempotency-Key`.
4. A API, em uma transação com `app.tenant_id` definido:
   1. valida o corpo e a referência ao template (ativo, do tipo `TR`, com `currentPublishedVersionId`);
   2. autoriza `TERM_CREATE` com escopo que cubra o processo e aplica POL-02 à criação (custódia, status do processo, tipo permitido na etapa);
   3. bloqueia o processo (`SELECT … FOR UPDATE`) e verifica que não há TR não cancelado (`singletonKey`);
   4. obtém o número na sequência `DOCUMENT:TR:<escopo>:<ano>` e formata o `code` (ex.: `TR 0003/2026`);
   5. insere `Document` (`DRAFT`, `templateVersionId` = versão publicada vigente, `singletonKey`, `confidentiality`, `responsibleId` = criador) com `draftContent` inicializado a partir das seções do template;
   6. insere `TermOfReference` (`objectDefinition` = objeto do processo, valores padrão do `fieldConfig`) e, havendo pesquisa de preços concluída, vincula `priceResearchId` e o valor;
   7. grava `AuditLog` `document.create`, o evento `DocumentCreated` (routing key `document.created.tr`) no outbox e, pelo projetor síncrono, a entrada `DOCUMENT_CREATED` na timeline; confirma.
5. A API responde **201** com o TR, `Location: /api/v1/terms/{id}` e `ETag`. O front navega para SCR-012 (`/processos/{id}/tr/{termId}`) e, se a opção estiver marcada, abre a prévia de importação do ETP (US-037).
6. O editor exibe: cabeçalho com código, status e selo "Em aprovação" quando houver `pendingApprovalId` (DEC-018); navegação lateral com as seções na ordem do template (ícones Vazia / Preenchida / Não se aplica, marcador de obrigatória e percentual de completude); painel "Dados do TR"; atalhos para "Itens" (US-038) e "Validação" (US-039).
7. Ao selecionar uma seção, o editor TipTap mostra título, orientação (`helpText`) e base legal (`legalBasis`, em tooltip com link ao glossário). "Paula" redige; após 1,5 s sem digitação ou ao perder o foco, o front envia `PUT /api/v1/documents/{documentId}/sections/{sectionKey}` com `If-Match: "s<revision>"`; o indicador mostra "Salvando…" → "Salvo às HH:mm" e a completude é recalculada.
8. Em seções `REQUIRED_OR_JUSTIFY` ou `OPTIONAL`, "Paula" pode marcar **"Não se aplica"** e informar a justificativa (≥ 20 caracteres), salva pelo mesmo endpoint.
9. No painel "Dados do TR", "Paula" revisa o **Objeto (resumo)** e o **Valor estimado**: se vinculado à pesquisa, vê o total, a origem "Pesquisa de preços {code}" e o link; se não houver pesquisa concluída, pode **"Informar manualmente"** (valor + justificativa na seção `ESTIMATED_VALUE`). As alterações usam `PATCH /api/v1/terms/{id}` com `If-Match`.
10. A qualquer momento, "Paula" aciona **"Pré-visualizar PDF"** (DOC-20, marca d'água "RASCUNHO" — US-067).

## Fluxos alternativos
- **FA-01 — Escolher outro modelo:** havendo mais de um template ativo do tipo `TR` (ex.: "TR — Serviços contínuos"), o usuário escolhe no diálogo; sem nenhum publicado, o botão fica desabilitado com "Não há modelo de TR publicado. Fale com o administrador do órgão."
- **FA-02 — TR já existente:** o painel mostra "Abrir Termo de Referência" em vez de "Criar"; uma criação concorrente ou por chamada direta recebe 409 `DOCUMENT_ALREADY_EXISTS` com o link para o TR existente.
- **FA-03 — Conflito de autosave na mesma seção:** outro colaborador salvou a seção antes; a API responde 412 `SECTION_REVISION_CONFLICT` e o editor abre o diálogo de US-015 ("Ver diferenças", "Manter a minha versão", "Descartar a minha e recarregar"). Edições em seções diferentes nunca conflitam (DEC-055).
- **FA-04 — Valor manual com pesquisa concluída disponível:** o sistema exibe o aviso "Existe pesquisa de preços concluída ({code}). O valor manual tem precedência menor e exige justificativa." (DEC-032); o usuário pode confirmar ou "Usar o valor da pesquisa".
- **FA-05 — Orçamento sigiloso:** com `isBudgetConfidential = true`, quem não atende POL-09 vê "Valor sigiloso" no painel e na seção `ESTIMATED_VALUE`; a API retorna `estimatedTotalValue: null` e `estimatedTotalValueMasked: true`.
- **FA-06 — TR em status não editável:** em `FINALIZED`, `APPROVED`, `IN_REVIEW` ou `REJECTED`, o editor abre em modo leitura com a faixa "Documento concluído — para alterar, reabra (US-039)"; tentativas de salvar recebem 409 `DOCUMENT_NOT_EDITABLE`.
- **FA-07 — Edição offline curta:** sem rede, o autosave grava o rascunho local (IndexedDB) e reenvia ao reconectar, com a mesma revisão base (DEC-182).
- **FA-08 — Participante colaborador:** usuário `COLLABORATOR`/`CONSULTANT` (ex.: consultor externo) edita seções e o painel "Dados do TR" em `DRAFT`/`RETURNED`, mas não vê "Criar", "Concluir" nem ações de tramitação.

## Regras de negócio
- **RN-TR-01** — Um TR não cancelado por processo (`DocumentType.allowMultiplePerProcess = false`; `singletonKey = documentTypeId`); nova criação → 409 `DOCUMENT_ALREADY_EXISTS`.
- **RN-TR-02** — Criar exige `TERM_CREATE` com escopo que cubra o processo, custódia (POL-01), processo em `DRAFT`/`IN_PROGRESS`/`RETURNED` e tipo `TR` permitido na etapa atual (POL-02); participantes não criam o TR.
- **RN-TR-03** — Template: o `templateId` informado deve ser `DocumentTemplate` ativo do tipo `TR` com versão publicada; omitido, usa `DocumentType.defaultTemplateId`. O documento fixa `templateVersionId` (versão publicada vigente) — versões posteriores do template não o alteram (US-108).
- **RN-TR-04** — Numeração por `DocumentType.numberingMask` ou `numbering.document.defaultMask` (`{type} {seq:4}/{year}` → `TR 0003/2026`), sequência transacional sem lacunas por rollback (DEC-028).
- **RN-TR-05** — `draftContent` inicial: uma entrada por seção do template; com `defaultContent` → variáveis `{{…}}` resolvidas no servidor e `state = FILLED`; sem → `EMPTY`; `revision = 1`.
- **RN-TR-06** — Cabeçalho inicial: `objectDefinition = process.object`; campos com valor padrão no `fieldConfig` da versão do template recebem esse valor; demais nulos.
- **RN-TR-07** — Se o processo tiver `PriceResearch` cujo documento esteja `FINALIZED` ou `APPROVED`, o TR nasce com `priceResearchId`, `estimatedTotalValue = totalEstimatedValue` e `estimatedValueSource = PRICE_RESEARCH`.
- **RN-TR-08** — Origens do valor estimado do TR: `PRICE_RESEARCH` (valor = total da pesquisa vinculada; somente leitura; revincular atualiza), `ETP` (importação — US-037) e `MANUAL` (≥ 0, 2 casas). Valor `MANUAL` exige que a seção `ESTIMATED_VALUE` contenha a justificativa e a memória do valor — cobrado na validação (US-039).
- **RN-TR-09** — Sigilo (DEC-030, POL-09): com `isBudgetConfidential = true` o TR é criado com `confidentiality = RESTRICTED` (contém o valor estimado); valores são mascarados no serializador central para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo nem a custódia. A reclassificação quando o sigilo muda é responsabilidade de US-013.
- **RN-TR-10** — Editar seções e o painel "Dados do TR" segue POL-02: `TERM_UPDATE` + (custódia **ou** participação `COLLABORATOR`/`CONSULTANT`) + documento `DRAFT`/`RETURNED` + tipo permitido na etapa + processo editável.
- **RN-TR-11** — Autosave conforme US-015: DOC-05 com revisão por seção; conflito → 412 `SECTION_REVISION_CONFLICT`; chave ausente no template da versão → 422 `SECTION_NOT_IN_TEMPLATE`; conteúdo fora do schema → 422 `RICH_TEXT_INVALID`; limite `maxChars` da seção (padrão 50.000) e 1 MB. Autosave não cria versão (DEC-017).
- **RN-TR-12** — "Não se aplica" só em seções `REQUIRED_OR_JUSTIFY` ou `OPTIONAL`, com justificativa de 20 a 2.000 caracteres; seção `REQUIRED` não aceita (422).
- **RN-TR-13** — Completude exibida = seções exigidas satisfeitas ÷ seções exigidas (`REQUIRED` preenchida; `REQUIRED_OR_JUSTIFY` preenchida ou "não se aplica" justificada), calculada pelo mesmo serviço de DOC-08 (US-039), para que tela e validação nunca divirjam.
- **RN-TR-14** — `objectDefinition` tem de 10 a 2.000 caracteres e descreve o objeto do TR; alterá-lo não altera `Process.object`.
- **RN-TR-15** — Não há notificação na criação nem na edição: o TR nasce sob custódia de quem o cria.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Modelo | `templateId` (criação) | seleção | Não | template ativo do tipo `TR` com versão publicada | padrão do tipo |
| Título | `Document.title` | texto curto | Sim | 5–250 caracteres | "Termo de Referência — {process.title}" |
| Objeto (resumo) | `objectDefinition` | texto longo | Sim | 10–2.000 (RN-TR-14) | `process.object` |
| Valor estimado | `estimatedTotalValue` | moeda (BRL) | Para concluir (US-039) | ≥ 0; 2 casas; string decimal; mascarado (POL-09) | pesquisa concluída (RN-TR-07) |
| Origem do valor | `estimatedValueSource` | `EstimatedValueSource` | Com valor | `PRICE_RESEARCH`, `ETP` ou `MANUAL` | derivada |
| Pesquisa vinculada | `priceResearchId` | referência | Não | pesquisa do mesmo processo | RN-TR-07 |
| Seção (conteúdo) | `draftContent.sections[key].content` | rich text (TipTap) | Conforme `requirement` | schema `packages/editor`; `maxChars` | `defaultContent` do template |
| Seção (estado) | `draftContent.sections[key].state` | `SectionState` | Sim | `EMPTY`/`FILLED`/`NOT_APPLICABLE` (RN-TR-12) | RN-TR-05 |
| Justificativa de "não se aplica" | `draftContent.sections[key].justification` | texto | Se `NOT_APPLICABLE` | 20–2.000 | — |
| Vigência (meses) · Prazo de execução · Tipo de contagem · Local de entrega · Prazo de pagamento (dias) · Garantia do objeto (meses) · Garantia contratual (%) · Subcontratação · Critério de julgamento · Tipo de adjudicação | `contractDurationMonths` · `executionDeadline` · `executionDeadlineType` · `deliveryLocation` · `paymentTermDays` · `productWarrantyMonths` · `contractGuaranteePercent` · `allowsSubcontracting` · `selectionCriterionId` · `awardType` | cabeçalho tipado | ver US-038/US-039 | limites de entities.md §4.8 (vigência 1–120; pagamento 1–90; garantia do objeto 0–120; garantia contratual 0–10 %, arts. 96–98; critério do catálogo `JUDGMENT_CRITERION`, art. 33; `AwardType`) | `fieldConfig` |
| *(sistema)* Número/código, status, versão do template, rascunho | `number`, `code`, `status`, `templateVersionId`, `draftRevision` | — | — | RN-TR-03/04 | gerados |
| *(sistema)* Rastreabilidade da importação | `importedFromEtpId`, `importedFromEtpVersionId`, `importedAt`, `importedById` | — | — | US-037 | nulos na criação |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Título/objeto fora dos limites | Front + API (Zod) | "O {campo} deve ter entre X e Y caracteres." | `VALIDATION_ERROR` (`TOO_SHORT`/`TOO_LONG`) |
| V-02 | Template inexistente, inativo, de outro tipo, sem versão publicada ou de outro tenant | API | "Selecione um modelo de TR válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` em `templateId`) |
| V-03 | TR já existe no processo | API (+ índice único) | "Este processo já tem um Termo de Referência." | `DOCUMENT_ALREADY_EXISTS` |
| V-04 | Etapa atual não permite TR | API | "O Termo de Referência não pode ser elaborado nesta etapa." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-05 | Usuário sem custódia | API | "Somente quem está com o processo pode criar o TR." | `NOT_PROCESS_CUSTODIAN` |
| V-06 | Processo suspenso, cancelado ou concluído | API | "O processo não permite alterações no status atual." | `INVALID_PROCESS_STATUS` |
| V-07 | Seção `REQUIRED` marcada como "não se aplica" | Front + API | "Esta seção é obrigatória e não pode ser marcada como 'não se aplica'." | `VALIDATION_ERROR` (`NOT_ALLOWED` em `state`) |
| V-08 | Justificativa de "não se aplica" curta | Front + API | "Justifique com pelo menos 20 caracteres." | `VALIDATION_ERROR` (`TOO_SHORT`) |
| V-09 | Seção inexistente no template / conteúdo inválido | API | "Não foi possível salvar esta seção. Recarregue o documento." | `SECTION_NOT_IN_TEMPLATE` / `RICH_TEXT_INVALID` |
| V-10 | Conteúdo acima de `maxChars` ou 1 MB | Front + API | "A seção ultrapassou o limite de {n} caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) / `PAYLOAD_TOO_LARGE` |
| V-11 | Valor manual negativo ou com mais de 2 casas | Front + API | "Informe um valor válido, com até 2 casas decimais." | `VALIDATION_ERROR` (`INVALID_DECIMAL`) |
| V-12 | `priceResearchId` de outro processo/tenant | API | "Selecione a pesquisa de preços deste processo." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-13 | Documento não editável | API | "O TR está concluído. Reabra-o para editar." | `DOCUMENT_NOT_EDITABLE` |

## Permissões
- **Permissão:** `TERM_CREATE` (criar) e `TERM_UPDATE` (editar seções e "Dados do TR"), com escopo que cubra o processo; leitura com `PROCESS_VIEW`; valores sigilosos com `PROCESS_VIEW_CONFIDENTIAL_BUDGET` ou custódia.
- **Políticas:** POL-01 (custódia), POL-02 (edição de documento), POL-09 (orçamento sigiloso). Participantes `COLLABORATOR`/`CONSULTANT` recebem `TERM_UPDATE` no processo (permissions.md §4).
- **MFA:** não exigido (permissões de risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** botão "Criar Termo de Referência" oculto; editor em modo leitura; API 403 `PERMISSION_DENIED` (ou código da política) com auditoria `access.denied`; TR de processo não visível → 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentCreated` | `document.created.tr` | Commit da criação | Payload: `documentId`, `documentTypeCode = TR`, `kind = STRUCTURED`, `code`, `title`, `templateVersionId` |

Projeção síncrona: `DOCUMENT_CREATED` na timeline. Autosave e alterações do cabeçalho não emitem eventos (auditoria apenas).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma (RN-TR-15) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Criar TR e editar suas seções

  Background:
    Given o tenant "Prefeitura de São José" ativo com a biblioteca padrão de templates
    And o processo "0012/2026" na etapa "TERMO_REFERENCIA" com status "IN_PROGRESS" sob custódia de "Paula" (PLANEJAMENTO)
    And a pesquisa de preços "PP 0002/2026" do processo está "FINALIZED" com total de "98000.00"
    And o último número de TR do tenant em 2026 é 2

  Scenario: [Sucesso] Criar o TR com o modelo padrão
    When "Paula" clicar em "Criar Termo de Referência" e confirmar o modelo padrão
    Then o TR deve ser criado com código "TR 0003/2026" e status "DRAFT"
    And o documento deve fixar a versão publicada vigente do template padrão do tipo "TR"
    And deve haver uma entrada de rascunho para cada seção do template, inclusive "OBJECT" e "ESTIMATED_VALUE"
    And "objectDefinition" deve ser igual ao objeto do processo
    And "priceResearchId" deve apontar para a pesquisa e "estimatedTotalValue" deve ser "98000.00" com origem "PRICE_RESEARCH"
    And a API deve responder 201 com "Location" "/api/v1/terms/{id}"
    And deve gerar registro de auditoria "document.create"
    And deve gerar o evento "DocumentCreated" com routing key "document.created.tr"
    And a timeline deve exibir "Paula criou Termo de Referência TR 0003/2026"

  Scenario: [Sucesso] Autosave de seção sem criar versão
    Given o TR "TR 0003/2026" em "DRAFT" com a seção "OBJECT" vazia na revisão 1
    When "Paula" digitar o objeto e parar de digitar por 1,5 segundo
    Then a API deve receber PUT na seção "OBJECT" com "If-Match" igual a "s1" e responder 200
    And a seção deve ficar "FILLED" na revisão 2 e o indicador deve mostrar "Salvo às" com o horário
    And a completude da navegação lateral deve aumentar
    And nenhuma versão do documento deve ser criada

  Scenario: [Validação] Marcar seção obrigatória como "não se aplica"
    When "Paula" enviar a seção "SANCTIONS" com estado "NOT_APPLICABLE"
    Then a API deve responder 422 com "VALIDATION_ERROR" e erro "NOT_ALLOWED" no campo "state"

  Scenario: [Validação] Justificativa curta em seção que admite "não se aplica"
    When "Paula" marcar "DELIVERY" como "não se aplica" com a justificativa "Serviço remoto"
    Then o sistema deve exibir "Justifique com pelo menos 20 caracteres."
    And a seção não deve ser salva

  Scenario: [Validação] Valor manual com pesquisa concluída disponível
    When "Paula" escolher "Informar manualmente" e digitar "100000.00"
    Then o sistema deve exibir o aviso de que existe pesquisa de preços concluída e que o valor manual exige justificativa
    When "Paula" confirmar
    Then o TR deve ter "estimatedValueSource" igual a "MANUAL"
    And a validação do TR deve apontar a falta de justificativa enquanto a seção "ESTIMATED_VALUE" estiver vazia

  Scenario: [Permissão] Usuário sem TERM_CREATE
    Given "André" possui apenas o perfil "LICITACOES"
    When "André" abrir o processo "0012/2026"
    Then o botão "Criar Termo de Referência" não deve ser exibido
    When "André" enviar POST para "/api/v1/processes/{id}/terms"
    Then a API deve responder 403 com "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "TERM_CREATE"

  Scenario: [Permissão] Usuário com a permissão, mas sem custódia
    Given "Ana" (REQUISITANTE) tem "TERM_CREATE" e vê o processo, que está com "Paula"
    When "Ana" tentar criar o TR
    Then a API deve responder 403 com "NOT_PROCESS_CUSTODIAN"

  Scenario: [Permissão] Etapa que não admite o TR
    Given o processo está na etapa "ABERTURA", cujos tipos permitidos são apenas "DFD"
    When "Paula" tentar criar o TR
    Then a API deve responder 422 com "DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE"

  Scenario: [Permissão] Valor mascarado em orçamento sigiloso
    Given o processo tem orçamento sigiloso
    And "Bruno" (CONSULTOR_EXTERNO) é participante "CONSULTANT" do processo
    When "Bruno" abrir o TR
    Then o painel "Dados do TR" deve exibir "Valor sigiloso"
    And a resposta de "GET /api/v1/terms/{id}" deve trazer "estimatedTotalValue" nulo e "estimatedTotalValueMasked" verdadeiro

  Scenario: [Tenant incorreto] TR e template de outro tenant
    Given existe o TR "T-B" e o template "M-B" no tenant "Prefeitura B"
    When "Paula" requisitar "GET /api/v1/terms/{id de T-B}"
    Then a API deve responder 404 sem revelar a existência do recurso
    When "Paula" criar o TR informando "templateId" igual a "M-B"
    Then a API deve responder 422 com "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" em "templateId"

  Scenario: [Duplicidade] Segundo TR no mesmo processo
    Given o processo já possui o TR "TR 0003/2026" em "DRAFT"
    When "Paula" enviar nova criação de TR com outra chave de idempotência
    Then a API deve responder 409 com "DOCUMENT_ALREADY_EXISTS" e o identificador do TR existente

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given a criação com a chave "K-TR-1" retornou 201 para "TR 0003/2026"
    When a mesma requisição for reenviada com "K-TR-1"
    Then a API deve responder 201 com o mesmo TR e "Idempotent-Replayed: true"
    And nenhum número adicional deve ser consumido

  Scenario: [Concorrência] Autosave concorrente na mesma seção
    Given "Paula" e "Bruno" editam a seção "SPECIFICATIONS" a partir da revisão 4
    When "Bruno" salvar primeiro e "Paula" salvar em seguida com "If-Match" "s4"
    Then a API deve responder 412 com "SECTION_REVISION_CONFLICT" para "Paula"
    And o editor deve abrir o diálogo com "Ver diferenças", "Manter a minha versão" e "Descartar a minha e recarregar"
    But edições simultâneas em seções diferentes devem ser salvas sem conflito

  Scenario: [Concorrência] Duas criações simultâneas
    When duas requisições de criação de TR para o processo chegarem ao mesmo tempo
    Then exatamente uma deve receber 201 e a outra 409 "DOCUMENT_ALREADY_EXISTS"

  Scenario: [Falha de banco] Banco indisponível na criação
    Given o banco de dados fica indisponível durante a transação de criação
    When "Paula" confirmar a criação
    Then a API deve responder 503 com "DEPENDENCY_UNAVAILABLE" e "Retry-After"
    And nenhum documento, cabeçalho, auditoria, evento ou número deve ser persistido

  Scenario: [Falha de integração] Redis e relay indisponíveis
    Given o Redis e o relay do outbox estão indisponíveis
    When "Paula" criar o TR com chave de idempotência
    Then o TR deve ser criado e a API deve responder 201
    And deve ser registrado log "warn" "idempotency.store_unavailable"
    And o evento "DocumentCreated" deve permanecer "PENDING" no outbox até o relay voltar

  Scenario: [Falha de integração] Gotenberg indisponível na pré-visualização
    Given o Gotenberg está indisponível
    When "Paula" clicar em "Pré-visualizar PDF"
    Then a API deve responder 202 e a renderização deve terminar "FAILED" após as tentativas
    And o editor deve exibir "Não foi possível gerar a pré-visualização agora. Tente novamente em instantes." sem afetar o rascunho
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos; foca o primeiro |
| TR já existente | 409 | `DOCUMENT_ALREADY_EXISTS` | "Este processo já tem um Termo de Referência." | Botão "Abrir TR existente" |
| Sem permissão / sem custódia | 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | "Você não pode criar ou editar o TR deste processo agora." | Modo leitura; mostra quem está com o processo |
| Etapa não permite TR | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O TR não pode ser elaborado nesta etapa." | Desabilita "Criar" com tooltip |
| Processo em status não editável | 409 | `INVALID_PROCESS_STATUS` | "O processo não permite alterações no status atual." | Modo leitura |
| Documento concluído | 409 | `DOCUMENT_NOT_EDITABLE` | "O TR está concluído. Reabra-o para editar." | Faixa informativa; desativa autosave |
| Conflito de seção | 412 | `SECTION_REVISION_CONFLICT` | "Outra pessoa alterou esta seção." | Diálogo de conflito (US-015) |
| Cabeçalho alterado por outro usuário | 412 | `VERSION_CONFLICT` | "Os dados do TR foram alterados por outra pessoa." | Recarrega o painel e reaplica a edição |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue o documento e tente novamente." | Recarrega |
| Seção inexistente / conteúdo inválido | 422 | `SECTION_NOT_IN_TEMPLATE` / `RICH_TEXT_INVALID` | "Não foi possível salvar esta seção." | Mantém rascunho local; sugere recarregar |
| Conteúdo grande demais | 413 | `PAYLOAD_TOO_LARGE` | "A seção ultrapassou o tamanho máximo." | Destaca o contador |
| Limite de autosave | 429 | `RATE_LIMITED` | "Muitas gravações em sequência. Aguarde." | Reagenda conforme `Retry-After` |
| Banco/Redis crítico indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Suas alterações estão guardadas neste navegador." | Rascunho local + nova tentativa |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-015 (editor por seções e autosave), US-065 (ciclo de vida), US-110 (template semeado), US-108 (padrão do tipo), US-067 (pré-visualização), US-032 (pesquisa concluída), US-013 (reclassificação por sigilo); habilita US-037, US-038 e US-039.
- **Decisões/ADRs:** DEC-015, DEC-017, DEC-018, DEC-023, DEC-028, DEC-030, DEC-032, DEC-055, DEC-056, DEC-182; ADR-006.
- **Configurações:** `numbering.document.defaultMask`; `DocumentType.numberingMask`.
- **Lacunas nas fontes canônicas:**
  1. `BUDGET_ADEQUACY` (alínea *j*) não consta da lista de chaves do TR em entities.md §4.8 — incluir como seção adicional da biblioteca (US-110).
  2. Não há campo para a justificativa do valor `MANUAL`; adotada a narrativa da seção `ESTIMATED_VALUE`. Alternativa: `TermOfReference.estimatedValueJustification`.
  3. api.md associa TRM-04 apenas a US-038; esta story também o usa (objeto e valor) — atualizar a coluna "Story". O `ETag` de `/terms/{id}` adotado é `TermOfReference.version` — registrar em api.md §4.
  4. DEC-030 cita só a pesquisa como documento `RESTRICTED`; esta story aplica o mesmo critério ao TR (contém valor estimado) — confirmar (ver decisões em aberto do épico).

## Impacto técnico
- Primeiro módulo tipado que combina seções narrativas, cabeçalho tipado com valor sigiloso e vínculo com outro módulo (`price-research`): o `TermPresenter` deve passar pelo `ConfidentialFieldsInterceptor`, sem lógica de máscara na tela.
- Reúso obrigatório de `SectionEditor`, `AutosaveController` e diálogo de conflito de US-015 — nenhum mecanismo paralelo de salvamento.
- Inicialização do `draftContent` e resolução de variáveis devem usar o serviço único do módulo `document` (`DraftContentFactory`), também usado por DFD/ETP.
- Criação bloqueia o processo (`FOR UPDATE`) e a linha da sequência; transação curta (meta p95 < 500 ms).

## Backend
- **Módulo(s):** `term` (dono de `TermOfReference`); `document` (`DocumentFacade.createStructured`, seções, validação); `price-research` (`PriceResearchFacade.getCompletedSummary`); `process` (custódia, status, bloqueio); `catalog` (`NumberingFacade`); `access` (`AuthorizationService`); `timeline`, `audit`, `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `CreateTermCommand`, `UpdateTermHeaderCommand` (objeto e valor), `GetTermQuery`, `ListProcessTermsQuery`; seções via `SaveDocumentSectionCommand` (US-015).
- **Domínio:** `TermOfReference.createFor(process, templateVersion, priceResearch?)` aplica RN-TR-06/07; value object `EstimatedValue` (valor, origem, pesquisa) com RN-TR-08.
- **Transação:** passos 4.1–4.7 do fluxo principal em uma transação; isolamento `READ COMMITTED` com bloqueio do processo e da sequência.
- **Serialização:** `TermPresenter` com `estimatedTotalValueMasked` (DEC-030) e `meta.allowedActions` (`edit`, `import`, `finalize`, `reopen`).

## Frontend
- **Tela(s):** SCR-006 (`/processos/[id]`: painel e aba Documentos) e SCR-012 (`/processos/[id]/tr/[termId]`).
- **Componentes:** `CreateDocumentDialog` (tipo TR), `DocumentSectionNav` (estado, obrigatoriedade, completude), `SectionEditor` + `AutosaveIndicator` + `SectionConflictDialog` (US-015), `NotApplicableToggle`, `LegalBasisTooltip`, `TermGeneralDataPanel`, `EstimatedValueCard` (origem, link da pesquisa, estado mascarado), `PdfPreviewButton`.
- **Dados:** TanStack Query `['t', tenantId, 'terms', termId]`; `useMutation` com `Idempotency-Key` na criação e `If-Match` nas gravações; invalida `['t', tenantId, 'processes', processId, 'documents']` e `summary`.
- **Estados:** skeleton do editor; empty state do processo sem TR ("Crie o Termo de Referência a partir do modelo do órgão"); modo leitura; selo "Em aprovação"; erro com `correlationId`.
- **Acessibilidade e responsividade:** navegação lateral como `nav` com marcos e `aria-current`; estado do autosave anunciado em região viva "polite"; atalhos para seção anterior/próxima; edição *desktop-first* — em telas < 768 px, leitura e comentários (DEC-183).

## Banco de dados
- **Tabelas escritas:** `documents`, `terms_of_reference`, `number_sequences`, `audit_logs`, `outbox_events`, `process_timeline_entries`.
- **Migrações:** criação de `terms_of_reference` conforme entities.md §4.8 (RLS, FKs compostas para `processes`, `documents`, `catalog_items`, `price_research`, `document_versions`; checks de prazo e de garantia contratual).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, document_id)` em `terms_of_reference`; `UNIQUE (tenant_id, process_id, singleton_key) WHERE …` em `documents`; `UNIQUE (tenant_id, code)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| TRM-02 | POST | `/api/v1/processes/{id}/terms` | `{ templateId?, title? }` + `Idempotency-Key` | `201 { data: Term }` com `id`, `documentId`, `code`, `status`, `templateVersion { id, versionNumber }`, cabeçalho, `version` | 201, 403, 404, 409, 422, 503 |
| TRM-01 | GET | `/api/v1/processes/{id}/terms` | — | `200 { data: [TermSummary] }` | 200, 404 |
| TRM-03 | GET | `/api/v1/terms/{id}` | — | `200 { data: Term }` com cabeçalho mascarado, seções (estado, revisão, conteúdo), `completeness`, `meta.allowedActions`; `ETag` | 200, 404 |
| TRM-04 | PATCH | `/api/v1/terms/{id}` | `{ objectDefinition?, priceResearchId?, estimatedTotalValue?, estimatedValueSource? }` + `If-Match` | `200 { data: Term }` | 200, 403, 409, 412, 422, 428 |
| DOC-05 | PUT | `/api/v1/documents/{documentId}/sections/{sectionKey}` | `{ state, content, justification }` + `If-Match: "s<revision>"` | `200 { data: { sectionKey, state, revision, updatedAt } }` | 200, 409, 412, 413, 422 |
| DOC-08 / DOC-20 / TPL-01 | GET / POST / GET | validação, pré-visualização, modelos | — | — | — |

## Logs
- `info` `term.created` — `termId`, `documentId`, `code`, `templateVersionId`, `linkedPriceResearch` (bool), `durationMs`.
- `info` `document.section_saved` — `documentId`, `sectionKey`, `revision`, `sizeBytes` (amostrado).
- `warn` `document.section_conflict` — `documentId`, `sectionKey`, revisões esperada e atual.
- `warn` `idempotency.store_unavailable`.
- `error` `term.create_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** conteúdo das seções, objeto, justificativas, valores estimados.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.create` | `DATA_CHANGE` | Criação do TR | `metadata`: `documentTypeCode = TR`, `code`, `templateVersionId`, `priceResearchId`, `idempotencyKey` |
| `document.draft_update` | `DATA_CHANGE` | Autosave de seção (coalescido a cada 10 min por documento/seção/usuário) e alterações do painel "Dados do TR" | Seções: intervalo de revisões, variação de tamanho, hash; cabeçalho: campos alterados (valor mascarado se sigiloso) |
| `access.denied` | `ACCESS` | Tentativa negada | `reasonCode` (`TERM_CREATE`, `TERM_UPDATE`, `NOT_PROCESS_CUSTODIAN`) |

## Testes necessários
- **Unitários:** `TermOfReference.createFor` (RN-TR-06/07); `EstimatedValue` (origens e precedência); inicialização do `draftContent` com e sem `defaultContent`; regra de "não se aplica" por `requirement`; cálculo de completude.
- **Integração (Testcontainers):** criação atômica (falha induzida após numerar → nada persiste e a sequência não avança); unicidade do TR por processo; RLS e FK composta bloqueiam template/pesquisa de outro tenant; vínculo automático com pesquisa concluída; mascaramento POL-09.
- **API/contrato:** TRM-01..04 e DOC-05 conforme api.md; cabeçalhos `Location`, `ETag`, `Idempotent-Replayed`.
- **RBAC e multi-tenant:** matriz de perfis (PLA, REQ, COM, GES criam; LIC, AUT não); participante `CONSULTANT` edita mas não cria; IDs de outro tenant → 404/422.
- **Concorrência:** criações paralelas (1 × 201, demais 409); autosave concorrente na mesma seção e em seções diferentes.
- **E2E (Playwright):** criar TR pelo painel, redigir três seções, marcar "não se aplica" em `DELIVERY`, conferir completude e pré-visualização.
- **Acessibilidade/performance:** axe sem violações sérias em SCR-012; autosave p95 < 300 ms com seção de 50 mil caracteres.

## Definition of Done
- [ ] Cenários Gherkin automatizados (API + E2E) e passando
- [ ] POL-01/POL-02/POL-09 aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Autosave reutilizando US-015, sem mecanismo paralelo
- [ ] Auditoria `document.create`/`document.draft_update` e evento `DocumentCreated` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de TRM-01..04 compatível com api.md
- [ ] Logs sem conteúdo de documento nem valores; métricas `document_created_total{type="TR"}` e latência de autosave
- [ ] Acessibilidade (axe) e textos revisados por UX writing
- [ ] Revisão de código e de segurança aprovadas
- [ ] Lacunas registradas consolidadas em risks-and-decisions.md

## Estimativa
**L** — criação transacional de documento tipado com numeração, inicialização de seções e vínculo com a pesquisa; editor completo por seções (reúso de US-015, mas com navegação, completude e "não se aplica"); painel de dados com valor sigiloso; muitos cenários de autorização.

## Prioridade
**P0** — sem o TR a etapa `TERMO_REFERENCIA` não é concluída e a fase preparatória do MVP 1 (marco M4) não termina.

---
id: US-014
title: "Elaborar DFD em wizard a partir de template"
epic: EP-002
feature: FT-008
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-006, US-065, US-110]
modules: [dfd, document, process, catalog, files, workflow, access, timeline, audit, platform]
screens: [SCR-007, SCR-006]
endpoints: [DFD-01, DFD-02, DFD-03, DOC-03, DOC-06, DOC-07, DOC-08, DOC-20, DOC-22, DOC-23, PRC-08, PRC-13, PRC-14, TPL-01, TPL-07, CAT-01, DEP-02, USR-02, ATT-01, ATT-02, ATT-03, ATT-04, ATT-06]
permissions: [DFD_CREATE, DFD_UPDATE, PROCESS_VIEW, PROCESS_UPDATE, ATTACHMENT_UPLOAD]
events: [DocumentCreated, ProcessItemsChanged]
---

# US-014 — Elaborar DFD em wizard a partir de template

## Título
Elaborar DFD em wizard a partir de template

## Descrição
**Como** servidora da área requisitante, **quero** elaborar o Documento de Formalização da Demanda (DFD) do processo em um wizard de cinco passos guiado pelo template do órgão, **para** registrar a necessidade corretamente na primeira vez — com itens e quantidades ligados aos itens do processo — sem precisar dominar a Lei 14.133/2021.

O DFD é criado **dentro** do processo (DFD-02) como documento estruturado: um `Document` do tipo `DFD` com cabeçalho tipado `Dfd` 1:1, numerado na criação (ex.: `DFD 0005/2026`) e baseado na versão publicada do template do tipo. O wizard SCR-007 tem os passos **1 Identificação**, **2 Justificativa**, **3 Planejamento**, **4 Revisão** e **5 Conclusão** (`DfdWizardStep`). Esta story entrega a criação, os passos 1 a 4 (campos, itens, anexos, checklist de completude via DOC-08 e pré-visualização em PDF via DOC-20) e a estrutura do passo 5, cujas ações ("Concluir e enviar para aprovação" e "Finalizar DFD") são de US-016. A persistência contínua do cabeçalho e das seções (autosave, retomada e conflito — DFD-04 e DOC-05) é entregue por US-015, na mesma sprint.

## Contexto
- Hoje o DFD nasce em editor de texto, copiado de anos anteriores; faltam quantidade, data pretendida e vínculo com o PCA, e a devolução chega sem explicação. A persona Cláudia (P03) resume: "Eu sei do que a Saúde precisa. O que eu não sei é como escrever isso do jeito que a lei pede."
- Base legal: Lei 14.133/2021, art. 12, VII (PCA elaborado a partir de documentos de formalização de demandas), art. 18, *caput* (fase preparatória compatível com o PCA) e art. 72, I (contratação direta instruída com DFD); Decreto 10.947/2022, art. 8º, adotado como referência de conteúdo:

| Elemento (Decreto 10.947/2022, art. 8º) | Onde fica no ContrataFlow |
|---|---|
| I — justificativa da necessidade | Seção `JUSTIFICATION` |
| II — descrição sucinta do objeto | `Dfd.objectSummary` |
| III — quantidade a ser contratada | `DocumentItem.quantity` por `ProcessItem` (unidade do item) |
| IV — estimativa preliminar do valor | `Dfd.estimatedValue` |
| V — data pretendida para a conclusão da contratação | `Dfd.expectedDate` |
| VI — grau de prioridade | `Dfd.priority` (`Priority`) |
| VII — vinculação/dependência com outro DFD | Seção `NOTES` no MVP 1 (vínculo estruturado avaliado com o PCA no MVP 2) |
| VIII — área requisitante e responsável | `Dfd.requestingDepartmentId` e `Dfd.responsibleId` |

- Decisões: modelo documental híbrido (DEC-017), ciclo de vida único (DEC-018), itens canônicos (DEC-019), numeração de documentos (DEC-028), PCA sem entidade no MVP 1 (DEC-029), sigilo do orçamento (DEC-030), saída da etapa `ABERTURA` exige "DFD existente e completo" (DEC-015), template como configuração (DEC-016), wizard para DFD (DEC-181), edição *desktop-first* (DEC-183). Interpretações A-12 (itens no plural) e A-13 (template ≠ duplicação) de [risks-and-decisions.md](../mvp-01/risks-and-decisions.md).
- Esta story estabelece o padrão de **documento tipado** (criação de `Document` + cabeçalho tipado na mesma transação, validador de completude registrado por módulo, formato de `violations[]` de DOC-08) reutilizado por ETP (US-019), pesquisa de preços (US-024), mapa de riscos (US-035) e TR (US-036).

## Objetivo
Permitir que a área requisitante crie e preencha um DFD completo em até 1 dia útil (mediana — KPI E4), com 100% dos DFDs possuindo número único, versão de template fixada e itens vinculados a `ProcessItem`, e com o checklist da revisão apontando 100% das pendências que impediriam a conclusão — a mesma avaliação usada pelo workflow na regra de saída da etapa `ABERTURA`.

## Persona
- **Principal:** Área requisitante — Cláudia Ferreira (perfil `REQUISITANTE`, escopo `OWN_DEPARTMENTS`).
- **Secundárias:** Gestora de contratações — Patrícia Almeida (`GESTOR_CONTRATACOES`), Planejamento — Marcos Vinícius Rocha (`PLANEJAMENTO`), Gestor de contrato (`GESTOR_CONTRATO`) — todos com `DFD_CREATE`; Consultoria externa — Bruno Carvalho (`CONSULTOR_EXTERNO`, participante `CONSULTANT`), que edita mas não cria o DFD.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` e não expirado (US-087, US-097).
- Processo visível (DEC-024) com status `DRAFT`, `IN_PROGRESS` ou `RETURNED`, cuja etapa atual permite o tipo `DFD` (`WorkflowStage.documentTypeCodes` vazio ou contendo `DFD`) — no workflow padrão, a etapa `ABERTURA` (US-001, US-042).
- Para criar: `DFD_CREATE` em escopo que cubra o processo e custódia (POL-01/POL-02).
- Tipo de documento `DFD` ativo (`STRUCTURED`/`DFD`, `allowMultiplePerProcess = false`) com template padrão publicado — biblioteca semeada por US-110.
- Não existe DFD ativo (não cancelado e não excluído) no processo.
- Catálogo `UNIT_OF_MEASURE` com itens ativos (criação de itens no passo 3 — US-006, US-104).
- Upload seguro (US-068) e geração de PDF (US-067) disponíveis para anexos e pré-visualização.

## Fluxo principal
1. No painel do processo (SCR-006), o próximo passo da etapa `ABERTURA` orienta "Elabore o DFD para formalizar a demanda" com a ação **"Elaborar DFD"** (exibida quando PRC-08 indica que o usuário pode criar o documento). A mesma ação existe na aba Documentos ("Novo documento › DFD").
2. Se houver mais de um template ativo do tipo `DFD` com versão publicada (TPL-01 filtrado pelo tipo), o sistema pede a escolha em um diálogo; caso contrário, usa o template padrão do tipo sem perguntar.
3. O front envia `POST /api/v1/processes/{id}/dfds` (DFD-02) com `Idempotency-Key` e corpo `{ templateId? }`, exibindo "Criando DFD…".
4. A API, em **uma transação** com `app.tenant_id` definido:
   1. valida o corpo e o template (ativo, do tipo `DFD`, com versão publicada);
   2. autoriza `DFD_CREATE` com escopo que cubra o processo e aplica POL-02 (custódia, status do processo, tipo permitido na etapa);
   3. verifica a unicidade do DFD no processo (`singletonKey`);
   4. obtém o próximo número (`NumberingFacade.next('DOCUMENT:DFD:<escopo>:<ano>')`) e formata o `code` pela máscara do tipo;
   5. cria o `Document` (`status = DRAFT`, `templateVersionId`, `singletonKey = documentTypeId`, `title`, `responsibleId = usuário`, `draftContent` com todas as seções da versão do template inicializadas com `revision = 1`, `draftRevision = 1`);
   6. cria o `Dfd` com os valores iniciais copiados do processo (RN-DFD-05) e `wizardStep = IDENTIFICATION`;
   7. grava a auditoria `document.create`, o evento `DocumentCreated` (routing key `document.created.dfd` — `DFDCreated`) no outbox e, pelo projetor síncrono, a entrada `DOCUMENT_CREATED` na timeline;
   8. confirma a transação.
5. A API responde **201** com o DFD, `Location: /api/v1/dfds/{dfdId}` e `ETag: "1"`. O front navega para SCR-007 (`/processos/{id}/dfd/{dfdId}`) no passo indicado por `wizardStep`.
6. SCR-007 carrega em paralelo, com skeleton: DFD-03 (cabeçalho e resumo do documento), DOC-03 (`draftContent`), TPL-07 (definição das seções, `helpText`, `legalBasis`, `fieldConfig`), DOC-06 (itens do DFD), PRC-13 (itens do processo) e ATT-01 (anexos do documento).
7. **Passo 1 — Identificação:** exibe o número (`DFD 0005/2026`, somente leitura) e os campos **Data**, **Setor** (árvore restrita à secretaria solicitante do processo — DEP-02), **Responsável** (busca de usuários com vínculo ativo — USR-02), **Objeto** (pré-preenchido com o objeto do processo) e **Prioridade** (Baixa/Média/Alta/Urgente, com descrição de cada grau). Se a prioridade escolhida for maior que a do processo, mostra a dica "Ao ser aprovado, o DFD elevará a prioridade do processo para Alta." (regra em US-017). "Continuar" valida os campos do passo no cliente (`dfdHeaderSchema`) e avança.
8. **Passo 2 — Justificativa:** dois editores de texto rico (TipTap, `packages/editor`) — **Justificativa da necessidade** (`JUSTIFICATION`) e **Resultados esperados** (`EXPECTED_RESULTS`) — cada um com orientação recolhível (`helpText`) e base legal em tooltip (`legalBasis`). Abaixo, o bloco **Anexos (documentos de apoio)** permite enviar fotos, relatórios e ofícios pelo fluxo seguro de US-068: ATT-02 (intenção com `targetType = DOCUMENT`, `targetId = documentId`) → `PUT` pré-assinado na quarentena → ATT-03 (confirmação) → acompanhamento do status por ATT-04 (Em verificação → Disponível / Rejeitado). Anexos próprios podem ser removidos (ATT-06) enquanto o DFD for editável.
9. **Passo 3 — Planejamento:**
   - **Itens e quantidades:** tabela com os itens do processo (nº, descrição, unidade) com a opção "Incluir neste DFD" e o campo **Quantidade** (pré-preenchido com `referenceQuantity`, se houver). Cada alteração é gravada por DOC-07 (`PUT /documents/{documentId}/items`, coleção completa, `If-Match` da versão do documento).
   - **"Adicionar item ao processo"** (somente com `PROCESS_UPDATE` + custódia): diálogo com natureza, descrição, unidade (CAT-01 `UNIT_OF_MEASURE`), lote e código CATMAT/CATSER opcionais; grava por PRC-14 (US-006) e, em seguida, inclui o novo item no DFD com a quantidade informada (DOC-07).
   - **Previsão** (`expectedDate`), **Estimativa preliminar** (`estimatedValue`, com o atalho "Usar o valor informado na abertura do processo: R$ 15.000,00" quando houver valor manual visível ao usuário), **Vínculo com o PCA** (Previsto/Não previsto/Não se aplica, com exercício, item e justificativa condicionais, pré-preenchidos com os dados do processo) e **Observações** (seção `NOTES`).
10. **Passo 4 — Revisão:** o front chama DOC-08 e exibe o **checklist de completude** agrupado por passo — "Pendências obrigatórias" (`BLOCKING`) e "Alertas" (`WARNING`) — cada item com o link "Ir para o campo", que abre o passo e foca o campo/seção indicado na violação (`field`/`sectionKey`). Abaixo, o resumo de todos os dados em modo leitura e o botão **"Pré-visualizar PDF"**.
11. Ao clicar em "Pré-visualizar PDF", o front envia DOC-20 (`POST /documents/{documentId}/preview`), recebe **202** com o `renditionId`, consulta DOC-22 a cada 2 s (até 60 s) até `READY` e obtém por DOC-23 a URL pré-assinada (5 min), exibindo o PDF com marca d'água "RASCUNHO" em visualizador embutido (pdf.js) com opção de baixar.
12. **Passo 5 — Conclusão:** mostra o estado de prontidão ("Sem pendências" ou "Há N pendências obrigatórias") e hospeda as ações de US-016.
13. O usuário pode voltar a qualquer passo pelo stepper; passos ainda não visitados ficam acessíveis em ordem. Os dados dos passos 1 a 3 são gravados continuamente pelo mecanismo de US-015.

## Fluxos alternativos
- **FA-01 — Escolha de template:** com mais de um template ativo do tipo, o diálogo lista nome, descrição e versão publicada; o padrão do tipo vem pré-selecionado.
- **FA-02 — DFD já existente:** DFD-02 responde `DOCUMENT_ALREADY_EXISTS` (409); o front exibe "Este processo já possui o DFD 0005/2026." com o botão "Abrir DFD". O painel nunca oferece "Elaborar DFD" quando DFD-01 retorna um DFD ativo.
- **FA-03 — Processo sem itens:** o passo 3 mostra o estado vazio "Este processo ainda não tem itens." com "Adicionar item ao processo" (se permitido) ou a orientação "Peça ao responsável pelo processo para cadastrar os itens." (participantes).
- **FA-04 — Edição por participante:** colaboradores e consultores (`COLLABORATOR`/`CONSULTANT`) editam cabeçalho, seções e quantidades de itens já existentes, enviam anexos (se `ATTACHMENT_UPLOAD`) e consultam o checklist, mas não criam itens do processo (sem `PROCESS_UPDATE` por participação) nem criam o DFD.
- **FA-05 — Modo leitura:** com o DFD fora de `DRAFT`/`RETURNED` ou sem permissão de edição, SCR-007 abre todos os passos em modo leitura, com faixa de status ("Em revisão desde 05/10/2026 14:40", "Aprovado", "Indeferido"…) e sem controles de edição.
- **FA-06 — Orçamento sigiloso:** com `Process.isBudgetConfidential = true`, quem não atende POL-09 vê "Valor sigiloso" no lugar da estimativa, não pode editá-la e não recebe o atalho do valor do processo.
- **FA-07 — Anexo rejeitado ou em verificação:** anexos `INFECTED`/`REJECTED` aparecem marcados como "Rejeitado" (com o motivo em linguagem simples) e geram a notificação `ATTACHMENT_REJECTED` (US-068); anexos `UPLOADED`/`SCANNING` geram o alerta `DFD_ATTACHMENTS_PENDING` no checklist.
- **FA-08 — Falha na pré-visualização:** DOC-22 em `FAILED` → "Não foi possível gerar a pré-visualização agora. Tente novamente em instantes." com "Tentar novamente"; esgotadas as tentativas do worker, quem solicitou recebe `DOCUMENT_RENDER_FAILED`. A edição não é afetada.
- **FA-09 — Etapa não permite DFD:** a ação não é exibida; DFD-02 responde `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` (422).
- **FA-10 — Remover item do DFD:** desmarcar "Incluir neste DFD" remove a linha da coleção enviada a DOC-07; o `ProcessItem` permanece no processo.
- **FA-11 — Unidade sem decimais:** para unidades com `metadata.allowsDecimal = false` (ex.: `UN`, `CX`), a quantidade aceita somente inteiros.
- **FA-12 — Descartar rascunho:** enquanto o DFD nunca tiver sido submetido/finalizado, o menu "Mais" oferece "Excluir rascunho do DFD" (DOC-14, exclusão lógica — US-065); o número consumido não é reutilizado.

## Regras de negócio
- **RN-DFD-01** — Há no máximo **um DFD ativo por processo** (`DocumentType.allowMultiplePerProcess = false`; índice único por `singletonKey` com `status <> 'CANCELED'` e `deleted_at IS NULL`). DFD cancelado ou excluído logicamente não impede um novo. Violação → `DOCUMENT_ALREADY_EXISTS` (409).
- **RN-DFD-02** — Criar exige `DFD_CREATE` em escopo que cubra o processo **e** POL-02 com custódia (POL-01): processo em `DRAFT`/`IN_PROGRESS`/`RETURNED` e tipo `DFD` permitido na etapa atual. Participação não concede `DFD_CREATE`.
- **RN-DFD-03** — O DFD usa a versão publicada do template padrão do tipo (`DocumentType.defaultTemplateId` → `currentPublishedVersionId`) ou do template escolhido (ativo, do tipo `DFD`, com versão publicada). `Document.templateVersionId` é imutável no documento, mesmo que o template ganhe nova versão.
- **RN-DFD-04** — Numeração na criação (DEC-028): máscara `DocumentType.numberingMask` ou, se nula, `numbering.document.defaultMask` (`{type} {seq:4}/{year}` → `DFD 0005/2026`); sequência `DOCUMENT:DFD:<orgId|*>:<ano>` conforme US-105, obtida na mesma transação (rollback não consome número). `Document.code` é único no tenant.
- **RN-DFD-05** — Valores iniciais do cabeçalho: `requestingDepartmentId` = setor solicitante do processo; `responsibleId` = criador; `requestDate` = hoje no fuso do tenant; `objectSummary` = `Process.object`; `priority` = `Process.priority`; `pcaStatus`, `pcaYear`, `pcaItemCode`, `pcaJustification` = os do processo; `expectedDate` e `estimatedValue` vazios; `wizardStep = IDENTIFICATION`; `completedSteps = []`.
- **RN-DFD-06** — `Document.title` = "DFD — {título do processo}", truncado em 250 caracteres; `Document.responsibleId` (redator) = criador. `Dfd.responsibleId` é o **responsável pela demanda** (Decreto 10.947, art. 8º, VIII) e pode ser outra pessoa.
- **RN-DFD-07** — Seções do template DFD semeado (configuração — DEC-016; semeadura em US-110):

| Ordem | Chave | Título | Base legal (`legalBasis`) | `requirement` | `minChars` |
|---|---|---|---|---|---|
| 1 | `JUSTIFICATION` | Justificativa da necessidade | Lei 14.133/2021, art. 12, VII; Decreto 10.947/2022, art. 8º, I | `REQUIRED` | 50 |
| 2 | `EXPECTED_RESULTS` | Resultados esperados | Boa prática (insumo do ETP, art. 18, § 1º, IX) | `REQUIRED` | — |
| 3 | `NOTES` | Observações | Decreto 10.947/2022, art. 8º, VII (dependências) | `OPTIONAL` | — |

  Todas usam `render = TEXT`. Na criação, cada seção recebe `defaultContent` (variáveis `{{...}}` resolvidas no servidor) ou fica vazia; o estado inicial é derivado do conteúdo (RN-DFD-31). O template semeado orienta por `helpText`, não por `defaultContent`, para não gerar falsa completude.
- **RN-DFD-08** — Obrigatoriedade dos campos tipados: `requestDate`, `requestingDepartmentId`, `responsibleId`, `objectSummary`, `priority` e `pcaStatus` são sempre obrigatórios; `expectedDate` e `estimatedValue` seguem `DocumentTemplateVersion.fieldConfig` (seed: `expectedDate.required = true`; `estimatedValue.required = false`), alterável pelo órgão em nova versão do template.
- **RN-DFD-09** — `requestingDepartmentId` deve ser unidade **ativa** da subárvore da secretaria solicitante do processo (`path` prefixado), do mesmo órgão. Alterá-lo no DFD não altera o processo.
- **RN-DFD-10** — `responsibleId` deve ser usuário com vínculo `ACTIVE` e não expirado no tenant (USR-02); não precisa deter a custódia.
- **RN-DFD-11** — `requestDate` ≤ hoje (fuso do tenant). `expectedDate` ≥ `requestDate` (check do banco) e, na validação de completude, ≥ hoje (`DFD_EXPECTED_DATE_PAST`).
- **RN-DFD-12** — `objectSummary` tem 10 a 2.000 caracteres e não altera `Process.object` (editado em US-005).
- **RN-DFD-13** — PCA (DEC-029), com as mesmas regras do processo (RN-PROC-12): `PLANNED` exige `pcaYear` (ano corrente ou seguinte) e aceita `pcaItemCode` (até 60); `NOT_PLANNED` exige `pcaJustification` com ≥ 20 caracteres; `NOT_APPLICABLE` grava os demais nulos. Mudanças no DFD só chegam ao processo na aprovação (US-017).
- **RN-DFD-14** — Itens: cada `DocumentItem` referencia um `ProcessItem` não excluído do mesmo processo, uma única vez por documento; `quantity` > 0, com até 4 casas e inteira quando a unidade não admite decimais. DOC-07 substitui a coleção inteira e só é aceito com o DFD em `DRAFT`/`RETURNED` e POL-02.
- **RN-DFD-15** — Criar item a partir do DFD usa PRC-14 (regras de US-006) e exige `PROCESS_UPDATE` + POL-01; o item criado entra no DFD com a quantidade informada. Sem a permissão, o botão não é exibido.
- **RN-DFD-16** — `estimatedValue` é opcional (seed), ≥ 0, com 2 casas, trafega como string decimal e segue POL-09: mascarado (`estimatedValueMasked: true`) e não editável por quem não atende a política quando o orçamento do processo for sigiloso.
- **RN-DFD-17** — Anexos do DFD são `Attachment` com `targetType = DOCUMENT` e `targetId = documentId`, enviados pelo fluxo de US-068 (`uploads.maxFileSizeMb`, `uploads.allowedExtensions`) e somente enquanto o DFD estiver editável. Só anexos `AVAILABLE` aparecem no resumo da revisão e no PDF.
- **RN-DFD-18** — Regras de completude do DFD avaliadas por DOC-08, no formato canônico de `violations[]` (api.md §2.1.2 — `code`, `severity`, `message`, `sectionKey`, `field`, `itemId`, `params`):

| `code` | Severidade | Condição | Referência na violação | Passo do wizard (derivado pela UI) |
|---|---|---|---|---|
| `FIELD_REQUIRED` | `BLOCKING` | Campo tipado obrigatório vazio (RN-DFD-08) | `field` (ex.: `expectedDate`) | `IDENTIFICATION` ou `PLANNING` |
| `SECTION_REQUIRED` | `BLOCKING` | Seção `REQUIRED` vazia | `sectionKey` | `JUSTIFICATION` |
| `SECTION_TOO_SHORT` | `BLOCKING` | Seção abaixo de `minChars` | `sectionKey`, `params.minChars` | `JUSTIFICATION` |
| `DFD_ITEMS_REQUIRED` | `BLOCKING` | Nenhum item com quantidade | `field = items` | `PLANNING` |
| `DFD_PCA_INCOMPLETE` | `BLOCKING` | Dados de PCA inconsistentes (RN-DFD-13) | `field` (`pcaYear` ou `pcaJustification`) | `PLANNING` |
| `DFD_EXPECTED_DATE_PAST` | `BLOCKING` | Previsão anterior a hoje | `field = expectedDate` | `PLANNING` |
| `DFD_RESPONSIBLE_INACTIVE` | `BLOCKING` | Responsável sem vínculo ativo | `field = responsibleId` | `IDENTIFICATION` |
| `DFD_DEPARTMENT_INACTIVE` | `BLOCKING` | Setor desativado após a escolha | `field = requestingDepartmentId` | `IDENTIFICATION` |
| `DFD_ATTACHMENTS_PENDING` | `WARNING` | Há anexos ainda em verificação | `field = attachments`, `params.count` | `JUSTIFICATION` |

- **RN-DFD-19** — A completude é calculada no servidor (DOC-08) pela mesma função usada no cliente (`evaluateDfdCompleteness` em `packages/validation`); `isComplete = true` sse não houver violação `BLOCKING`. O mesmo resultado alimenta `RuleContext.documents.DFD.isComplete`, usado pela regra `REQUIRED_DOCUMENT` (`minStatus: COMPLETE`) da saída de `ABERTURA`. A UI mapeia `field`/`sectionKey` para o passo do wizard (tabela acima) e usa `code` para ícones e atalhos.
- **RN-DFD-20** — Pré-visualização (DOC-20): `PREVIEW` da revisão atual do rascunho, com marca d'água "RASCUNHO" e expiração em 24 h (DEC-060), permitida a quem vê o processo; valores sigilosos saem mascarados para quem não atende POL-09. Uma `PREVIEW` `READY` e válida para o mesmo `draftRevision`, versão de template e nível de visibilidade de valores é reutilizada.
- **RN-DFD-21** — Navegação: ordem `IDENTIFICATION` → `JUSTIFICATION` → `PLANNING` → `REVIEW` → `CONCLUSION`; voltar é sempre livre; avançar valida os campos do passo no cliente; um passo entra em `completedSteps` quando o usuário o deixa sem pendências daquele passo. O rascunho pode ser salvo incompleto — a obrigatoriedade só bloqueia a conclusão (US-016).
- **RN-DFD-22** — A criação gera timeline `DOCUMENT_CREATED` e auditoria `document.create`; não há notificação (o DFD nasce sob custódia de quem o criou).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Template | `templateId` (requisição) → `Document.templateVersionId` | seleção | Não | Ativo, tipo `DFD`, versão publicada | Template padrão do tipo |
| Número | `Document.code` | texto (leitura) | — | RN-DFD-04 | Gerado |
| Data | `requestDate` | data | Sim | ≤ hoje | Hoje (fuso do tenant) |
| Setor | `requestingDepartmentId` | seleção em árvore | Sim | RN-DFD-09 | Setor solicitante do processo |
| Responsável | `responsibleId` | busca de usuário | Sim | RN-DFD-10 | Criador |
| Objeto | `objectSummary` | texto longo | Sim | 10–2.000 caracteres | `Process.object` |
| Prioridade | `priority` | rádio (`Priority`) | Sim | Enum | `Process.priority` |
| Justificativa da necessidade | seção `JUSTIFICATION` | texto rico | Sim | ≥ 50 e ≤ 50.000 caracteres; schema do editor | Vazio |
| Resultados esperados | seção `EXPECTED_RESULTS` | texto rico | Sim (seed) | ≤ 50.000 | Vazio |
| Anexos | `Attachment` (`targetType = DOCUMENT`) | upload | Não | RN-DFD-17 | — |
| Item | `DocumentItem.processItemId` | seleção | Sim (≥ 1) | RN-DFD-14 | — |
| Quantidade | `DocumentItem.quantity` | decimal (string) | Sim, por item | > 0; ≤ 4 casas; inteiro se a unidade não admitir decimais | `ProcessItem.referenceQuantity`, se houver |
| Unidade | `ProcessItem.unitOfMeasureId` | leitura | — | Do item | Do item |
| Observações do item | `DocumentItem.notes` | texto | Não | ≤ 1.000 | — |
| Previsão | `expectedDate` | data | Sim (seed) | ≥ `requestDate`; ≥ hoje na validação | — |
| Estimativa preliminar | `estimatedValue` | moeda (BRL) | Não (seed) | ≥ 0; 2 casas; POL-09 | Sugestão do valor manual do processo |
| Situação no PCA | `pcaStatus` | rádio (`PcaStatus`) | Sim | RN-DFD-13 | `Process.pcaStatus` |
| Exercício do PCA | `pcaYear` | número | Condicional (`PLANNED`) | Ano corrente ou seguinte | `Process.pcaYear` |
| Item do PCA | `pcaItemCode` | texto curto | Não | ≤ 60 | `Process.pcaItemCode` |
| Justificativa (fora do PCA) | `pcaJustification` | texto longo | Condicional (`NOT_PLANNED`) | ≥ 20 caracteres | `Process.pcaJustification` |
| Observações | seção `NOTES` | texto rico | Não | ≤ 50.000 | Vazio |
| *(sistema)* Status, versões e passo | `Document.status`, `Document.version`, `draftRevision`, `Dfd.version`, `wizardStep`, `completedSteps` | — | — | DEC-018; RN-DFD-21 | Gerados |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Template inexistente, inativo, de outro tipo, sem versão publicada ou de outro tenant | API | "Selecione um modelo de DFD válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-02 | Já existe DFD ativo no processo | API (+ índice único) | "Este processo já possui o DFD {código}." | `DOCUMENT_ALREADY_EXISTS` |
| V-03 | Etapa atual não permite DFD | API | "O DFD não pode ser elaborado na etapa atual do processo." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-04 | Processo suspenso, cancelado ou concluído | API | "O processo não está em situação que permita elaborar documentos." | `INVALID_PROCESS_STATUS` |
| V-05 | Campos obrigatórios do passo vazios ao avançar | Front (Zod) | "Informe o {campo}." | — (não chega à API) |
| V-06 | Setor fora da secretaria solicitante ou inativo | Front + API | "O setor deve pertencer à {labels.secretariat} solicitante do processo." | `VALIDATION_ERROR` (`DEPARTMENT_NOT_IN_SECRETARIAT`/`REFERENCE_INACTIVE`) |
| V-07 | Responsável sem vínculo ativo | Front + API | "Selecione um responsável com acesso ativo ao órgão." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) |
| V-08 | Data futura ou previsão anterior à data | Front + API | "A data do DFD não pode ser futura." / "A previsão deve ser igual ou posterior à data do DFD." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-09 | Quantidade ≤ 0, com mais de 4 casas ou fracionária para unidade inteira | Front + API | "Informe uma quantidade maior que zero." / "Esta unidade aceita apenas números inteiros." | `VALIDATION_ERROR` (`OUT_OF_RANGE`/`INVALID_DECIMAL` no campo `items[n].quantity`) |
| V-10 | Item de outro processo, excluído, repetido ou de outro tenant | API | "Selecione itens deste processo, sem repetição." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`DUPLICATE_IN_LIST`) |
| V-11 | `If-Match` ausente/divergente em DOC-07 | API | "Os itens foram alterados por outra pessoa. Atualizamos a lista." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-12 | Regras de PCA | Front + API | "Informe o exercício do PCA." / "Justifique por que a demanda não está prevista no PCA (mín. 20 caracteres)." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`TOO_SHORT`) |
| V-13 | Estimativa negativa, com mais de 2 casas ou enviada sem POL-09 em processo sigiloso | Front + API | "Informe um valor válido, com até 2 casas decimais." / "Você não pode alterar valores sigilosos." | `VALIDATION_ERROR` (`OUT_OF_RANGE`/`INVALID_DECIMAL`) / `PERMISSION_DENIED` |
| V-14 | Anexo com extensão/tamanho fora da política | Front + API (US-068) | "Este tipo de arquivo não é aceito." / "O arquivo excede {n} MB." | `FILE_TYPE_NOT_ALLOWED` / `FILE_TOO_LARGE` |
| V-15 | Mesma `Idempotency-Key` com corpo diferente | API | "Esta solicitação já foi enviada com outros dados. Recarregue a página." | `IDEMPOTENCY_KEY_REUSED` |

## Permissões
- **Permissão:** `DFD_CREATE` (criar) e `DFD_UPDATE` (editar, persistido por US-015) com escopo que cubra o processo; `PROCESS_UPDATE` para criar item do processo no passo 3; `ATTACHMENT_UPLOAD` para anexar; `PROCESS_VIEW` para ler DFD, itens, checklist (DOC-08) e pré-visualização (DOC-20).
- **Políticas:** POL-02 (edição de documento: custódia **ou** participação `COLLABORATOR`/`CONSULTANT`, documento em `DRAFT`/`RETURNED`, tipo permitido na etapa, processo editável); POL-01 (custódia) para criar o DFD e itens do processo; POL-09 para a estimativa em processo sigiloso.
- **MFA:** não exigido (permissões de risco `M`/`L`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** a ação "Elaborar DFD" não é exibida; sem permissão de edição, SCR-007 abre em modo leitura; a API responde 403 `PERMISSION_DENIED` (falta de permissão no escopo) ou `NOT_PROCESS_CUSTODIAN` (POL-01) e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentCreated` (`DFDCreated`) | `document.created.dfd` | Commit da criação (DFD-02) | Payload: `documentId`, `documentTypeCode = DFD`, `kind = STRUCTURED`, `code`, `title`, `templateVersionId` |
| `ProcessItemsChanged` | `process.items_changed` | Item criado no passo 3 (PRC-14, US-006) | `added: [itemId]`, `itemsCount` |
| `AttachmentUploaded` | `attachment.uploaded` | Anexo aprovado no scan (worker `file-scan`, US-068) | Produzido por US-068; citado para rastreabilidade |

DOC-07 (itens do documento) não emite evento — a alteração fica na auditoria `document.items_update`. Projeção síncrona na timeline: `DOCUMENT_CREATED` ("Cláudia Ferreira criou DFD 0005/2026").

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | A criação e a edição do DFD não notificam (RN-DFD-22) |
| `ATTACHMENT_REJECTED` | Quem enviou o anexo | In-app (obrigatória) | Anexo `INFECTED`/`REJECTED` (US-068) |
| `DOCUMENT_RENDER_FAILED` | Quem solicitou a pré-visualização | In-app | Renderização falhou após esgotar as tentativas (US-067) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Elaborar DFD em wizard a partir de template

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" ("Aquisição de insumos para a UBS Centro") está na etapa "ABERTURA" com status "DRAFT"
    And "Cláudia" possui o perfil "REQUISITANTE" com escopo "OWN_DEPARTMENTS", é lotada no "Setor de Atenção Básica" da "Secretaria de Saúde" e é a responsável atual do processo
    And o template "DFD — padrão" está publicado na versão 1 como padrão do tipo "DFD"
    And o processo possui os itens 1 "Luva de procedimento, tamanho M" (unidade "CX") e 2 "Seringa descartável 5 ml" (unidade "UN")
    And o último número de DFD do tenant em 2026 é 4

  Scenario: [Sucesso] Criar o DFD a partir do template padrão
    When "Cláudia" clicar em "Elaborar DFD" no painel do processo
    Then deve ser criado o DFD "DFD 0005/2026" com status "DRAFT" vinculado ao processo "0012/2026"
    And o DFD deve ter o setor "Setor de Atenção Básica", a responsável "Cláudia", a data de hoje, o objeto e a prioridade do processo
    And o documento deve referenciar a versão 1 do template "DFD — padrão" com as seções "JUSTIFICATION", "EXPECTED_RESULTS" e "NOTES"
    And a API deve responder 201 com o cabeçalho "Location" e "ETag" igual a "1"
    And deve existir a entrada "DOCUMENT_CREATED" na timeline do processo
    And deve gerar registro de auditoria "document.create"
    And deve gerar o evento "DocumentCreated" com routing key "document.created.dfd"
    And "Cláudia" deve ser levada ao passo "Identificação" do wizard

  Scenario: [Sucesso] Informar itens e quantidades no passo Planejamento
    Given que o DFD "DFD 0005/2026" está em "DRAFT" sem itens
    When "Cláudia" incluir o item 1 com quantidade "120" e o item 2 com quantidade "5000"
    Then o DFD deve possuir 2 itens com as quantidades "120.0000" e "5000.0000"
    And deve gerar registro de auditoria "document.items_update"
    And o checklist da revisão não deve conter a pendência "DFD_ITEMS_REQUIRED"

  Scenario: [Sucesso] Criar item do processo durante o passo Planejamento
    When "Cláudia" adicionar ao processo o item "Algodão hidrófilo 500 g" com unidade "PCT" e quantidade "40"
    Then o processo deve passar a ter o item 3 "Algodão hidrófilo 500 g"
    And deve gerar o evento "ProcessItemsChanged" com o item 3 em "added"
    And o DFD deve incluir o item 3 com quantidade "40.0000"

  Scenario: [Sucesso] Revisar sem pendências e pré-visualizar o PDF
    Given que o DFD possui justificativa com 380 caracteres, resultados esperados, previsão "2026-12-15", 2 itens e situação no PCA "PLANNED" com exercício 2026
    When "Cláudia" abrir o passo "Revisão"
    Then o checklist deve indicar "Sem pendências"
    When "Cláudia" clicar em "Pré-visualizar PDF"
    Then a API deve responder 202 com o identificador da renderização
    And quando a renderização estiver "READY" o PDF deve ser exibido com a marca d'água "RASCUNHO"
    And deve gerar registro de auditoria "document.render_request"

  Scenario: [Validação] Revisão aponta pendências obrigatórias com atalho para o campo
    Given que o DFD não tem justificativa, não tem itens e a previsão está vazia
    When "Cláudia" abrir o passo "Revisão"
    Then o checklist deve listar como obrigatórias as violações "SECTION_REQUIRED" da seção "JUSTIFICATION", "DFD_ITEMS_REQUIRED" e "FIELD_REQUIRED" do campo "expectedDate"
    And ao clicar em "Ir para o campo" da pendência de itens o wizard deve abrir o passo "Planejamento" com o foco na tabela de itens
    And o passo "Conclusão" deve indicar "Há 3 pendências obrigatórias"

  Scenario: [Validação] Quantidade inválida para a unidade
    When "Cláudia" informar a quantidade "2.5" para o item 2 de unidade "UN"
    Then o sistema deve exibir "Esta unidade aceita apenas números inteiros." junto ao campo
    And se a API receber a coleção com esse valor deve responder 422 com código "VALIDATION_ERROR" no campo "items[1].quantity"

  Scenario: [Permissão] Usuário sem DFD_CREATE não cria o DFD
    Given que "Tatiane" possui apenas o perfil "SOMENTE_LEITURA" e vê o processo
    When "Tatiane" abrir o painel do processo "0012/2026"
    Then a ação "Elaborar DFD" não deve ser exibida
    When "Tatiane" enviar POST para "/api/v1/processes/{id}/dfds"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "DFD_CREATE"

  Scenario: [Permissão] Consultor participante edita, mas não cria item do processo
    Given que "Bruno" é participante "CONSULTANT" do processo até "2026-12-31"
    When "Bruno" abrir o passo "Planejamento" do DFD
    Then ele deve conseguir alterar a quantidade dos itens existentes
    And o botão "Adicionar item ao processo" não deve ser exibido
    And se "Bruno" enviar POST para "/api/v1/processes/{id}/items" a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] DFD e itens de outro tenant
    Given que existe um DFD no tenant "Prefeitura de Santa Luzia"
    When "Cláudia" requisitar GET "/api/v1/dfds/{id}" desse DFD
    Then a API deve responder 404 com código "DFD_NOT_FOUND"
    When "Cláudia" enviar em DOC-07 um "processItemId" pertencente ao tenant "Prefeitura de Santa Luzia"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND"
    And a resposta não deve revelar que o recurso existe em outro tenant

  Scenario: [Duplicidade] Processo que já possui DFD
    Given que o processo já possui o DFD "DFD 0005/2026" em "DRAFT"
    When outra criação de DFD for enviada para o processo
    Then a API deve responder 409 com código "DOCUMENT_ALREADY_EXISTS"
    And o front deve oferecer "Abrir DFD" para o "DFD 0005/2026"

  Scenario: [Duplicidade] Duplo clique em "Elaborar DFD"
    When a criação for enviada duas vezes com a mesma chave de idempotência "K-DFD-1"
    Then a segunda resposta deve ser 201 com o mesmo DFD e o cabeçalho "Idempotent-Replayed: true"
    And deve existir apenas um DFD e apenas um número consumido

  Scenario: [Concorrência] Criações simultâneas no mesmo processo
    When "Cláudia" e "Patrícia" criarem o DFD do processo "0012/2026" ao mesmo tempo com chaves diferentes
    Then exatamente uma criação deve responder 201 com "DFD 0005/2026"
    And a outra deve responder 409 com código "DOCUMENT_ALREADY_EXISTS"
    And o próximo DFD criado no tenant deve receber o número 6, sem lacuna

  Scenario: [Concorrência] Itens alterados por duas pessoas
    Given que "Cláudia" e "Bruno" abriram o passo "Planejamento" com a versão 3 do documento
    When "Bruno" salvar a quantidade do item 1 e, em seguida, "Cláudia" salvar a quantidade do item 2 com "If-Match" "3"
    Then a API deve responder 412 com código "VERSION_CONFLICT" para "Cláudia"
    And o front deve recarregar os itens, reaplicar a alteração do item 2 e salvar com sucesso, preservando a alteração de "Bruno" no item 1

  Scenario: [Falha de banco] Banco indisponível na criação
    Given que o banco de dados fica indisponível durante a transação de criação
    When "Cláudia" clicar em "Elaborar DFD"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhum documento, DFD, timeline, auditoria ou evento deve ser persistido
    And nenhum número de DFD deve ser consumido
    And o painel deve exibir "Não foi possível criar o DFD agora. Tente novamente em instantes." com o correlationId

  Scenario: [Falha de integração] Gotenberg indisponível na pré-visualização
    Given que o Gotenberg está indisponível
    When "Cláudia" clicar em "Pré-visualizar PDF"
    Then a renderização deve ser retentada pelo worker conforme a política da fila "document-render"
    And ao esgotar as tentativas a renderização deve ficar "FAILED" e "Cláudia" deve receber a notificação "DOCUMENT_RENDER_FAILED"
    And o DFD deve continuar editável e o checklist disponível

  Scenario: [Falha de integração] ClamAV indisponível durante o envio de anexo
    Given que o ClamAV está indisponível
    When "Cláudia" anexar o arquivo "relatorio-estoque.pdf"
    Then o anexo deve permanecer "Em verificação" sem ficar disponível para download
    And o checklist deve exibir o alerta "DFD_ATTACHMENTS_PENDING"
    And a edição do DFD não deve ser bloqueada
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo ou campo inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos com `errors[]`; foca o primeiro |
| Template inválido | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Selecione um modelo de DFD válido." | Recarrega a lista de templates |
| DFD já existe | 409 | `DOCUMENT_ALREADY_EXISTS` | "Este processo já possui o DFD {código}." | Botão "Abrir DFD" |
| Etapa não permite DFD | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O DFD não pode ser elaborado na etapa atual do processo." | Oculta a ação; mostra a etapa atual |
| Sem permissão no escopo | 403 | `PERMISSION_DENIED` | "Você não tem permissão para elaborar o DFD deste processo." | Modo leitura |
| Sem custódia | 403 | `NOT_PROCESS_CUSTODIAN` | "Somente quem está com o processo pode realizar esta ação." | Mostra o responsável atual |
| Processo em status que impede edição | 409 | `INVALID_PROCESS_STATUS` | "O processo está {status} e não permite alterações." | Modo leitura com a faixa de status |
| DFD fora de `DRAFT`/`RETURNED` | 409 | `DOCUMENT_NOT_EDITABLE` | "Este DFD não pode mais ser editado." | Recarrega em modo leitura |
| DFD inexistente/outro tenant | 404 | `DFD_NOT_FOUND` | "DFD não encontrado." | SCR-111 (404) |
| Conflito de itens | 412 | `VERSION_CONFLICT` | "Os itens foram alterados por outra pessoa. Atualizamos a lista." | Recarrega e reaplica alterações locais não conflitantes |
| Renderização não pronta | 409 | `RENDITION_NOT_READY` | "A pré-visualização ainda está sendo gerada." | Continua consultando DOC-22 |
| Limite de renderizações | 429 | `RATE_LIMITED` | "Muitas solicitações de PDF. Aguarde alguns segundos." | Respeita `Retry-After` |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Botão "Tentar novamente"; exibe correlationId |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-006 (itens do processo, PRC-13/PRC-14), US-065 (ciclo de vida, DOC-06/07/08 e DOC-14), US-110 (template DFD semeado), US-015 (persistência do cabeçalho e das seções — mesma sprint), US-067 (pré-visualização), US-068 (anexos), US-105 (numeração), US-097 (autorização), US-059 (timeline), US-073 (auditoria), US-082 (outbox). Indiretas: US-001, US-042, US-104.
- **Decisões/ADRs:** DEC-015, DEC-016, DEC-017, DEC-018, DEC-019, DEC-023, DEC-024, DEC-028, DEC-029, DEC-030, DEC-056, DEC-060, DEC-105, DEC-136, DEC-181, DEC-183; ADR-006, ADR-007, ADR-008.
- **Configurações:** `numbering.document.defaultMask`, `uploads.maxFileSizeMb`, `uploads.allowedExtensions`, `labels.secretariat`, `labels.department`.
- **Lacunas nas fontes canônicas:**
  1. O schema de `DocumentTemplateVersion.fieldConfig` não está em entities.md §5. Proposta: `{ [campo]: { label?: string, required?: boolean, helpText?: string, default?: unknown } }`.
  2. DEC-030 não lista o DFD entre os valores mascarados, mas `Dfd.estimatedValue` revela o orçamento estimado; adotado o mascaramento por POL-09 (atualizar DEC-030/entities.md).
  3. O vocabulário de `meta.allowedActions` não está definido em api.md; adotados `EDIT`, `PREVIEW`, `FINALIZE`, `FORWARD_FOR_APPROVAL`, `DUPLICATE`, `REOPEN`, `DELETE`.
  4. A estrutura da resposta de DOC-08 (envelope com `isComplete`, `summary`, `sections[]`) não está em api.md §4; o formato de `violations[]` segue api.md §2.1.2.

## Impacto técnico
- **Padrão de documento tipado:** `DocumentFacade.createStructured({ processId, typeCode, templateVersionId, title, header })` cria `Document` + cabeçalho tipado na mesma transação (numeração, `singletonKey`, inicialização do `draftContent`, auditoria, outbox, timeline). O módulo `dfd` só fornece o cabeçalho e o validador; ETP, TR, pesquisa e mapa de riscos repetem o padrão.
- **Registro de validadores:** `DocumentCompletenessRegistry` no módulo `document` recebe um `CompletenessValidator` por `SystemDocumentModule` (aqui, `DfdCompletenessValidator`). DOC-08, a submissão/finalização e o `RuleContext` usam o mesmo registro — uma única fonte de verdade.
- **Função compartilhada:** `evaluateDfdCompleteness` vive em `packages/validation` (sem I/O) e é usada no cliente (checklist instantâneo) e no servidor (que injeta os dados atuais: itens, vínculos ativos, anexos).
- **Contenção de numeração:** a linha `DOCUMENT:DFD:*:<ano>` fica bloqueada até o commit; a transação de criação deve ser curta (meta p95 < 600 ms).
- **Itens:** DOC-07 com substituição da coleção simplifica o contrato, mas gera conflitos entre editores simultâneos; o cliente faz *merge* por `processItemId` ao receber 412.
- **Pré-visualização:** reaproveitar `PREVIEW` válida para o mesmo `draftRevision` evita filas no Gotenberg quando o usuário clica repetidamente (proposta de [storage.md](../architecture/storage.md) §10).

## Backend
- **Módulo(s):** `dfd` (dono de `Dfd`); usa as fachadas de `document` (`DocumentFacade.createStructured`, `DocumentItemsService`, `DocumentCompletenessRegistry`, `RenditionFacade.requestPreview`), `process` (`ProcessFacade.getForDocumentCreation`, `ProcessItemFacade`), `catalog` (`NumberingFacade`, `CatalogFacade.getUnitMetadata`), `workflow` (`StageFacade.isDocumentTypeAllowed`), `access` (`AuthorizationService`, `DocumentEditPolicy` — POL-02), `files` (`AttachmentFacade.listByTarget`), `timeline`, `audit` (`AuditService`) e `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `CreateDfdCommand` → `CreateDfdHandler`; `GetDfdQuery`; `ListProcessDfdsQuery`; `EvaluateDocumentCompletenessQuery` (genérico, DOC-08) com `DfdCompletenessValidator`; `ReplaceDocumentItemsCommand` (genérico, DOC-07) com a política de itens do DFD.
- **Domínio:** `Dfd.createFromProcess(process, creator, today)` (aplica RN-DFD-05/06); value objects `PcaReference` (compartilhado com o processo), `Quantity` (decimal com regra de unidade), `Money`; regras de completude puras (RN-DFD-18).
- **Transação:** passos 4.1–4.8 do fluxo principal em transação interativa com `app.tenant_id`; isolamento `READ COMMITTED` + bloqueio da linha de numeração.
- **Serialização:** `DfdPresenter` com mascaramento central (`ConfidentialFieldsInterceptor`) e `meta.allowedActions`.

## Frontend
- **Tela(s):** SCR-007 (`/processos/[id]/dfd/[dfdId]`, com o passo em `?passo=identificacao|justificativa|planejamento|revisao|conclusao`); ação de entrada em SCR-006.
- **Componentes:** `DfdWizard` (`Stepper` de `packages/ui`), `DfdIdentificationStep` (`DatePicker`, `DepartmentTreeSelect` limitado à secretaria, `UserLookup`, `PrioritySelect` com descrições), `DfdJustificationStep` (`SectionEditor` de `packages/editor`, `SectionHelp`, `LegalBasisTooltip`, `AttachmentUploader` de US-068), `DfdPlanningStep` (`DocumentItemsGrid`, `InlineProcessItemDialog`, `QuantityInput`, `MoneyInput`, `PcaFieldset` reutilizado de US-001), `DfdReviewStep` (`CompletenessChecklist`, `ReadOnlySummary`, `PdfPreviewDialog`), `DfdConclusionStep` (estrutura; ações de US-016), `TemplatePickerDialog`.
- **Dados:** TanStack Query — `['t', tenantId, 'dfds', dfdId]`, `['t', tenantId, 'documents', documentId]`, `['t', tenantId, 'documents', documentId, 'items']`, `['t', tenantId, 'documents', documentId, 'validation']` (invalidada após cada salvamento, com *debounce* de 2 s), `['t', tenantId, 'processes', processId, 'items']`; `useMutation(createDfd)` com `Idempotency-Key` gerada uma vez por clique.
- **Estados:** skeleton por passo; estado vazio de itens (FA-03); erro de carregamento com "Tentar novamente"; modo leitura com faixa de status; checklist "Sem pendências" com ícone e texto.
- **Acessibilidade:** stepper navegável por teclado com `aria-current="step"`; foco no título do passo a cada troca; pendências anunciadas em região `aria-live="polite"`; "Ir para o campo" move o foco para o campo e o descreve; editor com rótulo e descrição associados; nenhuma informação só por cor (ícone + texto); fonte base ≥ 16 px.
- **Responsivo:** *desktop-first* (DEC-183); abaixo de 768 px os passos ficam em coluna única e a tabela de itens vira lista de cartões; a edição de texto rico é recomendada no desktop (aviso discreto no celular).

## Banco de dados
- **Tabelas escritas:** `documents`, `dfds`, `document_items`, `number_sequences`, `process_items` (criação inline, via US-006), `attachments` (US-068), `document_renditions` (US-067), `process_timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** criação de `dfds` conforme entities.md §4.8 — FK composta `(tenant_id, document_id) → documents`, `(tenant_id, process_id) → processes`, `(tenant_id, requesting_department_id) → departments`; `UNIQUE (tenant_id, document_id)`; checks de PCA (`pca_status <> 'NOT_PLANNED' OR pca_justification IS NOT NULL`; `pca_status <> 'PLANNED' OR pca_year IS NOT NULL`) e `expected_date IS NULL OR expected_date >= request_date`; RLS `ENABLE` + `FORCE`. `document_items` e o índice único de `singleton_key` em `documents` vêm de US-065.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, process_id, singleton_key) WHERE singleton_key IS NOT NULL AND status <> 'CANCELED' AND deleted_at IS NULL`; `UNIQUE (tenant_id, code) WHERE code IS NOT NULL`; `UNIQUE (tenant_id, document_id, process_item_id)` em `document_items`; `quantity > 0`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DFD-01 | GET | `/api/v1/processes/{id}/dfds` | — | `200 { data: [Dfd resumido] }` (0 ou 1 ativo + cancelados) | 200, 404 |
| DFD-02 | POST | `/api/v1/processes/{id}/dfds` | `{ templateId? }` + `Idempotency-Key` | `201 { data: Dfd }` + `Location`, `ETag: "1"` | 201, 403, 404, 409, 422, 429, 503 |
| DFD-03 | GET | `/api/v1/dfds/{id}` | — | `200 { data: Dfd, meta: { allowedActions } }` + `ETag: "<dfd.version>"` | 200, 404 |
| DOC-06 | GET | `/api/v1/documents/{id}/items` | — | `200 { data: [{ processItemId, sequence, description, unit, quantity, notes, sortOrder }] }` + `ETag: "<document.version>"` | 200, 404 |
| DOC-07 | PUT | `/api/v1/documents/{id}/items` | `{ items: [{ processItemId, quantity, notes?, sortOrder }] }` + `If-Match` | `200 { data: [...] }` + novo `ETag` | 200, 403, 409, 412, 422, 428 |
| DOC-08 | GET | `/api/v1/documents/{id}/validation` | — | `200 { data: { isComplete, summary, sections[], violations[] } }` | 200, 404 |
| DOC-20 | POST | `/api/v1/documents/{id}/preview` | — | `202 { data: { renditionId, status } }` | 202, 404, 429 |
| DOC-22 / DOC-23 | GET | `/api/v1/document-renditions/{renditionId}` · `/download` | — | `{ status, pageCount }` · `{ url, expiresAt }` | 200, 404, 409 |
| PRC-14 | POST | `/api/v1/processes/{id}/items` | Conforme US-006 + `Idempotency-Key` | `201 { data: ProcessItem }` | 201, 403, 409, 422 |

Exemplo de resposta de DOC-08 (formato reutilizado por ETP, TR, pesquisa e mapa de riscos):
```json
{
  "data": {
    "documentId": "01927f2b-1c3d-7a10-8b9e-5d4c3b2a1f00",
    "isComplete": false,
    "draftRevision": 14,
    "evaluatedAt": "2026-10-05T14:35:10Z",
    "summary": { "blocking": 2, "warnings": 1 },
    "sections": [
      { "key": "JUSTIFICATION", "requirement": "REQUIRED", "state": "FILLED", "complete": true },
      { "key": "EXPECTED_RESULTS", "requirement": "REQUIRED", "state": "EMPTY", "complete": false },
      { "key": "NOTES", "requirement": "OPTIONAL", "state": "EMPTY", "complete": true }
    ],
    "violations": [
      { "code": "SECTION_REQUIRED", "severity": "BLOCKING", "message": "Descreva os resultados esperados com a contratação.", "ruleId": null, "sectionKey": "EXPECTED_RESULTS", "field": null, "itemId": null, "params": {} },
      { "code": "DFD_ITEMS_REQUIRED", "severity": "BLOCKING", "message": "Informe ao menos um item com quantidade.", "ruleId": null, "sectionKey": null, "field": "items", "itemId": null, "params": {} },
      { "code": "DFD_ATTACHMENTS_PENDING", "severity": "WARNING", "message": "Há 1 anexo em verificação de segurança.", "ruleId": null, "sectionKey": null, "field": "attachments", "itemId": null, "params": { "count": 1 } }
    ]
  }
}
```

## Logs
- `info` `dfd.created` — `dfdId`, `documentId`, `code`, `templateVersionId`, `processId`, `durationMs`, `tenantId`, `userId`, `correlationId`.
- `info` `document.items_saved` — `documentId`, `itemsCount`, `durationMs`.
- `debug` `document.validation_evaluated` — `documentId`, `blockingCount`, `warningCount`, `durationMs`.
- `warn` `numbering.lock_wait` — espera > 200 ms no bloqueio da sequência de documentos.
- `warn` `document.preview_slow` — renderização acima de 15 s (meta C3).
- `error` `dfd.create_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** objeto, justificativa, resultados esperados, observações, justificativa de PCA, valores estimados, nomes de arquivos anexados.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.create` | `DATA_CHANGE` | Commit de DFD-02 | `changes`: valores iniciais não sensíveis do cabeçalho (IDs de unidade/usuário, datas, prioridade, `pcaStatus`); textos como hash + tamanho. `metadata`: `documentCode`, `processCode`, `documentTypeCode = DFD`, `templateVersionId`, `idempotencyKey` |
| `document.items_update` | `DATA_CHANGE` | Cada DOC-07 aceito | `changes`: linhas adicionadas/removidas/alteradas (`processItemId`, quantidade antes/depois). `metadata`: `documentCode`, `itemsCount` |
| `process.items_update` | `DATA_CHANGE` | Item criado no passo 3 (US-006) | Conforme US-006 |
| `document.render_request` | `DATA_CHANGE` | DOC-20 aceito | `metadata`: `kind = PREVIEW`, `draftRevision`, `renditionId`, `reused` |
| `document.download` | `EXPORT` | DOC-23 | `metadata`: `renditionId`, `kind` |
| `attachment.upload_intent` / `attachment.confirm` | `DATA_CHANGE` | Anexos (US-068) | Conforme US-068 |
| `access.denied` | `ACCESS` | Negativa de permissão/política | `reasonCode` (`DFD_CREATE`, `PROCESS_UPDATE`, `POL-02`…) |

## Testes necessários
- **Unitários:** `Dfd.createFromProcess` (RN-DFD-05/06, truncamento do título); `evaluateDfdCompleteness` (cada regra de RN-DFD-18, combinação com `fieldConfig`, `minChars`/`maxChars`); `Quantity` com unidade inteira × decimal; regra de setor na subárvore; regras de PCA.
- **Integração (Testcontainers PostgreSQL + Redis):** atomicidade da criação (falha simulada após numerar → nada persiste e a sequência não avança); índice único de `singletonKey` sob concorrência; RLS e FK composta rejeitando itens/unidades de outro tenant; DOC-07 com `If-Match` divergente → 412; DOC-08 refletindo anexos `SCANNING` e responsável desativado.
- **Concorrência:** 20 criações simultâneas no mesmo processo → 1 × 201 e 19 × 409, numeração sem lacuna; duas gravações de itens concorrentes → uma 412 e *merge* correto no cliente.
- **API/contrato:** DFD-01/02/03, DOC-06/07/08 e DOC-20 conforme api.md e o OpenAPI gerado; cabeçalhos `Location`, `ETag`, `Idempotent-Replayed`; `violations[]` conforme api.md §2.1.2 (códigos de RN-DFD-18).
- **RBAC e multi-tenant:** `REQUISITANTE` com e sem custódia; `PLANEJAMENTO` com escopo `TENANT`; `CONSULTOR_EXTERNO` participante (edita quantidades, não cria itens nem DFD); `SOMENTE_LEITURA`; IDs de outro tenant → 404/422 sem vazamento (suíte "tenant leak").
- **E2E (Playwright):** criar o DFD a partir do painel, preencher os passos 1 a 3, criar item inline, anexar arquivo (scanner simulado), revisar com pendências, corrigir pelo "Ir para o campo" e pré-visualizar o PDF.
- **Acessibilidade/performance:** axe sem violações sérias nos cinco passos; navegação completa por teclado e leitor de tela (NVDA) no checklist; DOC-08 p95 < 300 ms; criação p95 < 600 ms; abertura de SCR-007 p95 < 1,5 s.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `DFD_CREATE`, `DFD_UPDATE`, `PROCESS_UPDATE` e POL-02 aplicados na API; ação e controles ocultos/desabilitados conforme as regras
- [ ] Transação única comprovada por teste de falha induzida (inclui numeração)
- [ ] Auditoria `document.create`/`document.items_update` e evento `DocumentCreated` (`document.created.dfd`) verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de DFD-01/02/03, DOC-06/07/08 e DOC-20 compatível com api.md (incluindo o formato de `violations[]`)
- [ ] Logs sem dados sensíveis; métricas `dfd_created_total` e latência de DOC-08; trace com spans de numeração e validação
- [ ] Wizard acessível (axe, teclado, leitor de tela) e responsivo (360 px) com textos revisados por UX writing
- [ ] Revisão de código e de segurança aprovadas
- [ ] Padrão `createStructured` + `DocumentCompletenessRegistry` documentado para reúso por ETP, TR, pesquisa e mapa de riscos

## Estimativa
**L** — cria o primeiro documento tipado do produto e os padrões que ETP, TR, pesquisa e mapa de riscos reutilizarão (criação transacional com numeração, validador de completude registrado, violações no formato canônico de api.md §2.1.2), além de um wizard de cinco passos com editor rico, grade de itens com criação inline, anexos seguros e pré-visualização assíncrona.

## Prioridade
**P0** — o DFD é o primeiro artefato do processo e a regra de saída da etapa `ABERTURA` exige DFD completo; sem ele nenhuma jornada da fase preparatória avança.

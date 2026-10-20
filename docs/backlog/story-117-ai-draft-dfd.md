---
id: US-117
title: "Gerar o rascunho do DFD com IA a partir do resumo da necessidade"
epic: EP-020
feature: FT-061
mvp: 1
priority: P1
estimate: L
status: Especificada
depends_on: [US-015, US-116, US-122]
modules: [ai, document, dfd, process, tenancy, access, catalog, timeline, notification, audit, platform]
screens: [SCR-117, SCR-007]
endpoints: [AI-01, AI-02, AI-03, AI-04, AI-05, DOC-26, DOC-03]
permissions: [AI_GENERATE, DFD_UPDATE, PROCESS_VIEW]
events: [AiGenerationRequested, AiGenerationCompleted, AiGenerationFailed, AiContentApplied, DocumentVersionCreated]
---

# US-117 — Gerar o rascunho do DFD com IA a partir do resumo da necessidade

## Título
Gerar o rascunho do DFD com IA a partir do resumo da necessidade

## Descrição
**Como** servidor da área requisitante (`REQUISITANTE`) que elabora o DFD, **quero** descrever a necessidade em poucas linhas e receber da IA uma proposta de texto para as seções narrativas do DFD, **para** sair da página em branco, escolher o que aproveitar e revisar o resultado antes de seguir.

É a primeira story de geração e entrega o fluxo genérico que as US-118..US-121 reutilizam: **solicitar** (AI-01 com `targetModule = DFD`, `kind = DRAFT` e `needSummary`) → **acompanhar** (AI-02 e notificações) → **aplicar seletivamente** (DOC-26) ou **descartar** (AI-04). O painel SCR-117 ("Assistente de redação com IA") abre ao lado do editor do DFD (SCR-007), e o gerador `draft.dfd` monta o contexto a partir do processo, dos itens e do cabeçalho do DFD. A IA só escreve texto das seções narrativas: cabeçalho tipado, itens, quantidades, datas e valores nunca são alterados, e o que não estiver nas entradas sai como "[a confirmar]" (US-122).

## Contexto
- O DFD é o primeiro documento da cadeia DFD → ETP → mapa de riscos → TR (DEC-037). Hoje a área requisitante copia DFDs antigos e perde tempo com a redação da justificativa; o processo já tem objeto, itens e dados do PCA, que a IA reaproveita sem inventar nada.
- DEC-079: o módulo `ai` (nível 5) só importa fachadas de leitura; a **aplicação** é comando do módulo `document`, que lê a proposta pela porta `AiSuggestionSource` (`loadForApply`/`markApplied`, mesma transação). Nenhuma chamada de IA ocorre dentro de transação ou da requisição HTTP.
- US-115 fornece `AiGeneration`, a fila `ai-generation`, AI-01..AI-04 e a pipeline com registro de geradores; US-116 fornece ativação, limites, AI-05 e a permissão `AI_GENERATE`; US-122 fornece o GroundingGuard, o nó `toConfirm`, a proveniência e a revisão obrigatória. Esta story registra o gerador `draft.dfd` e entrega DOC-26 e o painel.
- Modelo documental híbrido (DEC-017): a IA toca apenas `draftContent`; template fixado no documento (`templateVersionId`, US-014/US-110) define as seções e o guia de redação (`title`, `helpText`, `legalBasis`, `defaultContent`). Sigilo do orçamento: DEC-030. LGPD: DEC-140.

## Objetivo
Permitir que, em um clique e com um resumo de 20 a 2.000 caracteres, o redator obtenha em até 90 s (p95, medido no endurecimento) uma proposta para todas as seções narrativas do DFD, aplicável por seção, rastreável (quem, modelo, versão do prompt, entradas, tokens) e sempre marcada para revisão humana.

## Persona
- **Principal:** Área requisitante (`REQUISITANTE`), redatora do DFD.
- **Secundárias:** Planejamento (`PLANEJAMENTO`), Gestor de contratações (`GESTOR_CONTRATACOES`), Compras (`COMPRAS`), Gestor de contrato (`GESTOR_CONTRATO`) — todos com `AI_GENERATE`; demais usuários com `PROCESS_VIEW` apenas consultam o histórico.

## Pré-condições
- IA ligada no órgão (`ai.enabled = true`, US-116), provedor disponível e limites não atingidos.
- DFD criado (DFD-02) e em `DRAFT` ou `RETURNED`, com o tipo permitido na etapa e o processo editável (POL-02).
- Usuário com `AI_GENERATE` cobrindo o processo **e** `DFD_UPDATE` (POL-18); custódia ou participação `COLLABORATOR`/`CONSULTANT` com permissão de edição para aplicar.

## Fluxo principal
1. No editor do DFD (SCR-007), o front consulta AI-05 e exibe `AiDraftButton` ("Gerar rascunho com IA"); sem `AI_GENERATE` o botão não aparece, e com `canGenerate = false` aparece desabilitado com o motivo de `reasons[]`.
2. O usuário aciona o botão: abre o `AiAssistantPanel` no estado **formulário**, com o `AiRequestForm` (resumo da necessidade com contador, orientações opcionais, lista das entradas que serão usadas e avisos, consumo estimado) e o `AiDisclaimer`.
3. O usuário descreve a necessidade e aciona "Gerar rascunho". O front envia AI-01 (`targetModule: 'DFD'`, `documentId`, `kind: 'DRAFT'`, `needSummary`, `instruction?`) com `Idempotency-Key`.
4. A API valida a POL-18 e os limites, descarta a proposta anterior não aplicada do mesmo usuário (RN-AI-32), grava `AiGeneration` em `QUEUED` com reserva de tokens, audita `ai.generation_request`, grava `AiGenerationRequested` no outbox e, após o commit, enfileira `ai-generation` (`jobId = generationId`). Responde 202 com `Location` e `meta.pollAfterMs = 2000`.
5. O painel passa ao estado **gerando** (`AiGenerationProgress`): o usuário pode continuar editando e pode "Cancelar" (AI-04). O front consulta AI-02 a cada 2 s, recuando até 5 s.
6. O worker revalida a POL-18, monta o contexto (RN-AI-26) pelas fachadas de leitura, sanitiza (RN-AI-05), chama o provedor fora de transação com o prompt `draft.dfd`, valida a saída, aplica o GroundingGuard (US-122), grava `SUCCEEDED` com `output`, `inputRefs` e tokens, e publica `AiGenerationCompleted` (timeline `AI_CONTENT_GENERATED`; notificação `AI_GENERATION_READY` ao solicitante).
7. O painel passa ao estado **proposta pronta**: o `AiProposalSectionList` mostra cada seção com prévia, contagem de "[a confirmar]" e checkbox — seções `EMPTY` marcadas, `FILLED` e `NOT_APPLICABLE` desmarcadas com o aviso "substituirá o texto atual". "Comparar" abre o `AiSectionDiffView` (atual × sugerido).
8. O usuário marca as seções desejadas e aciona "Aplicar seleção". Havendo seção preenchida marcada, o diálogo avisa que será criada uma versão antes e que as seções não marcadas não poderão ser aplicadas depois; o front envia DOC-26 com `generationId`, `sectionKeys`, `confirmReplaceFilled`, `If-Match` e `Idempotency-Key`.
9. A API, em uma transação, aplica as seções, grava a proveniência `ai` (revisão pendente), cria a `DocumentVersion` quando necessário, marca a geração `APPLIED` (`markApplied`), audita `ai.content_apply` e grava `AiContentApplied`; responde 200.
10. O editor recarrega as seções com `AiGeneratedBadge` e `ToConfirmChip` (US-122) e o painel mostra o estado **aplicada**, com atalho para revisar. O usuário pode, em vez disso, "Descartar proposta" (AI-04). A `AiHistoryTab` lista as gerações do DFD (AI-03).

## Fluxos alternativos
- **FA-01 — Cancelar durante a geração:** AI-04 leva `QUEUED`/`RUNNING` a `CANCELED`; o worker não chama o provedor ou descarta a resposta; a reserva de tokens é liberada.
- **FA-02 — Falha da geração:** o painel mostra a mensagem do `errorCode` (tabela em "Casos de erro"), a notificação `AI_GENERATION_FAILED` e o botão "Tentar novamente", que reaproveita o resumo digitado.
- **FA-03 — Abrir pela notificação:** o link `?ia=<generationId>` abre o editor com o painel já na proposta (ou no resultado, se aplicada/descartada).
- **FA-04 — Proposta expirada:** passados 7 dias a proposta fica `EXPIRED`, somente leitura; o painel oferece "Gerar novamente".
- **FA-05 — Documento mudou desde a abertura:** DOC-26 responde 412; o painel recarrega o documento e a comparação, preservando a seleção.
- **FA-06 — Proposta de outra pessoa:** quem tem `PROCESS_VIEW` e não é o solicitante vê a proposta somente leitura, sem aplicar nem descartar (RN-AI-13).
- **FA-07 — Entradas incompletas:** DFD sem itens, sem data prevista ou sem vínculo de PCA gera o aviso `MISSING_OPTIONAL_INPUT`, e as lacunas saem como "[a confirmar]"; orçamento sigiloso omite os valores e gera `BUDGET_CONFIDENTIAL_VALUES_OMITTED`.
- **FA-08 — Seção opcional sem base:** seção `OPTIONAL` (padrão `NOTES`) sem informação nas entradas pode vir ausente; o painel a lista como "Sem sugestão".
- **FA-09 — Nada marcado:** "Aplicar seleção" fica desabilitado ("Selecione ao menos uma seção").

## Regras de negócio
- **RN-AI-25** — O rascunho completo (`DRAFT`) do DFD exige `needSummary` (20..2.000 caracteres) e o DFD já criado (DFD-02) em `DRAFT`/`RETURNED`; cobre as seções narrativas da versão de template fixada no documento (as do template do órgão — padrão `JUSTIFICATION`, `EXPECTED_RESULTS`, `NOTES`), usando `title`, `helpText`, `legalBasis` e `defaultContent` como guia.
- **RN-AI-26** — Entradas do DFD (cada uma vira `inputRef`): resumo da necessidade (inputRef USER_SUMMARY) e orientações (USER_INSTRUCTION); processo (objeto, título, tipo de contratação, modalidade, origem, prioridade, situação no PCA, unidade requisitante e secretaria por nome — `PROCESS`, `CATALOG`); itens do processo (descrição, unidade, quantidade — PROCESS_ITEMS); cabeçalho do DFD (`objectSummary`, `expectedDate`, `pcaStatus`/`pcaYear`/`pcaItemCode`; `estimatedValue` só sem sigilo — DOCUMENT_DRAFT); órgão (nome, tipo, município/UF — `ORGANIZATION`); versão do template (`TEMPLATE_VERSION`).
- **RN-AI-27** — A IA escreve só seções narrativas: cabeçalho tipado, itens, quantidades, datas e valores do documento nunca são alterados pela aplicação; no texto, quantidades, valores, prazos e datas só aparecem se vierem das entradas (RN-AI-54).
- **RN-AI-28** — Aplicação (DOC-26) é ação humana do solicitante, seletiva por seção: por padrão vêm marcadas as seções `EMPTY`; seções `FILLED`/`NOT_APPLICABLE` só são substituídas com `confirmReplaceFilled: true` (senão 422 `VALIDATION_ERROR`/`CONDITIONAL_REQUIRED`) e, havendo substituição de seção preenchida em rascunho completo, cria-se antes uma `DocumentVersion` (`reason = SYSTEM`, `changeSummary` "Antes de aplicar conteúdo gerado por IA") na mesma transação. Seção `NOT_APPLICABLE` substituída passa a `FILLED` e perde a justificativa.
- **RN-AI-29** — A aplicação exige geração `SUCCEEDED`, não expirada, do mesmo documento e do próprio usuário; permissão de edição do tipo + POL-02; `If-Match` do documento + `Idempotency-Key`. Efeitos: seções aplicadas ficam `FILLED`, `revision + 1`, proveniência `ai` (RN-AI-55), `draftRevision + 1`; geração → `APPLIED` com `appliedTargets` (porta `AiSuggestionSource.markApplied`, mesma transação); auditoria `ai.content_apply`; evento `AiContentApplied` → timeline `AI_CONTENT_APPLIED`. Sem notificação. A geração só pode ser aplicada uma vez: as seções não marcadas não ficam disponíveis depois.
- **RN-AI-30** — O painel SCR-117 acompanha a geração por AI-02 (a cada 2 s, recuando até 5 s; para após 3 min e passa a depender da notificação) e pelas notificações `AI_GENERATION_READY`/`AI_GENERATION_FAILED`; o usuário pode continuar editando durante a geração. O polling é suspenso com a aba oculta.
- **RN-AI-31** — Descartar (AI-04): `SUCCEEDED` → `DISCARDED`; `QUEUED`/`RUNNING` → `CANCELED` (o worker não chama o provedor ou descarta a resposta); auditoria `ai.generation_discard`.
- **RN-AI-32** — Ao pedir novo rascunho de um documento que já tem proposta `SUCCEEDED` não aplicada do mesmo usuário, a anterior vira `DISCARDED` na mesma transação.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Resumo da necessidade | `needSummary` | texto longo com contador | Sim (rascunho do DFD) | 20..2.000 caracteres | vazio |
| Orientações (opcional) | `instruction` | texto | Não | até 500 caracteres | vazio |
| *(sistema)* Alvo da geração | `targetModule`, `kind`, `documentId` | `DFD`, `DRAFT`, uuid | Sim | DFD do processo em `DRAFT`/`RETURNED` | documento aberto no editor |
| Seções a aplicar | `sectionKeys` | lista de checkboxes | Sim (mín. 1) | chaves presentes em `output.sections` | `EMPTY` marcadas |
| Substituir texto atual | `confirmReplaceFilled` | booleano | Condicional | obrigatório se houver `FILLED`/`NOT_APPLICABLE` marcada | `false` |
| *(sistema)* Geração | `generationId` | uuid | Sim (DOC-26, AI-04) | `SUCCEEDED`, não expirada, do usuário | `?ia=` ou geração em curso |
| *(sistema)* Versão do documento | `If-Match` | cabeçalho | Sim (DOC-26) | versão lida pelo painel | ETag de DOC-03 |
| *(sistema)* Chave de idempotência | `Idempotency-Key` | cabeçalho | Sim (AI-01, DOC-26) | gerada pelo front | uuid por ação |
| *(sistema)* Estado da seção | `state` | `EMPTY`/`FILLED`/`NOT_APPLICABLE` | — | define a marcação padrão | `draftContent` atual |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `needSummary` ausente, menor que 20 ou maior que 2.000 caracteres | Front + API (Zod) | "Descreva a necessidade em 20 a 2.000 caracteres." | `VALIDATION_ERROR` |
| V-02 | `instruction` maior que 500 caracteres; `documentId` ausente para DFD | Front + API (Zod) | "Revise o pedido: as orientações aceitam até 500 caracteres." | `VALIDATION_ERROR` |
| V-03 | IA desligada no órgão | API | "A IA está desligada no seu órgão. Peça a quem administra as configurações para ativá-la." | `AI_DISABLED` |
| V-04 | Provedor indisponível ou circuito aberto | API | "O serviço de IA está indisponível. Tente novamente em instantes." | `AI_PROVIDER_UNAVAILABLE` |
| V-05 | Limite mensal do órgão ou diário do usuário atingido | API | "O limite de uso da IA foi atingido." | `AI_USAGE_LIMIT_REACHED` / `AI_USER_DAILY_LIMIT_REACHED` |
| V-06 | Já existe geração ativa para o DFD | API | "Já há uma geração em andamento para este DFD." | `AI_GENERATION_IN_PROGRESS` |
| V-07 | DFD fora de `DRAFT`/`RETURNED` | API | "O DFD não pode ser editado no status atual." | `DOCUMENT_NOT_EDITABLE` |
| V-08 | Tipo DFD não permitido na etapa | API | "O DFD não pode ser editado nesta etapa do processo." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-09 | Geração não `SUCCEEDED`, expirada ou de outro documento | API | "Esta proposta não pode mais ser aplicada. Gere novamente." | `AI_GENERATION_NOT_APPLICABLE` |
| V-10 | Seção preenchida marcada sem `confirmReplaceFilled`; `sectionKeys` vazio ou fora da proposta | Front + API | "Confirme a substituição do texto atual." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-11 | Quem aplica/descarta não é o solicitante | API | "Só quem pediu a geração pode aplicá-la ou descartá-la." | `AI_GENERATION_NOT_OWNED` |
| V-12 | `If-Match` ausente / divergente em DOC-26 | API | "O DFD foi alterado. Atualizando a comparação…" | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |

## Permissões
- **Permissão:** solicitar (AI-01): `AI_GENERATE` cobrindo o processo + `DFD_UPDATE`; aplicar (DOC-26): `DFD_UPDATE`; consultar (AI-02/AI-03): `PROCESS_VIEW`; descartar (AI-04): ser o solicitante; AI-05: qualquer usuário autenticado.
- **Políticas:** POL-18 (gerar com IA: `AI_GENERATE` + permissão de edição do tipo + POL-02 + IA ligada + provedor + limites; revalidada no worker); POL-02 na aplicação; POL-09/DEC-030 no contexto (sigilo omitido para qualquer solicitante).
- **MFA:** não exigido (`AI_GENERATE` e `DFD_UPDATE` são risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** `AiDraftButton` oculto sem `AI_GENERATE`; API responde 403 `PERMISSION_DENIED` e registra `access.denied`. Participação no processo não concede `AI_GENERATE`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `AiGenerationRequested` | `ai.generation_requested` | Commit de AI-01 | Produzido pelo pipeline da US-115; `generationId`, `processId`, `documentId`, `targetModule`, `kind` |
| `AiGenerationCompleted` | `ai.generation_completed` | Fim bem-sucedido no worker | `model`, `promptKey`, `promptVersion`, `totalTokens`, `sectionsCount`, `placeholdersCount`; projeta `AI_CONTENT_GENERATED`; dispara `AI_GENERATION_READY` |
| `AiGenerationFailed` | `ai.generation_failed` | Falha final no worker | `errorCode`, `attempts`; dispara `AI_GENERATION_FAILED` |
| `AiContentApplied` | `document.ai_content_applied.dfd` | Commit de DOC-26 | Produzido nesta story; `generationId`, `sectionKeys[]`, `replacedFilledSections`; projeta `AI_CONTENT_APPLIED` |
| `DocumentVersionCreated` | `document.version_created.dfd` | Mesmo commit, se substituiu seção preenchida | `reason = SYSTEM` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `AI_GENERATION_READY` | Solicitante da geração | In-app (sem e-mail; não obrigatória) | `AiGenerationCompleted`; link `?ia=<generationId>` para o editor do DFD |
| `AI_GENERATION_FAILED` | Solicitante da geração | In-app | `AiGenerationFailed`; link para o painel com "Tentar novamente" |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerar o rascunho do DFD com IA

  Background:
    Given que o tenant "Prefeitura de São José" está ativo com "ai.enabled" igual a true
    And o processo "0012/2026" tem o DFD "DFD 0005/2026" em "DRAFT" com 3 itens e a seção "NOTES" vazia
    And "Rita" tem vínculo ativo com o perfil "REQUISITANTE", "AI_GENERATE" e custódia do processo
    And o provedor de IA de teste (FakeAiProvider) responde com a fixture "draft.dfd/padrao"

  Scenario: [Sucesso] Solicitar o rascunho do DFD
    When "Rita" solicitar o rascunho com um resumo de 180 caracteres
    Then a API deve responder 202 com a geração em "QUEUED" e o cabeçalho "Location"
    And deve gerar registro de auditoria "ai.generation_request"
    And deve gerar o evento "AiGenerationRequested"
    And o job "ai-generation" deve ser enfileirado somente após o commit

  Scenario: [Sucesso] Concluir a geração e avisar a solicitante
    Given que a geração de "Rita" está "QUEUED"
    When o worker processar o job
    Then a geração deve ficar "SUCCEEDED" com proposta para "JUSTIFICATION", "EXPECTED_RESULTS" e "NOTES"
    And as "inputRefs" devem listar resumo, processo, itens, cabeçalho do DFD, órgão e template
    And "Rita" deve receber a notificação "AI_GENERATION_READY"
    And a timeline deve exibir "AI_CONTENT_GENERATED"

  Scenario: [Sucesso] Aplicar apenas as seções vazias
    Given que "JUSTIFICATION" e "EXPECTED_RESULTS" estão vazias e a proposta está "SUCCEEDED"
    When "Rita" aplicar as duas seções com "If-Match" da versão atual
    Then a API deve responder 200 com "appliedSectionKeys" igual a ["JUSTIFICATION", "EXPECTED_RESULTS"] e "versionCreated" nulo
    And as seções devem estar "FILLED" com "ai.reviewedAt" nulo e a geração "APPLIED"
    And o cabeçalho e os itens do DFD não devem ser alterados
    And deve gerar registro de auditoria "ai.content_apply" e o evento "AiContentApplied"

  Scenario: [Sucesso] Substituir seção preenchida cria versão antes
    Given que "JUSTIFICATION" está "FILLED" com texto de "Rita"
    When "Rita" aplicar "JUSTIFICATION" com "confirmReplaceFilled" igual a true
    Then deve existir uma versão com "reason" igual a "SYSTEM" e o texto anterior
    And o evento "AiContentApplied" deve ter "replacedFilledSections" igual a 1
    And deve gerar o evento "DocumentVersionCreated"

  Scenario: [Sucesso] Descartar e substituir propostas
    Given que "Rita" tem uma proposta "SUCCEEDED" não aplicada
    When "Rita" descartar a proposta
    Then a geração deve ficar "DISCARDED" e deve existir a auditoria "ai.generation_discard"
    When "Rita" solicitar um novo rascunho e depois outro após a conclusão do primeiro
    Then a proposta anterior não aplicada deve ficar "DISCARDED" na mesma transação do novo pedido

  Scenario: [Sucesso] Orçamento sigiloso e entradas faltantes
    Given que o processo tem orçamento sigiloso e o DFD não tem itens
    When a geração for concluída
    Then o contexto enviado ao provedor não deve conter o valor estimado
    And a proposta deve ter os avisos "BUDGET_CONFIDENTIAL_VALUES_OMITTED" e "MISSING_OPTIONAL_INPUT"

  Scenario: [Validação] Resumo fora do tamanho permitido
    When "Rita" solicitar o rascunho com um resumo de 10 caracteres
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "needSummary"
    And nenhuma geração deve ser registrada

  Scenario: [Validação] DFD em aprovação e IA desligada
    Given que o DFD está "IN_REVIEW"
    When "Rita" solicitar o rascunho
    Then a API deve responder 409 com código "DOCUMENT_NOT_EDITABLE"
    Given que o DFD voltou a "DRAFT" e o órgão desligou a IA
    When "Rita" solicitar o rascunho
    Then a API deve responder 403 com código "AI_DISABLED"

  Scenario: [Validação] Substituição sem confirmação e proposta expirada
    Given que "JUSTIFICATION" está "FILLED" e a proposta está "SUCCEEDED"
    When "Rita" aplicar "JUSTIFICATION" sem "confirmReplaceFilled"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" no campo "confirmReplaceFilled"
    Given que a proposta passou de 7 dias e ficou "EXPIRED"
    When "Rita" aplicar a proposta
    Then a API deve responder 409 com código "AI_GENERATION_NOT_APPLICABLE"

  Scenario: [Permissão] Usuário sem AI_GENERATE
    Given que "Bruno" tem "DFD_UPDATE" mas não tem "AI_GENERATE"
    When "Bruno" solicitar o rascunho
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Permissão] Outro usuário tenta aplicar ou descartar
    Given que a proposta é de "Rita" e "Carla" tem "DFD_UPDATE" no processo
    When "Carla" aplicar ou descartar a proposta
    Then a API deve responder 403 com código "AI_GENERATION_NOT_OWNED"

  Scenario: [Tenant incorreto] Geração e DFD de outro tenant
    Given que existe uma geração e um DFD no tenant "Prefeitura B"
    When "Rita", no tenant "Prefeitura de São José", consultar essa geração
    Then a API deve responder 404 com código "AI_GENERATION_NOT_FOUND"
    When "Rita" solicitar o rascunho com o "documentId" do DFD da "Prefeitura B"
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Rita" solicitou o rascunho com a chave "K1" e recebeu 202
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 202 com o cabeçalho "Idempotent-Replayed: true"
    And deve existir uma única geração e um único job

  Scenario: [Duplicidade] Segunda geração enquanto há uma ativa
    Given que existe uma geração do DFD em "RUNNING"
    When "Rita" solicitar outro rascunho do mesmo DFD com outra chave
    Then a API deve responder 409 com código "AI_GENERATION_IN_PROGRESS" e "meta.generationId" da geração ativa

  Scenario: [Concorrência] DFD alterado entre abrir o painel e aplicar
    Given que "Rita" abriu a proposta com a versão 6 do DFD
    When outra pessoa editar o DFD, criando a versão 7
    And "Rita" aplicar a proposta com "If-Match: \"6\""
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And a geração deve continuar "SUCCEEDED"

  Scenario: [Concorrência] Cancelamento durante a execução
    Given que o worker está chamando o provedor para a geração de "Rita"
    When "Rita" cancelar a geração
    Then a geração deve ficar "CANCELED" e a resposta do provedor deve ser descartada
    And nenhuma seção do DFD deve ser alterada

  Scenario: [Falha de banco] Banco indisponível na aplicação
    Given que o banco de dados fica indisponível durante a transação de DOC-26
    When "Rita" aplicar a proposta
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma seção deve ser alterada e a geração deve continuar "SUCCEEDED"

  Scenario: [Falha de integração] Provedor de IA indisponível
    Given que o provedor de IA de teste responde 503 em todas as tentativas
    When o worker processar o job
    Then a geração deve ficar "FAILED" com "errorCode" igual a "PROVIDER_UNAVAILABLE" após 3 tentativas
    And "Rita" deve receber a notificação "AI_GENERATION_FAILED"
    And deve gerar o evento "AiGenerationFailed" e a auditoria "ai.generation_fail"

  Scenario: [Falha de integração] Circuito aberto e relay do outbox indisponível
    Given que o circuito do provedor está aberto
    When "Rita" solicitar o rascunho
    Then a API deve responder 503 com código "AI_PROVIDER_UNAVAILABLE" e o cabeçalho "Retry-After"
    Given que o circuito fechou e o relay do outbox está indisponível
    When "Rita" aplicar uma proposta com sucesso
    Then a API deve responder 200 e o evento "AiContentApplied" deve permanecer "PENDING" no outbox
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido (resumo, orientações) | 422 | `VALIDATION_ERROR` | "Descreva a necessidade em 20 a 2.000 caracteres." | Marca o campo; mantém o texto |
| IA desligada | 403 | `AI_DISABLED` | "A IA está desligada no seu órgão." | Botão desabilitado com o motivo |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerar conteúdo com IA neste DFD." | Botão oculto; API bloqueia |
| Não é o solicitante | 403 | `AI_GENERATION_NOT_OWNED` | "Só quem pediu a geração pode aplicá-la ou descartá-la." | Ações ocultas; proposta somente leitura |
| Geração ou documento inexistente/outro tenant | 404 | `AI_GENERATION_NOT_FOUND` / `NOT_FOUND` | "Proposta não encontrada." | Fecha o painel |
| DFD não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "O DFD não pode ser editado no status atual." | Oculta as ações de IA |
| Geração ativa | 409 | `AI_GENERATION_IN_PROGRESS` | "Já há uma geração em andamento para este DFD." | Abre o painel na geração ativa (`meta.generationId`) |
| Proposta não aplicável | 409 | `AI_GENERATION_NOT_APPLICABLE` | "Esta proposta não pode mais ser aplicada. Gere novamente." | Painel somente leitura com "Gerar novamente" |
| `If-Match` divergente / ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "O DFD foi alterado. Atualizando a comparação…" | Recarrega documento e comparação |
| Limite de uso | 422 | `AI_USAGE_LIMIT_REACHED` / `AI_USER_DAILY_LIMIT_REACHED` | "O limite de uso da IA foi atingido." | Botão desabilitado com o motivo |
| Substituição sem confirmação | 422 | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) | "Confirme a substituição do texto atual." | Abre o diálogo de confirmação |
| Idempotência | 422 / 409 | `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_IN_PROGRESS` | "Esta solicitação já foi enviada com outros dados." / "Estamos concluindo. Aguarde." | Gera nova chave / repete após 2 s |
| Excesso de pedidos | 429 | `RATE_LIMITED` | "Muitos pedidos seguidos. Aguarde um instante." | Respeita `Retry-After` |
| Provedor indisponível / Redis ou banco fora | 503 | `AI_PROVIDER_UNAVAILABLE` / `DEPENDENCY_UNAVAILABLE` | "O serviço de IA está indisponível. Tente novamente em instantes." | Mantém o formulário; "Tentar novamente" |
| Falha assíncrona: provedor, limite do provedor, tempo | — | `errorCode` `PROVIDER_UNAVAILABLE` / `PROVIDER_RATE_LIMITED` / `TIMEOUT` | "A geração não foi concluída. Tente novamente." | Estado "falhou" com "Tentar novamente" |
| Falha assíncrona: conteúdo, contexto, saída | — | `errorCode` `CONTENT_FILTERED` / `CONTEXT_TOO_LARGE` / `OUTPUT_INVALID` | "Reformule o resumo ou reduza as informações do processo e tente de novo." | Estado "falhou" mantendo o resumo |
| Falha assíncrona: política | — | `errorCode` `CANCELED_BY_POLICY` | "A geração foi cancelada porque a IA foi desligada ou suas permissões mudaram." | Estado "cancelada" |

## Dependências
- **Stories:** US-015 (editor SCR-007 e autosave), US-116 (ativação, limites, AI-05, `AI_GENERATE`), US-122 (GroundingGuard, `toConfirm`, proveniência e revisão). Indiretas: US-115 (pipeline, `AiGeneration`, AI-01..AI-04), US-014 e US-110 (DFD e template semeado), US-066 (versões), US-006 (itens). Habilita: US-118..US-121, que reutilizam painel, fluxo e DOC-26.
- **Decisões/ADRs:** DEC-017, DEC-030, DEC-037, DEC-079, DEC-104, DEC-105, DEC-140, DEC-164, DEC-182, DEC-183, DEC-184; ADR-013 e PEND-21 (provedor real, a decidir — até lá `FakeAiProvider`).
- **Configurações:** `ai.enabled`, `ai.monthlyTokenLimit`, `ai.userDailyRequestLimit`; plataforma: `AI_PROVIDER`, `AI_MODEL_DRAFT`, `AI_REQUEST_TIMEOUT_MS`.
- **Lacunas nas fontes canônicas:**
  1. *(Resolvida em api/03-documents.md, 2026-10-16.)* O `ETag` de DOC-03 (`document.version`) muda a cada autosave; em 412 o painel recarrega e repete a aplicação.
  2. *(Decidida em api/16-ai.md e screens.md.)* O cliente monta a lista com os dados já carregados; os avisos definitivos vêm em `output.warnings`.
  3. *(Resolvida em api/03-documents.md.)* Uma aplicação por geração (aplicar parte encerra a proposta), exceto a proposta do `RISK_MAP`, com duas partes.

## Impacto técnico
- Primeira geração de ponta a ponta: define o contrato do registro de geradores (`targetModule` + `kind`), o `FakeAiProvider` por fixture e os testes de contrato que as US-118..US-121 herdam; DOC-26 nasce genérico (qualquer `SystemDocumentModule`), com testes específicos por tipo nas stories seguintes.
- O contexto do DFD é pequeno (≈ 15 mil tokens reservados, RN-AI-18); acima do limite do modelo o gerador reduz itens e emite `CONTEXT_TRUNCATED`, e persistindo o excesso termina `CONTEXT_TOO_LARGE`.
- Prompt `draft.dfd` em `apps/api/src/modules/ai/prompts/draft.dfd/`, versão semântica inicial `1.0.0`; qualquer mudança de texto gera nova `promptVersion` (RN-AI-06). Modelo: `AI_MODEL_DRAFT`.
- Carga de leitura: polling de AI-02 a cada 2–5 s por painel aberto; usa a classe de rate limit de leitura. AI-01 usa a classe "Geração com IA" (10 req/min por usuário + tenant).
- Meta (suíte de performance, não medida no card): rascunho completo p95 ≤ 90 s; AI-01 p95 ≤ 1 s.

## Backend
- **Módulo(s):** `ai` (dono de `AiGeneration`, gerador `draft.dfd`, implementação de `AiSuggestionSource`), `document` (DOC-26), `dfd` e `process` (fachadas de leitura), `catalog`, `tenancy`, `access`, `timeline`, `notification`, `audit`, `platform`.
- **Casos de uso:** `RequestAiGenerationCommand` (US-115) com o validador `DfdDraftRequestPolicy`; `DfdDraftGenerator` (registrado em `AiGeneratorRegistry` para `DFD`/`DRAFT`) e `DfdDraftContextAssembler`; `ApplyAiContentCommand` → `ApplyAiContentHandler` (DOC-26); `DiscardAiGenerationCommand` (US-115).
- **Domínio:** `AiGeneration` (transições condicionais, RN-AI-03); `Document.applyAiSections(output, sectionKeys, confirmReplaceFilled)`; `SectionAiProvenance`; schema Zod `AiGenerationOutput` (§5.10).
- **Integrações internas:** `ProcessReadFacade`, `DfdReadFacade`, `CatalogReadFacade`, `OrganizationReadFacade` (somente leitura); `DocumentFacade.createVersion(reason: 'SYSTEM')`; `AiSuggestionSource.loadForApply`/`markApplied`; `AuthorizationService.assertCan('AI_GENERATE' | 'DFD_UPDATE', { processId })`; `AiProvider` (porta, ACL).
- **Transação:** AI-01 — POL-18, limites (lock `pg_advisory_xact_lock` por tenant), descarte da proposta anterior, `AiGeneration` + reserva, auditoria e outbox; fila após o commit. Worker — leitura do contexto em transação do tenant; chamada ao provedor fora de transação; gravação do resultado em transação curta. DOC-26 — `loadForApply`, `DocumentVersion` (se preciso), seções + proveniência, `markApplied`, auditoria, outbox e timeline em uma única transação.

## Frontend
- **Tela(s):** SCR-007 (`/processos/[id]/dfd/[dfdId]`) com o painel SCR-117 (`?ia=<generationId>`).
- **Componentes:** `AiDraftButton`, `AiAssistantPanel` (estados formulário → gerando → proposta pronta → aplicada / falhou), `AiRequestForm`, `AiGenerationProgress`, `AiProposalSectionList`, `AiSectionDiffView`, `AiHistoryTab`, `AiDisclaimer`; reutiliza `AiGeneratedBadge` e `ToConfirmChip` (US-122). Hook `useAiGeneration(generationId)` com o polling da RN-AI-30.
- **Estados:** loading (skeleton do painel e da lista), vazio (histórico sem gerações), erro (falha da geração, conflito, proposta expirada), sucesso (toast "Conteúdo aplicado: N seções. Revise antes de concluir").
- **Acessibilidade e responsividade:** painel com foco movido ao abrir e devolvido ao botão ao fechar; progresso e "proposta pronta" anunciados por `aria-live="polite"`; checkboxes e diff navegáveis por teclado, com diferenças marcadas por rótulos "Atual"/"Sugerido" e não só por cor; abaixo de 768 px o painel vira folha em tela cheia e o diff vira abas; respeita `prefers-reduced-motion`.

## Banco de dados
- **Tabelas:** `ai_generations` (insert/update), `documents` (`draft_content`, `draft_revision`), `document_versions` (insert condicional), `audit_logs`, `outbox_events`, `timeline_entries`, `notifications`.
- **Migrações:** nenhuma nova — `ai_generations` vem da US-115 e o formato de `ai` em `draftContent` da US-122.
- **Índices/constraints relevantes:** único parcial `(tenant_id, process_id, target_module) WHERE kind = 'DRAFT' AND status IN ('QUEUED','RUNNING')` (RN-AI-12); índice `(tenant_id, process_id, created_at DESC)` para a `AiHistoryTab`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `AI-01` | POST | `/processes/{id}/ai-generations` | `{ targetModule: 'DFD', documentId, kind: 'DRAFT', needSummary, instruction? }` + `Idempotency-Key` | `202 { data: AiGeneration, meta: { pollAfterMs: 2000 } }` + `Location` | 202, 401, 403, 404, 409, 422, 429, 503 |
| `AI-02` | GET | `/ai-generations/{generationId}` | — | `200 { data: AiGeneration }` com `status`, `usage`, `placeholdersCount`, `output` | 200, 403, 404 |
| `AI-03` | GET | `/processes/{id}/ai-generations` | filtros `documentId`, `targetModule`, `kind`, `status`, `requestedById` | lista paginada sem `output` | 200, 403, 404 |
| `AI-04` | POST | `/ai-generations/{generationId}/discard` | `{}` | `200 { data: AiGeneration }` | 200, 403, 404, 409 |
| `AI-05` | GET | `/ai/availability?processId=&documentId=` | — | `200 { data: { enabled, providerAvailable, canGenerate, reasons[], monthly, userDaily } }` | 200, 401 |
| `DOC-26` | POST | `/documents/{id}/ai-apply` | `{ generationId, sectionKeys: string[], confirmReplaceFilled?: boolean }` + `If-Match` + `Idempotency-Key` | `200 { data: { document, appliedSectionKeys, versionCreated: { id, versionNumber } \| null } }` | 200, 401, 403, 404, 409, 412, 422, 428, 503 |
| `DOC-03` | GET | `/documents/{id}` | — | documento com `draftContent` e ETag (recarga após aplicar) | 200, 403, 404 |

## Logs
- `info` `ai.generation_requested` — `generationId`, `processId`, `targetModule`, `kind`, `reservedTokens`.
- `info` `ai.generation_succeeded` — `generationId`, `model`, `promptKey`, `promptVersion`, tokens, `latencyMs`, `placeholdersCount`, `groundingReplacements`.
- `info` `ai.content_applied` — `generationId`, `documentId`, `sectionsCount`, `replacedFilledSections`, `durationMs`.
- `warn` `ai.generation_retry` — `generationId`, `attempt`, `errorCode`; `warn` `idempotency.store_unavailable` quando o Redis falhar.
- `error` `ai.generation_failed` / `ai.apply_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** `needSummary`, `instruction`, contexto enviado, texto da proposta, conteúdo das seções, valores do processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `ai.generation_request` | `DATA_CHANGE` | Commit de AI-01 | `metadata`: `generationId`, `targetModule`, `kind`, `promptKey`, `promptVersion`, `reservedTokens`, `idempotencyKey`; nunca o resumo |
| `ai.generation_discard` | `DATA_CHANGE` | AI-04 (descarte ou cancelamento) | `metadata`: `generationId`, status anterior |
| `ai.content_apply` | `DATA_CHANGE` | Commit de DOC-26 | `changes`: chaves das seções aplicadas; `metadata`: `generationId`, `model`, `promptVersion`, `inputRefs`, `contextHash`, `outputHash`, `replacedFilledSections`; nunca o texto |
| `ai.generation_complete` / `ai.generation_fail` | `SYSTEM` | Fim da execução no worker | tokens, `costUsd`, `errorCode`, `attempts` (produzidas no pipeline da US-115) |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode` = `AI_GENERATE` ou `DFD_UPDATE` |

## Testes necessários
- **Unitários:** `DfdDraftRequestPolicy` (tamanhos, estados); montagem do contexto e dos `inputRefs` (RN-AI-26), incluindo sigilo e redação de dados pessoais; schema da saída; seleção padrão por `state`; `Document.applyAiSections` (revisão, proveniência, `NOT_APPLICABLE` → `FILLED`); transições de `AiGeneration`.
- **Integração (Testcontainers PostgreSQL + Redis):** pipeline completa com `FakeAiProvider` (AI-01 → worker → AI-02 → DOC-26); versão `SYSTEM` antes da substituição; `markApplied` na mesma transação; descarte automático (RN-AI-32); índice único parcial; RLS; outbox, timeline e notificações.
- **API/contrato:** AI-01..AI-05 e DOC-26 conforme api.md (`Location`, `meta.pollAfterMs`, `Idempotent-Replayed`, `If-Match`); teste de contrato do `AiProvider` com a fixture.
- **RBAC e multi-tenant:** `AI_GENERATE` + `DFD_UPDATE` por perfil e escopo; participação não concede; só o solicitante aplica/descarta; geração e documento de outro tenant → 404 (suíte "tenant leak").
- **Concorrência:** duas solicitações simultâneas (uma 202, outra 409); aplicação × edição (412); cancelamento × execução; dois cliques em "Aplicar" com a mesma chave.
- **E2E (Playwright):** formulário → geração → notificação → aplicação seletiva → revisão (US-122); abertura por `?ia=`; falha do provedor e "Tentar novamente"; painel em 360 px.
- **Acessibilidade/performance:** axe no painel, na lista e no diff; teste de carga do polling; meta de p95 registrada na suíte de performance (medida no endurecimento).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `AI_GENERATE`, `DFD_UPDATE`, POL-18 e POL-02 aplicados na API; ações ocultas sem permissão
- [ ] Nenhuma chamada ao provedor dentro de transação ou da requisição HTTP, comprovada por teste
- [ ] Aplicação em transação única comprovada por teste de falha induzida
- [ ] Auditoria, eventos, timeline e notificações verificados em teste
- [ ] Contexto sem dados pessoais nem valores sigilosos, verificado por teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de AI-01..AI-05 e DOC-26 compatível com api.md
- [ ] Logs sem conteúdo; métricas `cf_ai_*` e traces da geração presentes
- [ ] Painel acessível (axe) e responsivo (360 px)
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e as lacunas registradas) atualizada

## Estimativa
**L** — primeiro fluxo de geração completo: contexto sanitizado, gerador e prompt versionado, aplicação seletiva e transacional (DOC-26), painel com cinco estados, comparação lado a lado e testes de pipeline com provedor falso; as stories seguintes herdam grande parte da infraestrutura.

## Prioridade
**P1** — é a base de todo o épico de IA (US-118..US-121 dependem do fluxo e do painel) e o ganho de produtividade mais visível para a área requisitante na abertura do processo.

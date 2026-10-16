---
id: US-121
title: "Ajustar seção com IA: reescrever, completar e resumir"
epic: EP-020
feature: FT-062
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-020, US-035, US-036, US-117]
modules: [ai, document, dfd, etp, risk, term, process, access, timeline, audit, platform]
screens: [SCR-007, SCR-008, SCR-011, SCR-012, SCR-117]
endpoints: [AI-01, AI-02, AI-04, AI-05, DOC-26, DOC-05]
permissions: [AI_GENERATE, DFD_UPDATE, ETP_UPDATE, RISK_MANAGE, TERM_UPDATE, PROCESS_VIEW]
events: [AiGenerationRequested, AiGenerationCompleted, AiGenerationFailed, AiContentApplied]
---

# US-121 — Ajustar seção com IA: reescrever, completar e resumir

## Título
Ajustar seção com IA: reescrever, completar e resumir

## Descrição
**Como** redator de um documento do planejamento (DFD, ETP, Mapa de Riscos ou TR), **quero** pedir à IA que reescreva, complete ou resuma uma seção que já comecei, **para** melhorar a clareza e preencher lacunas sem perder o controle do texto final.

O menu da seção (`AiSectionMenu`) dispara um pedido `kind = SECTION` com a ação escolhida e uma orientação opcional. A sugestão volta de forma assíncrona e é mostrada lado a lado com o texto atual (`AiSectionDiffView`); só a ação humana de aplicar substitui a seção, e o painel oferece "Desfazer" enquanto estiver aberto. O conteúdo ajustado volta a exigir revisão.

## Contexto
- Redatores já têm o texto, mas gastam tempo em linguagem administrativa, em lacunas de fundamentação e em resumos para o TR; DEC-037 (prd-3) inclui o ajuste por seção ao lado do rascunho completo, com a pessoa sempre revisando e aprovando (princípio 16).
- Reaproveita o fluxo genérico de US-117 (RN-AI-25..32, painel SCR-117, `DOC-26`), a camada de US-115 (RN-AI-01..15) e as marcações de US-122 (RN-AI-53..58): "[a confirmar]", GroundingGuard, proveniência e revisão.
- Seções vêm do template do órgão (`SectionDefinition`: `render`, `allowNarrative`, `maxChars`, `legalBasis`, `helpText`); a seção aplicada usa o modelo híbrido de DEC-017 (`draftContent`, `revision` por seção).
- Vale nos quatro editores: SCR-007 (DFD), SCR-008 (ETP), SCR-011 (seções `INTRODUCTION`, `METHODOLOGY`, `NOTES` do `RISK_MAP`) e SCR-012 (TR).

## Objetivo
Permitir que qualquer seção narrativa de DFD, ETP, Mapa de Riscos e TR seja ajustada por IA em um ciclo curto (pedir, comparar, aplicar ou desfazer), sem nunca alterar o documento sem confirmação e sem esconder que o texto veio da IA.

## Persona
- **Principal:** Redator do documento — Planejamento (`PLANEJAMENTO`) ou Requisitante (`REQUISITANTE`).
- **Secundárias:** Compras (`COMPRAS`), Gestor de contratações (`GESTOR_CONTRATACOES`), Gestor de contrato (`GESTOR_CONTRATO`); `CONSULTOR_EXTERNO` não vê o menu (sem `AI_GENERATE`).

## Pré-condições
- `ai.enabled = true` no órgão, provedor disponível e limites não atingidos (US-116).
- Usuário com `AI_GENERATE` e a permissão de edição do tipo (`DFD_UPDATE`, `ETP_UPDATE`, `RISK_MANAGE` ou `TERM_UPDATE`), com custódia ou participação (POL-02).
- Documento em `DRAFT`/`RETURNED`, tipo permitido na etapa; para o Mapa de Riscos, o `RISK_MAP` já emitido (`documentId` obrigatório em `SECTION`).
- Seção narrativa do template (`render = TEXT` ou `allowNarrative = true`) e não marcada como `NOT_APPLICABLE`.

## Fluxo principal
1. No editor, o usuário abre o `AiSectionMenu` ("IA ▸ Reescrever / Completar / Resumir") no cabeçalho da seção; o front usa `AI-05` para habilitar ou explicar a indisponibilidade.
2. O painel SCR-117 abre com formulário curto: ação escolhida, **"Orientação"** opcional (até 500 caracteres, com contador), entradas que serão usadas (seção atual e dados do documento) e consumo estimado (6 mil tokens).
3. O usuário clica em **"Gerar sugestão"**; o front envia `AI-01` (`kind = SECTION`, `action`, `sectionKey`, `instruction?`) com `Idempotency-Key`.
4. A API valida POL-18, a seção, o conteúdo mínimo, os limites e a unicidade (RN-AI-12), registra `baseRevision` com a revisão atual da seção, grava `QUEUED` com reserva de tokens, audita `ai.generation_request`, enfileira após o commit e responde 202.
5. O painel acompanha por `AI-02` (RN-AI-30); o usuário pode continuar editando outras seções.
6. O worker usa o prompt `section.rewrite`, `section.complete` ou `section.summarize`, aplica o GroundingGuard e grava `SUCCEEDED`; o solicitante recebe `AI_GENERATION_READY`.
7. O `AiSectionDiffView` mostra o texto atual × sugerido, com os "[a confirmar]" destacados e a contagem; as ações são **"Aplicar"**, **"Descartar"** e **"Gerar de novo"**.
8. Ao aplicar, o front envia `DOC-26` (`sectionKeys: [sectionKey]`, `confirmReplaceFilled: true`) com `If-Match` do documento e `Idempotency-Key`.
9. A API, em uma transação, revalida geração, dono, editabilidade e `baseRevision`; substitui a seção, incrementa `revision` e `draftRevision`, grava a proveniência `ai` nova, move a geração a `APPLIED`, audita `ai.content_apply` e publica `AiContentApplied`; responde 200 com `versionCreated = null`.
10. O editor exibe o novo texto com `AiGeneratedBadge`; o painel guarda o texto anterior e mostra **"Desfazer"**, que restaura por `DOC-05` enquanto a seção não for editada de novo. A seção segue "revisão pendente" até a revisão humana (`DOC-27`, US-122).

## Fluxos alternativos
- **FA-01 — Seção curta ou vazia:** "Reescrever" e "Resumir" ficam desabilitados ("A seção precisa de ao menos 50 caracteres"); "Completar" funciona e parte das orientações do template.
- **FA-02 — Seção mudou desde o pedido:** `DOC-26` responde 410 `AI_SUGGESTION_STALE`; o painel descarta a sugestão (`AI-04`) e oferece "Gerar de novo" com ação e orientação preenchidas.
- **FA-03 — Seção sem narrativa, fora do template ou `NOT_APPLICABLE`:** o menu não aparece ou fica desabilitado com o motivo; a API responde 422 `AI_SECTION_NOT_SUPPORTED`.
- **FA-04 — Seção já revisada:** a comparação avisa "Depois de aplicar, a seção precisará ser revisada novamente" (RN-AI-51).
- **FA-05 — Outra parte do documento mudou:** `DOC-26` responde 412 `VERSION_CONFLICT`; o painel recarrega o documento e reapresenta a comparação se a revisão da seção não mudou.
- **FA-06 — "Desfazer" indisponível:** se a seção foi editada depois da aplicação ou o painel foi fechado, o botão some; o texto anterior só existe na memória do painel.

## Regras de negócio
- Fluxo genérico e governança: RN-AI-01..15 (US-115), RN-AI-16..24 (US-116), RN-AI-25..32 (US-117), RN-AI-53..58 (US-122); abaixo, só o que é próprio do ajuste por seção.
- **RN-AI-47** — `kind = SECTION` com `action`: `REWRITE` (reescreve com clareza e linguagem administrativa, mantendo fatos e marcações), `COMPLETE` (completa lacunas segundo a orientação e a base legal da seção e os dados do processo, preservando o texto existente) e `SUMMARIZE` (resume preservando fatos e marcações). `instruction` é opcional (≤ 500 caracteres, sanitizada como o resto do contexto — RN-AI-05). Prompts `section.rewrite`, `section.complete`, `section.summarize` (`promptKey`, com `promptVersion`); a saída é uma única seção com a `sectionKey` pedida, no limite de `maxChars`.
- **RN-AI-48** — Disponível nas seções narrativas dos quatro documentos em `DRAFT`/`RETURNED`, com POL-18 (`AI_GENERATE` + `DFD_UPDATE`/`ETP_UPDATE`/`RISK_MANAGE`/`TERM_UPDATE`). `REWRITE` e `SUMMARIZE` exigem ao menos 50 caracteres de texto (senão 422 `AI_SECTION_EMPTY`); `COMPLETE` aceita seção vazia; seção fora do template ou sem narrativa → 422 `AI_SECTION_NOT_SUPPORTED`. Entradas: o conteúdo atual da seção (`inputRef` `SECTION` com `revision` e `contentHash`) e as entradas do documento (RN-AI-26, RN-AI-34, RN-AI-38, RN-AI-43), usando os antecessores que existirem (sem `AI_PREREQUISITE_MISSING`; faltas viram `MISSING_OPTIONAL_INPUT`).
- **RN-AI-49** — A geração registra `baseRevision` (revisão da seção em `AI-01`); aplicar com a seção em outra revisão → 410 `AI_SUGGESTION_STALE`, e a pessoa refaz o ajuste. A sugestão não é reaproveitada sobre texto diferente do que a IA leu.
- **RN-AI-50** — `DOC-26` substitui a seção inteira depois da comparação lado a lado; a tela de comparação é a confirmação (o cliente envia `confirmReplaceFilled: true`). O ajuste não cria `DocumentVersion`: o painel guarda o texto anterior e oferece "Desfazer" enquanto aberto, restaurando por `DOC-05` (`If-Match: "s<revision>"`). `replacedFilledSections` = 1 se a seção estava `FILLED`, 0 se estava `EMPTY` (`COMPLETE`).
- **RN-AI-51** — O texto ajustado recebe proveniência `ai` nova (`reviewedAt` nulo), mesmo que a seção estivesse revisada; "[a confirmar]" existentes são preservados e o GroundingGuard reaplica a RN-AI-54 — o texto atual faz parte dos fatos das entradas, então valores já escritos pela pessoa não são trocados. Enquanto pendente, valem `SECTION_AI_REVIEW_PENDING` e `SECTION_PLACEHOLDER_PENDING` (RN-AI-57).
- **RN-AI-52** — Cada ajuste consome a estimativa de 6 mil tokens (`reservedTokens`) e conta no limite diário do usuário (RN-AI-18/19); há uma geração ativa por seção (RN-AI-12), enquanto seções diferentes podem ser pedidas em paralelo.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Ação | `action` | `REWRITE`/`COMPLETE`/`SUMMARIZE` | Sim | enum `AiSectionAction` | escolhida no `AiSectionMenu` |
| Orientação | `instruction` | texto curto | Não | até 500 caracteres, contador | vazio |
| Seção | `sectionKey` | string | Sim | existe no template fixado e é narrativa | seção do menu |
| Documento / alvo / tipo | `documentId`, `targetModule`, `kind` | uuid, enum, enum | Sim | `kind` fixo `SECTION`; `documentId` do processo e do tipo do alvo | derivados do editor |
| *(sistema)* Revisão base | `baseRevision` | int | — | revisão da seção em `AI-01` | lida pela API |
| Seção a aplicar | `sectionKeys` (`DOC-26`) | `string[]` | Sim | exatamente a `sectionKey` da geração | da geração |
| Confirmação da substituição | `confirmReplaceFilled` | booleano | Sim, se a seção estiver preenchida | `true` após a comparação | enviado pela tela |
| Versão do documento | `If-Match` | cabeçalho | Sim (`DOC-26`) | ETag do documento lido ao abrir a comparação | do `GET` do documento |
| Chave de idempotência | `Idempotency-Key` | cabeçalho | Sim (`AI-01`, `DOC-26`) | uuid por tentativa | gerada no front |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `action` ausente/inválida, `sectionKey` ou `documentId` ausentes, `instruction` > 500 | Front + API (Zod) | "Escolha uma ação e use até 500 caracteres na orientação." | `VALIDATION_ERROR` |
| V-02 | `REWRITE`/`SUMMARIZE` com menos de 50 caracteres | Front + API | "A seção precisa de ao menos 50 caracteres. Use 'Completar' ou escreva um pouco mais." | `AI_SECTION_EMPTY` |
| V-03 | Seção fora do template, sem narrativa ou `NOT_APPLICABLE` | API | "Esta seção não pode ser ajustada com IA." | `AI_SECTION_NOT_SUPPORTED` |
| V-04 | Documento fora de `DRAFT`/`RETURNED` ou tipo não permitido na etapa | API | "O documento não pode ser editado no status atual." | `DOCUMENT_NOT_EDITABLE`, `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-05 | Já há ajuste ativo para a seção | API | "Já há um ajuste em andamento nesta seção." | `AI_GENERATION_IN_PROGRESS` |
| V-06 | IA desligada, provedor indisponível ou limites | API | conforme US-115/US-116 | `AI_DISABLED`, `AI_PROVIDER_UNAVAILABLE`, `AI_USAGE_LIMIT_REACHED`, `AI_USER_DAILY_LIMIT_REACHED` |
| V-07 | Geração não `SUCCEEDED`, expirada, de outro documento/seção; não é o solicitante | API | "Esta sugestão não pode mais ser aplicada." | `AI_GENERATION_NOT_APPLICABLE`, `AI_GENERATION_NOT_OWNED` |
| V-08 | `sectionKeys` diferente da geração ou substituição sem `confirmReplaceFilled` | Front + API | "Confirme a substituição depois de comparar." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-09 | Seção em outra revisão desde o pedido | API | "A seção mudou desde o pedido. Gere o ajuste novamente." | `AI_SUGGESTION_STALE` |
| V-10 | `If-Match` ausente ou divergente | API | "Atualize a página e tente novamente." | `PRECONDITION_REQUIRED`, `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `AI_GENERATE` mais a permissão de edição do tipo do documento (`DFD_UPDATE`, `ETP_UPDATE`, `RISK_MANAGE`, `TERM_UPDATE`), com escopo que cubra o processo; `PROCESS_VIEW` para consultar `AI-02`.
- **Políticas:** POL-18 (inclui `ai.enabled`, provedor e limites; revalidada no worker — RN-AI-22); POL-02 sobre o documento; só o solicitante aplica ou descarta (RN-AI-13).
- **MFA:** não exigido (permissões de risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** sem `AI_GENERATE` o `AiSectionMenu` não aparece; sem a permissão de edição ou com `canGenerate = false` fica desabilitado com o motivo; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `AiGenerationRequested` | `ai.generation_requested` | Commit de `AI-01` | `kind = SECTION`, `action`, `sectionKey` (US-115) |
| `AiGenerationCompleted` / `AiGenerationFailed` | `ai.generation_completed` / `ai.generation_failed` | Término do worker | Timeline `AI_CONTENT_GENERATED` com `sectionTitle` (US-115) |
| `AiContentApplied` | `document.ai_content_applied.<type>` (`dfd`, `etp`, `risk_map`, `tr`) | Commit de `DOC-26` | `sectionKeys` com 1 chave, `riskIds` vazio, `replacedFilledSections` 0 ou 1; timeline `AI_CONTENT_APPLIED` |

`DocumentVersionCreated` não é gerado: o ajuste de seção não cria versão (RN-AI-50).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `AI_GENERATION_READY` | solicitante | in-app | Sugestão `SUCCEEDED` (link `?ia=<id>`); definida em US-115 |
| `AI_GENERATION_FAILED` | solicitante | in-app | Geração `FAILED`; definida em US-115 |

## Critérios de aceite em Gherkin
```gherkin
Feature: Ajustar seção com IA

  Background:
    Given que o tenant "Prefeitura de São José" está ativo com "ai.enabled" verdadeiro e termos aceitos
    And o processo "0012/2026" tem um ETP em "DRAFT" com "NEED_DESCRIPTION" preenchida (400 caracteres, revisão 3) e "PROBLEM" vazia
    And "Carla" tem vínculo ativo com o perfil "PLANEJAMENTO", "AI_GENERATE", "ETP_UPDATE" e custódia do ETP
    And o provedor de IA de teste responde a "section.rewrite", "section.complete" e "section.summarize" com uma seção válida

  Scenario: [Sucesso] Reescrever uma seção e aplicar depois da comparação
    When "Carla" solicitar "REWRITE" para "NEED_DESCRIPTION"
    Then a API deve responder 202 com "Location" e a geração deve ter "kind" "SECTION" e "baseRevision" 3
    And deve gerar registro de auditoria "ai.generation_request" e o evento "AiGenerationRequested"
    When o worker concluir a geração
    Then a geração deve ficar "SUCCEEDED" e a seção do ETP deve continuar na revisão 3
    When "Carla" aplicar a sugestão com "confirmReplaceFilled" verdadeiro
    Then a API deve responder 200 com "versionCreated" nulo e a seção deve estar na revisão 4 com proveniência "ai" sem revisão
    And a geração deve ficar "APPLIED" e nenhuma "DocumentVersion" deve ser criada
    And deve gerar o evento "AiContentApplied" com "replacedFilledSections" 1 e o registro "ai.content_apply"

  Scenario: [Sucesso] Completar seção vazia, resumir e desfazer
    When "Carla" solicitar "COMPLETE" para "PROBLEM" e aplicar a sugestão
    Then a seção "PROBLEM" deve ficar "FILLED" e o evento "AiContentApplied" deve ter "replacedFilledSections" 0
    When "Carla" aplicar um "SUMMARIZE" de "NEED_DESCRIPTION" e acionar "Desfazer" no painel
    Then o texto anterior deve ser restaurado por "DOC-05" e a proveniência "ai" deve continuar com revisão pendente

  Scenario: [Sucesso] Ajustar seção nos quatro editores
    Given que existem DFD, ETP, Mapa de Riscos e TR em "DRAFT" com uma seção narrativa preenchida cada
    When "Carla", com a permissão de edição de cada tipo, solicitar "REWRITE" para "JUSTIFICATION" do DFD, "NEED_DESCRIPTION" do ETP, "INTRODUCTION" do Mapa de Riscos e "OBJECT" do TR
    Then as quatro gerações devem ficar "SUCCEEDED" com "targetModule" "DFD", "ETP", "RISK_MAP" e "TERM_OF_REFERENCE"

  Scenario: [Validação] Seção curta, sem narrativa ou valor inventado
    Given que a seção "OBJECTIVE" do ETP tem 20 caracteres
    When "Carla" solicitar "REWRITE" para "OBJECTIVE"
    Then a API deve responder 422 com código "AI_SECTION_EMPTY" e nenhuma geração deve ser criada
    When "Carla" solicitar "COMPLETE" para uma seção com "render" diferente de "TEXT" e "allowNarrative" falso
    Then a API deve responder 422 com código "AI_SECTION_NOT_SUPPORTED"
    Given que o provedor responde com "R$ 90.000,00" que não consta nas entradas
    Then a sugestão deve trazer "[a confirmar]" da categoria "VALUE" no lugar do valor e "groundingReplacements" 1

  Scenario: [Validação] Aplicar sem confirmar a substituição
    Given que há uma sugestão "SUCCEEDED" para "NEED_DESCRIPTION", que está preenchida
    When "Carla" aplicar sem "confirmReplaceFilled"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED"
    And a seção não deve ser alterada

  Scenario: [Permissão] Sem AI_GENERATE e solicitante diferente
    Given que "Bruno" tem "ETP_UPDATE" mas não tem "AI_GENERATE"
    When "Bruno" solicitar "REWRITE" para "NEED_DESCRIPTION"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar "access.denied"
    When "Marta", que tem "AI_GENERATE" e "ETP_UPDATE", aplicar a sugestão de "Carla"
    Then a API deve responder 403 com código "AI_GENERATION_NOT_OWNED"

  Scenario: [Tenant incorreto] Sugestão e documento de outro tenant
    Given que existe uma sugestão e um ETP no tenant "Prefeitura B"
    When "Carla" tentar aplicar essa sugestão ou pedir ajuste no ETP de "Prefeitura B"
    Then a API deve responder 404 com código "AI_GENERATION_NOT_FOUND" ou "NOT_FOUND"
    And o contexto enviado ao provedor de teste não deve conter dados de outro tenant

  Scenario: [Duplicidade] Reenvio da aplicação e ajuste ativo na mesma seção
    Given que "Carla" aplicou a sugestão com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o cabeçalho "Idempotent-Replayed: true" e a seção deve continuar na revisão 4
    Given que há um ajuste "RUNNING" para "NEED_DESCRIPTION"
    When "Carla" solicitar outro ajuste para a mesma seção
    Then a API deve responder 409 com código "AI_GENERATION_IN_PROGRESS" e "meta.generationId"
    And o pedido para a seção "PROBLEM" deve ser aceito com 202

  Scenario: [Concorrência] Seção editada depois do pedido
    Given que "Carla" solicitou "REWRITE" com "baseRevision" 3 e a sugestão está "SUCCEEDED"
    When "Bruno" editar "NEED_DESCRIPTION", levando-a à revisão 4, e "Carla" aplicar a sugestão
    Then a API deve responder 410 com código "AI_SUGGESTION_STALE" e a seção deve ficar como "Bruno" a deixou

  Scenario: [Falha de banco] Banco indisponível durante a aplicação
    Given que o banco fica indisponível durante a transação do "DOC-26"
    When "Carla" aplicar a sugestão
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a seção não deve ser alterada e a geração deve continuar "SUCCEEDED"

  Scenario: [Falha de integração] Provedor com erro, saída inválida ou circuito aberto
    Given que o provedor de teste responde 429 nas 3 tentativas
    When o worker processar o ajuste
    Then a geração deve ficar "FAILED" com "errorCode" "PROVIDER_RATE_LIMITED" e "AI_GENERATION_FAILED" deve ser enviada
    And a seção não deve ser alterada
    Given que o provedor responde com conteúdo fora do schema permitido, mesmo após o reparo
    Then a geração deve ficar "FAILED" com "errorCode" "OUTPUT_INVALID"
    Given que o circuito do provedor está aberto
    When "Carla" solicitar o ajuste
    Then a API deve responder 503 com código "AI_PROVIDER_UNAVAILABLE" e o cabeçalho "Retry-After"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Seção curta ou vazia | 422 | `AI_SECTION_EMPTY` | "A seção precisa de ao menos 50 caracteres." | Destaca "Completar" |
| Seção sem suporte | 422 | `AI_SECTION_NOT_SUPPORTED` | "Esta seção não pode ser ajustada com IA." | Oculta o menu |
| Sugestão desatualizada | 410 | `AI_SUGGESTION_STALE` | "A seção mudou desde o pedido. Gere o ajuste novamente." | "Gerar de novo" |
| Ajuste ativo na seção | 409 | `AI_GENERATION_IN_PROGRESS` | "Já há um ajuste em andamento nesta seção." | Abre o painel na geração |
| Sugestão não aplicável | 409 | `AI_GENERATION_NOT_APPLICABLE` | "Esta sugestão não pode mais ser aplicada." | Oferece novo pedido |
| Não é o solicitante | 403 | `AI_GENERATION_NOT_OWNED` | "Só quem pediu o ajuste pode aplicá-lo." | Oculta aplicar |
| Geração inexistente ou de outro tenant | 404 | `AI_GENERATION_NOT_FOUND` | "Sugestão não encontrada." | Fecha o painel |
| Provedor indisponível | 503 | `AI_PROVIDER_UNAVAILABLE` | "A IA está indisponível. Tente novamente em instantes." | Desabilita com `Retry-After` |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "O documento não pode ser editado no status atual." | Desabilita o menu |
| Confirmação ausente / corpo inválido | 422 | `VALIDATION_ERROR` | "Confirme a substituição depois de comparar." | Marca a comparação |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Menu oculto; API bloqueia |
| `If-Match` ausente / divergente | 428 / 412 | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` | "Atualize a página e tente novamente." | Recarrega e refaz a comparação |
| Desfazer sobre seção editada | 412 | `SECTION_REVISION_CONFLICT` | "A seção foi editada depois da aplicação." | Remove o "Desfazer" |
| Idempotência | 422 / 409 | `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_IN_PROGRESS` | "Esta solicitação já foi enviada." / "Estamos concluindo. Aguarde." | Nova chave / repete após 2 s |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente." | Mantém a comparação |
| Falha da geração (campo `errorCode`) | — | `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`, `TIMEOUT`, `CONTENT_FILTERED`, `CONTEXT_TOO_LARGE`, `OUTPUT_INVALID` | "Não foi possível gerar a sugestão." | Painel "falhou" com "Tentar novamente" |

## Dependências
- **Stories:** US-117 (fluxo genérico, painel SCR-117, `DOC-26`, SCR-007); US-020 (seções do ETP, SCR-008); US-035 (Mapa de Riscos emitido, SCR-011); US-036 (editor do TR, SCR-012). Indiretas: US-115 (camada de IA), US-116 (ativação e limites), US-122 (marcações, GroundingGuard, revisão `DOC-27`).
- **Decisões/ADRs:** DEC-017, DEC-037, DEC-079, DEC-140; ADR-013 (provedor, pendente — PEND-21).
- **Configurações:** `ai.enabled`, `ai.monthlyTokenLimit`, `ai.userDailyRequestLimit`, `AI_MODEL_SECTION`; `SectionDefinition` (`render`, `allowNarrative`, `maxChars`) do template fixado.
- **Lacunas nas fontes canônicas:**
  1. O "Desfazer" restaura o texto por `DOC-05`, que não restaura a proveniência `ai` anterior (RN-AI-55: editar não revisa); a seção desfeita fica "revisão pendente". Proposta: no MVP 1, manter o comportamento conservador e registrar em RN-AI-50; depois, aceitar o restabelecimento da proveniência anterior em `DOC-05`.
  2. *(Resolvida em api.md §2.2, 2026-10-16.)* Seção `NOT_APPLICABLE` → 422 `AI_SECTION_NOT_SUPPORTED`.
  3. RN-AI-48 não diz se o ajuste exige os antecessores da cadeia; adotado que não exige (usa os existentes). Propor nota em RN-AI-48.
  4. *(Resolvida, 2026-10-16.)* DOC-26 detalhado em `api/03-documents.md`: `If-Match` com a versão do documento (412 antes de 410 `AI_SUGGESTION_STALE`) e `versionCreated = null` para `SECTION`.

## Impacto técnico
- Sem entidade nem migração nova: usa `AiGeneration` (com `baseRevision`), `DraftContent.sections[key].ai` e `DOC-26`/`DOC-05` existentes.
- Sem `DocumentVersion`, a única recuperação do texto anterior é o "Desfazer" em memória; recarregar a página o perde. As versões formais (US-066) continuam as de sempre.
- O `AiSuggestionSource` lê a sugestão e marca `APPLIED` na mesma transação da seção; a checagem de `baseRevision` é feita nela, junto do bloqueio da seção.
- Concorrência: único parcial `(tenant_id, document_id, section_key)` para ajuste ativo; autosave concorrente invalida a sugestão por `baseRevision`, não por `If-Match`.

## Backend
- **Módulo(s):** `ai` (geradores `section.rewrite`/`complete`/`summarize`), `document` (`DOC-26`, `DOC-05`), com fachadas de leitura de `dfd`, `etp`, `risk`, `term`, `process`.
- **Casos de uso:** `RequestAiGenerationCommand` (US-115), `GenerateSectionAdjustmentHandler` (worker), `ApplyAiSectionCommand` (`document`).
- **Domínio:** `AiGeneration` (`baseRevision`), `Document.replaceSectionFromAi(...)` (revisão, proveniência nova, `state = FILLED`), regras de elegibilidade da seção.
- **Integrações internas:** `AiSuggestionSource`, `AuthorizationService.assertCan(<permissão do tipo>, { processId })`, `DocumentTemplateFacade` (`SectionDefinition`), `OutboxWriter`.
- **Transação:** `DOC-26` = validações e `baseRevision` → substituir a seção → `markApplied` → auditoria → outbox, em uma só transação com `app.tenant_id`; nenhuma chamada de IA dentro dela.

## Frontend
- **Tela(s):** SCR-007 (`/processos/[id]/dfd/[dfdId]`), SCR-008 (`/processos/[id]/etp/[etpId]`), SCR-011 (`/processos/[id]/riscos`, seções do `RISK_MAP`) e SCR-012 (`/processos/[id]/tr/[termId]`), com o painel SCR-117.
- **Componentes:** `AiSectionMenu`, `AiAssistantPanel`, `AiRequestForm` (ação e orientação), `AiGenerationProgress`, `AiSectionDiffView`, botão "Desfazer" do painel, `AiGeneratedBadge`, `AiDisclaimer`.
- **Estados:** formulário, gerando (skeleton), comparação pronta, aplicada com "Desfazer", falhou, obsoleta, expirada.
- **Acessibilidade e responsividade:** menu acionável por teclado; diferenças anunciadas por `aria-live`; foco no painel ao abrir e no "Desfazer" ao aplicar; em telas < 768 px a comparação vira abas "Atual" / "Sugerido".

## Banco de dados
- **Tabelas:** `ai_generations` (`baseRevision`, status), `documents` (`draftContent`, `draftRevision`), `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma nesta story — `baseRevision` e as proveniências vêm da camada de IA (US-115) e do modelo de US-122.
- **Índices/constraints relevantes:** único parcial de ajuste ativo por (documento, `sectionKey`); check de `SECTION` (`action`, `section_key`, `document_id` não nulos).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `AI-01` | POST | `/processes/{id}/ai-generations` | `{ targetModule, documentId, kind: 'SECTION', action, sectionKey, instruction? }` + `Idempotency-Key` | `202 { data: AiGeneration (baseRevision), meta: { pollAfterMs } }` | 202, 403, 404, 409, 422, 429, 503 |
| `AI-02` | GET | `/ai-generations/{generationId}` | — | `200` com `output.sections[0]` e `warnings` | 200, 403, 404 |
| `AI-04` | POST | `/ai-generations/{generationId}/discard` | — | `200` | 200, 403, 404, 409 |
| `AI-05` | GET | `/ai/availability?processId=&documentId=` | — | `200 { canGenerate, reasons[] }` | 200 |
| `DOC-26` | POST | `/documents/{id}/ai-apply` | `{ generationId, sectionKeys: [sectionKey], confirmReplaceFilled: true }` + `If-Match` + `Idempotency-Key` | `200 { data: { document, appliedSectionKeys, versionCreated: null } }` | 200, 403, 404, 409, 410, 412, 422, 428, 503 |
| `DOC-05` | PUT | `/documents/{id}/sections/{sectionKey}` | `{ content, state }` + `If-Match: "s<revision>"` (usado em "Desfazer") | `200 { data: { sectionKey, revision, … } }` | 200, 403, 409, 412, 422 |

## Logs
- `info` `ai.section_adjust_applied` — `generationId`, `targetModule`, `sectionKey`, `action`, `durationMs`.
- `warn` `ai.section_adjust_stale` — recusa por `baseRevision`; `warn` `idempotency.store_unavailable`.
- `error` `ai.section_adjust_apply_failed` — `errorCode`, `correlationId`.
- Nunca logar: texto da seção, orientação, contexto, sugestão ou saída do modelo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `ai.generation_request` | `DATA_CHANGE` | `AI-01` | `generationId`, `targetModule`, `kind`, `action`, `sectionKey`, `promptKey`, `promptVersion` |
| `ai.content_apply` | `DATA_CHANGE` | Commit de `DOC-26` | `generationId`, `sectionKeys`, `replacedFilledSections`; sem conteúdo |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = AI_GENERATE` ou a permissão de edição |

## Testes necessários
- **Unitários:** elegibilidade da seção (50 caracteres, narrativa, `NOT_APPLICABLE`); montagem do contexto por ação; prompts por `promptKey`/`promptVersion`; GroundingGuard com texto atual como fato; preservação de "[a confirmar]".
- **Integração (Testcontainers PostgreSQL + Redis):** `DOC-26` atômico com `baseRevision`; proveniência nova e `revision`/`draftRevision`; ausência de `DocumentVersion`; worker com `FakeAiProvider` (sucesso, 429, saída inválida); RLS.
- **API/contrato:** `AI-01` (`SECTION`) e `DOC-26` conforme api.md; `Idempotency-Key`/`Idempotent-Replayed`; `If-Match`.
- **RBAC e multi-tenant:** `AI_GENERATE` + permissão de edição por tipo; POL-02; solicitante único; teste novo na suíte `test/tenant-leak` (sugestão e contexto de outro tenant).
- **Concorrência:** autosave durante a geração (410); `If-Match` divergente (412); ajuste ativo por seção.
- **E2E (Playwright):** reescrever, completar e resumir nos quatro editores, com comparação, aplicar e "Desfazer"; seção revisada voltando a "revisão pendente".
- **Acessibilidade/performance:** axe no menu, no painel e na comparação; meta p95 do ajuste ≤ 20 s na suíte de performance.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI do lote
- [ ] `AI_GENERATE`, permissões de edição por tipo, POL-18 e POL-02 aplicados na API; menu oculto/desabilitado na UI
- [ ] Aplicação atômica com `baseRevision` comprovada por teste de falha induzida e de concorrência
- [ ] Auditoria, eventos e timeline verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `AI-01` (`SECTION`) e `DOC-26` compatível com api.md; lacunas 1 a 4 resolvidas nas fontes
- [ ] Logs sem conteúdo; métricas `cf_ai_*` e trace presentes
- [ ] Menu, painel e comparação acessíveis (axe) e responsivos (360 px)
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reaproveita a camada de IA (US-115), o painel e a aplicação genérica (US-117) e as marcações (US-122); a complexidade está na elegibilidade por seção, na checagem de `baseRevision`, na comparação lado a lado e no "Desfazer" nos quatro editores, sem entidade nem migração nova.

## Prioridade
**P1** — o ajuste por seção é o uso mais frequente da IA no dia a dia da redação e completa o rascunho completo (FT-061) com revisão humana obrigatória (princípio 16).

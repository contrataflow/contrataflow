---
id: US-122
title: "Marcar conteúdo gerado por IA e pendências \"[a confirmar]\" e exigir revisão humana"
epic: EP-020
feature: FT-062
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-065, US-067, US-115]
modules: [ai, document, dfd, etp, risk, term, access, timeline, audit, platform]
screens: [SCR-117, SCR-007, SCR-008, SCR-011, SCR-012]
endpoints: [DOC-27, DOC-05, DOC-08, DOC-09, DOC-10, DOC-20, PRC-19, AI-02]
permissions: [DFD_UPDATE, ETP_UPDATE, RISK_MANAGE, TERM_UPDATE, PROCESS_VIEW]
events: [AiContentReviewed]
---

# US-122 — Marcar conteúdo gerado por IA e pendências "[a confirmar]" e exigir revisão humana

## Título
Marcar conteúdo gerado por IA e pendências "[a confirmar]" e exigir revisão humana

## Descrição
**Como** redator do documento de planejamento (`PLANEJAMENTO` ou `REQUISITANTE`), **quero** que todo texto produzido por IA e toda informação ainda não confirmada fiquem visivelmente marcados no editor e nas prévias, e que o documento só possa ser finalizado, submetido ou encaminhado depois que eu revisar cada seção e resolver cada pendência, **para** assumir a autoria do conteúdo com segurança, sem que nenhum valor, prazo ou quantidade inventado chegue ao documento oficial.

A story entrega as três travas do princípio 16 (a IA nunca aprova, encaminha, publica nem decide): (1) o nó `toConfirm` ("[a confirmar: …]") no editor e no validador do backend, com o **GroundingGuard** que troca por `toConfirm` qualquer valor, quantidade, prazo, data ou percentual que não exista nas entradas; (2) a **proveniência por seção** (`DraftContent.sections[key].ai`) e a ação humana de revisão (DOC-27, por seção ou "Revisar todas"); (3) as violações **bloqueantes** `SECTION_AI_REVIEW_PENDING` e `SECTION_PLACEHOLDER_PENDING` na completude (DOC-08), que fazem finalizar, submeter e encaminhar responderem `DOCUMENT_INCOMPLETE`. A prévia em PDF (DOC-20) deixa as marcas à vista.

## Contexto
- O rascunho gerado por IA (DEC-037) só é útil se o órgão puder confiar que nada foi decidido pela máquina: as quantidades, valores, prazos e dados vêm do processo; o que faltar sai como "[a confirmar]". A fase preparatória (Lei 14.133/2021, art. 18) é responsabilidade dos agentes públicos designados — por isso a revisão é ato humano explícito e rastreável.
- DEC-079 define o módulo `ai` (nível 5) e a regra de que a aplicação é comando do módulo dono (`document`); a proveniência vive no `draftContent` do `document` (DEC-017) e não obriga `document` a importar `ai`.
- DEC-056 fixa o schema TipTap permitido em `packages/editor` e a validação no backend; o nó `toConfirm` entra nesse schema. A saída do provedor já é validada por Zod e convertida para TipTap (RN-AI-07, US-115); o GroundingGuard é plugado no gancho de pós-processamento dessa pipeline.
- US-065 (DOC-08/09/10) e US-067 (DOC-20) são os pontos de extensão da completude e da prévia. US-117..US-121 aplicam conteúdo (DOC-26) e gravam a proveniência; US-119 trata a revisão de riscos (RSK-12) e as violações `RISK_*`.
- O padrão de autosave com revisão por seção é o de US-015/DEC-182 (DOC-05); DEC-184 exige pt-BR claro nas mensagens.

## Objetivo
Garantir que 100% do conteúdo gerado por IA aplicado a um documento nasça marcado "revisão pendente", que nenhuma versão finalizada ou submetida contenha seção não revisada ou marcação "[a confirmar]", e que nenhum número, valor, prazo, data ou percentual ausente das entradas sobreviva ao pós-processamento sem marcação.

## Persona
- **Principal:** Redator do documento — Planejamento (`PLANEJAMENTO`) ou Área requisitante (`REQUISITANTE`).
- **Secundárias:** Compras (`COMPRAS`), Gestor de contratações (`GESTOR_CONTRATACOES`), Gestor de contrato (`GESTOR_CONTRATO`); Consultoria externa (`CONSULTOR_EXTERNO`) como participante `COLLABORATOR`/`CONSULTANT` com permissão de edição do tipo; aprovadores, que veem as marcas na prévia.

## Pré-condições
- Documento DFD, ETP, TR ou mapa de riscos em `DRAFT`/`RETURNED`, com tipo permitido na etapa e processo editável (POL-02).
- Para revisar: usuário com a permissão de edição do tipo (`DFD_UPDATE`, `ETP_UPDATE`, `RISK_MANAGE` ou `TERM_UPDATE`) cobrindo o processo. `AI_GENERATE` **não** é necessária.
- Para haver proveniência: conteúdo aplicado de uma geração `APPLIED` (US-117..US-121). As marcações `toConfirm` também podem ser inseridas manualmente em qualquer documento.

## Fluxo principal
1. Na geração (worker `ai-generation`, US-115), depois da validação de schema e antes de gravar `output`, o GroundingGuard varre o texto de cada seção, troca por `toConfirm` o que não consta no conjunto de fatos das entradas e grava `placeholdersCount` e `groundingReplacements` por seção e na geração.
2. O redator aplica a proposta (DOC-26, US-117): cada seção aplicada recebe `ai = { generationId, appliedAt, appliedById, reviewedAt: null, reviewedById: null }`.
3. No editor (SCR-007/008/011/012), a seção exibe `AiGeneratedBadge` "Gerado por IA · revisão pendente" (com a contagem de pendências) e cada `toConfirm` aparece como `ToConfirmChip` "[a confirmar: {label}]" em destaque. O painel SCR-117 mostra o `AiDisclaimer`.
4. O redator edita o texto; o autosave (DOC-05) grava o conteúdo **sem** alterar a proveniência. Para resolver uma pendência, aciona o chip → "Substituir pelo dado": o nó é removido e o cursor fica no ponto para digitar o dado.
5. Para registrar uma dúvida própria, usa "Marcar como a confirmar", informa a descrição (1..120) e a categoria; o nó é criado com `origin = USER`.
6. Concluída a leitura da seção, aciona `MarkReviewedButton` ("Marcar seção como revisada"); o front envia DOC-27 com `sectionKeys` e `expectedRevisions`.
7. A API valida permissão e POL-02, confere as revisões, grava `reviewedAt`/`reviewedById`, incrementa `revision` da seção e `draftRevision`, audita `ai.content_review` e publica `AiContentReviewed` na mesma transação; responde 200 com o documento e `reviewedSectionKeys`.
8. Havendo duas ou mais seções pendentes, "Revisar todas" abre o `ReviewAllDialog` ("Li e revisei as N seções"); ao confirmar, o front envia DOC-27 com `confirmAll: true`.
9. O painel de validação (DOC-08) lista `SECTION_AI_REVIEW_PENDING` e `SECTION_PLACEHOLDER_PENDING` com link para a seção; "Finalizar", "Enviar para aprovação" e "Encaminhar" ficam desabilitados com a explicação, e a API recusa com 422 `DOCUMENT_INCOMPLETE` se forem chamados.
10. A prévia em PDF (DOC-20) mostra, no topo da seção ainda não revisada, "Conteúdo gerado por IA — revisão pendente" e os `toConfirm` destacados. Resolvidas todas as pendências, o documento segue por ação humana; a IA nunca muda status.

## Fluxos alternativos
- **FA-01 — Edição não revisa:** alterar o texto de uma seção gerada por IA mantém `reviewedAt = null`; só DOC-27 revisa.
- **FA-02 — Nova aplicação de IA:** reaplicar IA (US-117/US-121) sobre seção já revisada troca `generationId` e zera `reviewedAt`/`reviewedById`; a seção volta a "revisão pendente".
- **FA-03 — Pendências independentes:** resolver todos os `toConfirm` não revisa a seção, e revisar a seção não resolve os `toConfirm`; cada condição gera sua violação.
- **FA-04 — Seção esvaziada ou "Não se aplica":** DOC-05 que esvazia a seção ou a marca como não aplicável grava `ai = null` (não há mais conteúdo gerado).
- **FA-05 — IA desligada depois da aplicação:** com `ai.enabled = false` (US-116) ou sem `AI_GENERATE`, a revisão continua possível, pois usa a permissão de edição do tipo.
- **FA-06 — Revisão por outra pessoa:** quem revisa não precisa ser o solicitante da geração; `reviewedById` registra quem leu.
- **FA-07 — Lote com seção já revisada:** seções sem proveniência pendente são ignoradas e ficam fora de `reviewedSectionKeys`.

## Regras de negócio
- **RN-AI-53** — Marcação `[a confirmar]` = nó inline `toConfirm` de `packages/editor` (`label` 1..120, `category` `QUANTITY|VALUE|DEADLINE|DATE|DATA|DECISION|OTHER`, `origin` `AI|USER`), exibido em destaque como "[a confirmar: {label}]" no editor e nas prévias em PDF; o redator resolve substituindo pelo dado (remove o nó) e pode inserir manualmente ("Marcar como a confirmar", `origin = USER`). O schema do editor e o validador do backend (DEC-056) aceitam o nó e rejeitam atributos fora do contrato; o texto literal "[a confirmar: …]" que o provedor devolver fora de nó é convertido em `toConfirm` antes da gravação.
- **RN-AI-54** — GroundingGuard (determinístico, sem chamada externa, aplicado à saída antes de gravar): todo valor monetário, quantidade com unidade, prazo/duração, data e percentual do texto gerado precisa existir no conjunto de fatos das entradas (normalizado: valores em centavos, durações em dias/meses, datas em ISO, algarismos e numerais por extenso comuns); o que não existir é trocado por `toConfirm` da categoria correspondente (monetário → `VALUE`, quantidade → `QUANTITY`, prazo → `DEADLINE`, data → `DATE`, percentual → `VALUE`) e contado em `groundingReplacements`. Exceções: citações legais (lei, artigo, parágrafo, inciso, alínea), numeração de listas e anos presentes nas entradas. O guard é idempotente; se falhar, a geração termina `FAILED`/`OUTPUT_INVALID` sem gravar `output` (falha fechada).
- **RN-AI-55** — Proveniência por seção (`DraftContent.sections[key].ai`): a seção fica "Gerado por IA — revisão pendente" enquanto `reviewedAt` for nulo; editar o texto não a marca como revisada; nova aplicação de IA zera a revisão. A proveniência vai para o snapshot das versões e não é impressa no PDF final.
- **RN-AI-56** — Revisão (DOC-27) é ação humana explícita, por seção ou em lote ("Revisar todas", com `confirmAll: true` após a confirmação "Li e revisei as N seções" — obrigatório quando `sectionKeys` tem 2 ou mais chaves), com permissão de edição do tipo + POL-02 e `expectedRevisions` por seção (divergente → 412 `VERSION_CONFLICT`); efeitos: `reviewedAt/By`, `revision + 1`, auditoria `ai.content_review`, `AiContentReviewed` → timeline `AI_CONTENT_REVIEWED`. Seção sem proveniência pendente é ignorada (idempotente), sem checar a revisão esperada.
- **RN-AI-57** — Completude (DOC-08): `SECTION_AI_REVIEW_PENDING` (proveniência sem revisão) e `SECTION_PLACEHOLDER_PENDING` (seção com `toConfirm`, `params.count`) são violações **bloqueantes**, avaliadas em todo tipo de documento; finalizar, submeter ou encaminhar com elas → 422 `DOCUMENT_INCOMPLETE` (fluxos de US-016, US-023, US-035, US-039 inalterados). A IA nunca muda status, encaminha nem aprova (princípio 16).
- **RN-AI-58** — Prévia em PDF (DOC-20) com conteúdo de IA não revisado mostra no topo da seção a nota "Conteúdo gerado por IA — revisão pendente" e os `toConfirm` destacados; versões finais nunca têm essas marcas (bloqueio da RN-AI-57).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Descrição da pendência | `toConfirm.attrs.label` | texto | Sim | 1..120 caracteres | gerada pela IA/guard ou digitada |
| Categoria | `toConfirm.attrs.category` | lista | Sim | `QUANTITY`, `VALUE`, `DEADLINE`, `DATE`, `DATA`, `DECISION`, `OTHER` | `OTHER` na inserção manual |
| *(sistema)* Origem da marcação | `toConfirm.attrs.origin` | `AI` \| `USER` | Sim | `USER` na inserção manual | — |
| Seções a revisar | `sectionKeys` | lista de chaves | Sim | 1..N chaves do documento | seção em foco, ou todas as pendentes |
| *(sistema)* Revisões esperadas | `expectedRevisions` | mapa chave → inteiro | Sim | uma entrada por chave | `revision` lida pelo editor |
| Li e revisei as N seções | `confirmAll` | booleano | Condicional | obrigatório se `sectionKeys` tem 2+ chaves | `false` |
| *(sistema)* Proveniência | `sections[key].ai` | objeto \| nulo | — | `generationId`, `appliedAt/ById`, `reviewedAt/ById` | gravado na aplicação (US-117..US-121) |
| *(sistema)* Contagens da geração | `placeholdersCount`, `groundingReplacements` | inteiros | — | por seção e total (AI-02) | calculados pelo guard |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `sectionKeys` vazio ou chave inexistente no documento | Front + API (Zod) | "Selecione ao menos uma seção do documento." | `VALIDATION_ERROR` |
| V-02 | `expectedRevisions` sem entrada para alguma chave | API (Zod) | "Recarregue o documento e tente de novo." | `VALIDATION_ERROR` |
| V-03 | Lote (2+ seções) sem `confirmAll` | Front + API | "Confirme que leu e revisou as seções." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-04 | Revisão da seção diferente da esperada | API | "A seção foi alterada. Leia a versão atual antes de revisar." | `VERSION_CONFLICT` |
| V-05 | `toConfirm` com `label` fora de 1..120, `category` ou `origin` inválidos | Front + API (Zod, DEC-056) | "Descreva o que falta confirmar (até 120 caracteres)." | `VALIDATION_ERROR` |
| V-06 | Documento não está em `DRAFT`/`RETURNED` | API | "O documento não pode ser editado no status atual." | `DOCUMENT_NOT_EDITABLE` |
| V-07 | Tipo do documento não permitido na etapa | API | "O documento não pode ser editado nesta etapa do processo." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-08 | Finalizar/submeter/encaminhar com seção não revisada ou com `toConfirm` | API | "Revise o conteúdo gerado por IA e resolva os itens [a confirmar]." | `DOCUMENT_INCOMPLETE` (`SECTION_AI_REVIEW_PENDING`, `SECTION_PLACEHOLDER_PENDING`) |
| V-09 | Saída do provedor com `toConfirm` inválido ou guard com falha | Worker | "Não foi possível gerar o conteúdo. Tente novamente." | `OUTPUT_INVALID` (campo `errorCode` da geração) |

## Permissões
- **Permissão:** a de edição do tipo do documento (`DFD_UPDATE`, `ETP_UPDATE`, `RISK_MANAGE` para o mapa de riscos, `TERM_UPDATE`) cobrindo o processo; `PROCESS_VIEW` para ler DOC-08/DOC-20. `AI_GENERATE` não é exigida para revisar.
- **Políticas:** POL-02 (custódia ou participação `COLLABORATOR`/`CONSULTANT` + documento `DRAFT`/`RETURNED` + tipo permitido na etapa + processo editável).
- **MFA:** não exigido (permissões de risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** `MarkReviewedButton`, "Revisar todas" e "Marcar como a confirmar" não são exibidos; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `AiContentReviewed` | `document.ai_content_reviewed.<type>` (`dfd`, `etp`, `risk_map`, `tr`) | Commit de DOC-27, só se ao menos uma seção foi revisada | `documentId`, `targetModule`, `sectionKeys[]`, `riskIds[]` (vazio aqui), `generationIds[]`; sem conteúdo; projeta `AI_CONTENT_REVIEWED` na timeline |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: apenas a entrada `AI_CONTENT_REVIEWED` na timeline. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Marcar conteúdo gerado por IA e exigir revisão humana

  Background:
    Given que o tenant "Prefeitura de São José" está ativo com a IA ligada
    And o processo "0012/2026" tem o DFD "DFD 0005/2026" em "DRAFT"
    And "Carla" tem vínculo ativo com o perfil "PLANEJAMENTO" e custódia do processo
    And o provedor de IA de teste (FakeAiProvider) está disponível

  Scenario: [Sucesso] Revisar uma seção gerada por IA
    Given que "JUSTIFICATION" tem conteúdo da geração "G1" na revisão 4 e "reviewedAt" nulo
    When "Carla" marcar "JUSTIFICATION" como revisada com expectedRevisions { "JUSTIFICATION": 4 }
    Then a API deve responder 200 com "reviewedSectionKeys" igual a ["JUSTIFICATION"]
    And a seção deve ter "reviewedAt" preenchido, "reviewedById" de "Carla" e revisão 5
    And deve gerar registro de auditoria "ai.content_review"
    And deve gerar o evento "AiContentReviewed" com "generationIds" igual a ["G1"]
    And a timeline deve exibir "AI_CONTENT_REVIEWED"

  Scenario: [Sucesso] Revisar todas as seções em lote
    Given que "JUSTIFICATION" e "EXPECTED_RESULTS" têm revisão pendente
    When "Carla" confirmar "Revisar todas" com "confirmAll" igual a true
    Then a API deve responder 200 com as duas chaves em "reviewedSectionKeys"
    And deve existir um único evento "AiContentReviewed" com 2 chaves em "sectionKeys"

  Scenario: [Sucesso] GroundingGuard troca fatos não sustentados por "[a confirmar]"
    Given que as entradas do processo trazem 120 unidades e o ano 2026, sem valor estimado nem prazo
    And o provedor de IA de teste responde com "R$ 80.000,00", "90 dias", "120 unidades" e "art. 18, § 1º"
    When a geração for concluída
    Then o texto deve conter dois nós "toConfirm" das categorias "VALUE" e "DEADLINE"
    And "120 unidades" e "art. 18, § 1º" devem permanecer no texto
    And a geração deve ter "groundingReplacements" igual a 2 e "placeholdersCount" igual a 2

  Scenario: [Sucesso] Editar o texto não revisa e nova aplicação zera a revisão
    Given que "Carla" revisou "JUSTIFICATION" gerada por IA
    When "Carla" aplicar uma nova geração "G2" em "JUSTIFICATION"
    Then a seção deve ter "generationId" igual a "G2" e "reviewedAt" nulo
    When "Carla" editar o texto da seção
    Then "reviewedAt" deve continuar nulo

  Scenario: [Sucesso] Documento sem pendências pode ser finalizado e a prévia mostra as marcas antes disso
    Given que "EXPECTED_RESULTS" tem revisão pendente e um "toConfirm"
    When "Carla" gerar a prévia em PDF
    Then a seção deve exibir "Conteúdo gerado por IA — revisão pendente" e o texto "[a confirmar: prazo]" destacado
    When "Carla" resolver a pendência, revisar a seção e finalizar o documento
    Then a API deve responder 200 e a versão finalizada não deve ter nota nem "toConfirm"

  Scenario: [Validação] Finalizar com pendências
    Given que "JUSTIFICATION" tem revisão pendente e "EXPECTED_RESULTS" tem 2 "toConfirm"
    When "Carla" finalizar o DFD
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE"
    And as violações devem incluir "SECTION_AI_REVIEW_PENDING" para "JUSTIFICATION" e "SECTION_PLACEHOLDER_PENDING" com "params.count" igual a 2 para "EXPECTED_RESULTS"
    And o status do DFD deve continuar "DRAFT"

  Scenario: [Validação] Lote sem confirmação e marcação inválida
    When "Carla" enviar DOC-27 com 2 chaves e sem "confirmAll"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" no campo "confirmAll"
    When "Carla" gravar uma seção com "toConfirm" de "label" vazio
    Then a API deve responder 422 com código "VALIDATION_ERROR"

  Scenario: [Permissão] Usuário sem permissão de edição do DFD
    Given que "Bruno" não possui "DFD_UPDATE" para o processo
    When "Bruno" enviar DOC-27 para "JUSTIFICATION"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    Given que "Marta" tem "DFD_UPDATE" e custódia, mas não tem "AI_GENERATE"
    When "Marta" marcar "JUSTIFICATION" como revisada
    Then a API deve responder 200

  Scenario: [Tenant incorreto] Documento de outro tenant
    Given que existe um DFD no tenant "Prefeitura B" com seção pendente
    When "Carla", no tenant "Prefeitura de São José", enviar DOC-27 para esse DFD
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Revisão repetida da mesma seção
    Given que "Carla" revisou "JUSTIFICATION" e recebeu 200
    When a mesma requisição for reenviada
    Then a API deve responder 200 com "reviewedSectionKeys" vazio
    And não deve haver novo evento "AiContentReviewed" nem nova auditoria "ai.content_review"

  Scenario: [Concorrência] Seção alterada entre a leitura e a revisão
    Given que "Carla" carregou "JUSTIFICATION" na revisão 4
    When outro usuário salvar a seção, gerando a revisão 5
    And "Carla" enviar DOC-27 com expectedRevisions { "JUSTIFICATION": 4 }
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And a seção deve continuar com revisão pendente

  Scenario: [Falha de banco] Banco indisponível durante a revisão
    Given que o banco de dados fica indisponível durante a transação de DOC-27
    When "Carla" marcar "JUSTIFICATION" como revisada
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a seção deve continuar com revisão pendente e nenhum evento deve ser gravado

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Carla" revisar "JUSTIFICATION" com sucesso
    Then a API deve responder 200
    And o evento "AiContentReviewed" deve permanecer "PENDING" no outbox até o relay voltar

  Scenario: [Falha de integração] Provedor devolve marcação inválida
    Given que o provedor de IA de teste responde com um "toConfirm" de categoria "XYZ"
    When o worker processar a geração
    Then a geração deve terminar "FAILED" com "errorCode" igual a "OUTPUT_INVALID" após a tentativa de reparo
    And nenhum "output" deve ser gravado
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido / lote sem confirmação | 422 | `VALIDATION_ERROR` | "Revise a seleção das seções." | Marca o campo; mantém o diálogo aberto |
| Documento incompleto (pendências de IA) | 422 | `DOCUMENT_INCOMPLETE` | "Revise o conteúdo gerado por IA e resolva os itens [a confirmar]." | Lista as violações com link para a seção |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "O documento não pode ser editado no status atual." | Oculta as ações de revisão |
| Tipo fora da etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O documento não pode ser editado nesta etapa do processo." | Oculta as ações de revisão |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para editar este documento." | Botões ocultos; API bloqueia |
| Documento inexistente ou de outro tenant | 404 | `NOT_FOUND` | "Documento não encontrado." | Volta à lista de documentos |
| Seção alterada desde a leitura | 412 | `VERSION_CONFLICT` | "A seção foi alterada. Leia a versão atual antes de revisar." | Recarrega a seção e mantém a revisão pendente |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível registrar a revisão agora. Tente novamente em instantes." | Mantém a tela; botão "Tentar novamente" |

## Dependências
- **Stories:** US-065 (ciclo de vida, DOC-08/09/10 e regras de completude), US-067 (prévia DOC-20), US-115 (pipeline com gancho de pós-processamento e `AiGeneration`). Indiretas: US-015 (editor e autosave DOC-05), US-016/US-023/US-035/US-039 (finalizar/encaminhar herdam a barreira). Habilita: US-117..US-121 (gravam a proveniência) e US-119 (RSK-12 e `RISK_*`).
- **Decisões/ADRs:** DEC-017, DEC-018, DEC-037, DEC-056, DEC-079, DEC-182, DEC-184; ADR-006.
- **Configurações:** nenhuma nova (`ai.enabled` não condiciona a revisão — FA-05).
- **Lacunas nas fontes canônicas:**
  1. *(Resolvida em entities.md §5.10, 2026-10-16.)* Duplicar DFD (DFD-05) e importar do ETP (TRM-06) levam a proveniência pendente e os `toConfirm`; conteúdo já revisado na origem chega sem pendência. Implementar nas US-018/US-037 quando forem tocadas, ou aqui se já existirem.
  2. *(Resolvida em entities.md §5.10.)* Salvar a seção vazia ou `NOT_APPLICABLE` (DOC-05) limpa `ai`.
  3. *(Resolvida em entities.md §5.10.)* Percentual e valor monetário → `VALUE`; rótulos padrão por categoria registrados.

## Impacto técnico
- O guard roda no pós-processamento da US-115, depois do reparo de schema (RN-AI-07) e **antes** da checagem de `maxChars`, pois a troca por `toConfirm` altera o tamanho; precisa ser puro e idempotente para ser reexecutável no retry do job.
- O conjunto de fatos vem do contexto já sanitizado (RN-AI-05) e não é persistido: só `contextHash` e `inputRefs` ficam na geração.
- Compatibilidade: `ai` é campo opcional de `draftContentSchema` e do snapshot (`schemaVersion` 1 mantido); documentos antigos leem `ai` como ausente. O reconhecedor de nó novo exige atualizar o schema em `packages/editor`, o validador do backend e o renderizador de HTML do PDF na mesma entrega.
- `document` não importa `ai` (regra D9 e dependency-cruiser): a completude lê apenas o `draftContent`.
- Performance: a varredura de `toConfirm` e `ai` em DOC-08 é em memória sobre o `draftContent` já carregado; sem índice novo.

## Backend
- **Módulo(s):** `document` (DOC-27, proveniência, regras de completude), `ai` (GroundingGuard), `timeline` (projetor síncrono), `audit`, `platform` (`OutboxWriter`); schemas em `packages/editor` e `packages/types`.
- **Casos de uso:** `ReviewAiContentCommand` → `ReviewAiContentHandler`; `GroundingGuard.apply(output, factSet)` (serviço de domínio do `ai`, gancho de pós-processamento); regras `SectionAiReviewPendingRule` e `SectionPlaceholderPendingRule` no conjunto de completude do `document`.
- **Domínio:** `Document.reviewAiSections(keys, expectedRevisions, actor)`; `FactSet` e `FactNormalizer` (valores, quantidades, durações, datas, percentuais); `SectionAiProvenance` (value object); nó `toConfirm`.
- **Integrações internas:** `AuthorizationService.assertCan(<permissão de edição do tipo>, { processId })`; `DocumentRenderer` (HTML da prévia, US-067) para a nota e os chips.
- **Transação:** em uma transação com `app.tenant_id`: bloqueio do documento → conferência de `expectedRevisions` das seções pendentes → gravação de `ai.reviewedAt/By`, `revision + 1` e `draftRevision + 1` → auditoria → outbox → projeção síncrona na timeline → commit.

## Frontend
- **Tela(s):** SCR-007 (`/processos/[id]/dfd/[dfdId]`), SCR-008 (`/processos/[id]/etp/[etpId]`), SCR-011 (`/processos/[id]/riscos`), SCR-012 (`/processos/[id]/tr/[termId]`); painel SCR-117.
- **Componentes:** `AiGeneratedBadge` (pendente: "Gerado por IA · revisão pendente"; revisada: "Gerado por IA · revisada por {nome} em {data}"), `MarkReviewedButton`, `ReviewAllDialog`, `ToConfirmChip` (nó do editor com popover "Substituir pelo dado", "Editar descrição", "Remover marcação"), ação "Marcar como a confirmar" no menu do editor; painel de validação com links para as seções.
- **Estados:** loading (skeleton da seção); sem pendências (badge de revisada ou ausente); pendente; erro de conflito (recarrega a seção); sucesso (toast "Seção marcada como revisada").
- **Acessibilidade e responsividade:** estado comunicado por texto e ícone, nunca só por cor, com contraste mínimo de 4,5:1 nos temas claro e escuro; `ToConfirmChip` focável por teclado com `aria-label` "Pendência a confirmar: {label}"; resultado da revisão anunciado por `aria-live`; `ReviewAllDialog` com foco preso e tela cheia abaixo de 768 px.

## Banco de dados
- **Tabelas:** `documents` (`draft_content` jsonb e `draft_revision`), `document_versions` (snapshot com `ai`), `audit_logs`, `outbox_events`; `ai_generations` apenas lida (`placeholders_count`, `grounding_replacements`).
- **Migrações:** nenhuma — a mudança está nos schemas JSON (`draftContentSchema`, `documentSnapshotSchema`, nó `toConfirm`).
- **Índices/constraints relevantes:** nenhum novo; a concorrência por seção usa `revision` dentro do `draft_content`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `DOC-27` | POST | `/documents/{id}/ai-review` | `{ sectionKeys: string[], expectedRevisions: Record<string, number>, confirmAll?: boolean }` | `200 { data: { document, reviewedSectionKeys } }` | 200, 401, 403, 404, 409, 412, 422, 503 |
| `DOC-05` | PUT | `/documents/{id}/sections/{sectionKey}` | conteúdo TipTap (aceita `toConfirm`); `If-Match: "s<revision>"` | seção com `ai` preservado | 200, 403, 404, 409, 412, 422 |
| `DOC-08` | GET | `/documents/{id}/validation` | — | `violations[]` com as duas violações novas | 200, 403, 404 |
| `DOC-09` / `DOC-10` | POST | `/documents/{id}/submit` · `/documents/{id}/finalize` | como em US-065 | — | 422 `DOCUMENT_INCOMPLETE` com as violações |
| `PRC-19` | POST | `/processes/{id}/forward` | como em US-016 | — | 422 `DOCUMENT_INCOMPLETE` |
| `DOC-20` | POST | `/documents/{id}/preview` | `{}` | `202` com a rendição; PDF com nota e destaques | 202, 403, 404 |
| `AI-02` | GET | `/ai-generations/{generationId}` | — | `placeholdersCount`, `groundingReplacements` | 200, 403, 404 |

## Logs
- `info` `ai.content_reviewed` — `documentId`, `targetModule`, `sectionsCount`, `generationIds`, `durationMs`.
- `info` `ai.grounding_applied` — `generationId`, `targetModule`, `replacements`, `placeholders`.
- `warn` `ai.review_revision_conflict` (revisão divergente); `error` `ai.grounding_failed` — `generationId`, causa resumida, `correlationId`.
- **Nunca logar:** texto das seções, valores trocados pelo guard, rótulos dos `toConfirm`, resumo ou instrução do usuário.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `ai.content_review` | `DATA_CHANGE` | Commit de DOC-27 (uma por requisição) | `changes`: `reviewedAt` das seções (nulo → data); `metadata`: `documentId`, `targetModule`, `sectionKeys`, `generationIds`, `confirmAll`; nunca o texto |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode` = permissão de edição do tipo |

## Testes necessários
- **Unitários:** GroundingGuard com tabela de casos (R$ 1.234,56, "10 (dez) unidades", "30 dias", "12 meses", "15/03/2026", "5%", numerais por extenso; exceções art./§/inciso, numeração de lista, ano das entradas); idempotência do guard; propriedade "nenhuma saída gravada tem número fora do conjunto de fatos"; schema do `toConfirm`; regras de completude; regras de proveniência (editar mantém, reaplicar zera, esvaziar limpa).
- **Integração (Testcontainers PostgreSQL + Redis):** DOC-27 atômico (revisão, auditoria, outbox, timeline); DOC-08/09/10 e PRC-19 com as violações; snapshot de versão com `ai`; geração com `FakeAiProvider` até a aplicação.
- **API/contrato:** DOC-27 e DOC-05 conforme api.md; `violations[]` no formato §2.1.2; ausência de `Idempotency-Key` aceita em DOC-27.
- **RBAC e multi-tenant:** permissão de edição por tipo e escopo; `AI_GENERATE` desnecessária; documento de outro tenant → 404 (suíte "tenant leak").
- **Concorrência:** DOC-27 × autosave (DOC-05) na mesma seção; duas revisões simultâneas (uma efetiva, outra ignorada).
- **E2E (Playwright):** gerar com `FakeAiProvider` → aplicar → resolver chips → revisar → finalizar; "Revisar todas"; prévia PDF com nota.
- **Acessibilidade/performance:** axe sem violações sérias no badge, chip e diálogo; teste de contraste nos dois temas; 360 px.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] Permissão de edição do tipo e POL-02 aplicadas na API; ações ocultas sem permissão
- [ ] Nó `toConfirm` aceito no schema do editor, no validador do backend e no renderizador do PDF
- [ ] GroundingGuard coberto por testes de tabela e de propriedade; falha fechada comprovada
- [ ] Violações bloqueantes verificadas em DOC-08, DOC-09, DOC-10 e PRC-19
- [ ] Auditoria `ai.content_review` e evento `AiContentReviewed` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de DOC-27 compatível com api.md
- [ ] Logs sem conteúdo; métrica `cf_ai_grounding_replacements_total` presente
- [ ] Componentes acessíveis (axe) e responsivos (360 px)
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e as lacunas registradas) atualizada

## Estimativa
**M** — não há tabela nem endpoint pesado: o esforço está no nó novo do editor (três camadas), no GroundingGuard determinístico com seu conjunto de casos pt-BR e na integração com a completude e a prévia já existentes.

## Prioridade
**P1** — sem a revisão obrigatória e as marcas, a geração com IA (US-117..US-121) não pode ser liberada: o princípio 16 e o "nada inventado" da DEC-037 dependem desta story.

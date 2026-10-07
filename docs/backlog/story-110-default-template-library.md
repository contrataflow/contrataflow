---
id: US-110
title: "Biblioteca de templates padrão"
epic: EP-018
feature: FT-058
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-108]
modules: [document]
screens: [SCR-033, SCR-114]
endpoints: [TPL-01, TPL-03, TPL-06, TPL-08, TPL-10]
permissions: [TEMPLATE_VIEW, TEMPLATE_MANAGE, TEMPLATE_PUBLISH]
events: []
---

# US-110 — Biblioteca de templates padrão

## Título
Biblioteca de templates padrão

## Descrição
**Como** administrador de configurações documentais do órgão, **quero** que o tenant já nasça com uma biblioteca de templates padrão — publicada e pronta para uso — para os tipos de documento semeados, **para** elaborar DFD, ETP, TR, mapa de riscos, pesquisa de preços e os documentos livres mais comuns desde o primeiro dia, sem escrever modelos do zero e mantendo a orientação da Lei 14.133/2021.

Ao provisionar o tenant (US-099), o seeder `document.templateLibrary` cria, para cada tipo de documento semeado com template, um `DocumentTemplate` marcado `isSystem = true` com a versão 1 já `PUBLISHED`, contendo as seções canônicas do tipo (entities.md), orientações ao redator (`helpText`) e base legal (`legalBasis`) quando aplicável, e definido como `defaultTemplateId` do respectivo `DocumentType`. O conteúdo é totalmente editável — não há bloqueio por ser semeado — e, quando a plataforma evolui a biblioteca em um release futuro, o órgão pode opcionalmente adotar a atualização sem perder o que já publicou.

## Contexto
- Lei 14.133/2021: art. 18, §1º (elementos do ETP), art. 6º, XXIII (elementos do TR), art. 23 (pesquisa de preços) e art. 40 (minutas padronizadas); DFD segue o Decreto 10.947/2022; NOTA_TECNICA é orientada ao art. 72 (instrução da contratação direta).
- Hoje os órgãos partem de modelos de Word avulsos, desatualizados e sem rastreabilidade de quem alterou a base legal; divergências entre setores do mesmo órgão são comuns e aumentam o risco de questionamento pelo Controle Interno/Tribunais de Contas.
- DEC-017 (modelo documental híbrido): as seções narrativas de um documento vêm de `DocumentTemplateVersion.sections`; DEC-016: elementos legais obrigatórios são configuração semeada, não código.
- US-107 definiu o editor de seções (`SectionDefinition`) e US-108 o ciclo de publicação/versão e o padrão por tipo (`DocumentType.defaultTemplateId`, `DTY-04`). Esta story usa exatamente esses mecanismos para entregar conteúdo pronto — não cria um mecanismo de edição novo.
- US-099 registra o seeder `document.templateLibrary` no checklist de provisionamento (entre `document.systemTypes` e `workflow.seedWorkflows`); esta story é a dona do conteúdo e do comportamento desse seeder.

## Objetivo
Todo tenant recém-provisionado tem, sem qualquer ação manual, templates publicados para os 10 tipos de documento semeados com template (todos exceto `DOCUMENTO_EXTERNO`), prontos para gerar documentos válidos e juridicamente orientados; o órgão consegue revisar/adaptar qualquer um deles (Procuradoria) e, quando a plataforma publica uma biblioteca mais nova, consegue adotar a atualização por tipo em poucos cliques, sem perder o que já publicou.

## Persona
- **Principal:** Administrador de configurações documentais do órgão (detentor de `TEMPLATE_MANAGE`/`TEMPLATE_PUBLISH`) — revisa e adapta os modelos semeados.
- **Secundárias:** Procuradoria/assessoria jurídica do tenant (mesmo perfil, revisão do texto-base); qualquer detentor de `TEMPLATE_VIEW`; operador da plataforma (US-099, dispara a semeadura); redatores de DFD/ETP/TR/mapa de riscos/pesquisa de preços (consomem o template ao criar o documento — fora do escopo desta story).

## Pré-condições
- Tenant em provisionamento (US-099), com `document.systemTypes` (US-061) já concluído — os `DocumentType` existem antes da biblioteca.
- Para a adoção de atualização: tenant `ACTIVE`; usuário com `TEMPLATE_MANAGE` (criar rascunho) e `TEMPLATE_PUBLISH` (publicar); template `isSystem = true` com versão `PUBLISHED`.

## Fluxo principal
1. Durante `pnpm cf tenant:provision` (ou `POST /api/v1/platform/tenants`, US-099), após `document.systemTypes`, o checklist executa a etapa **`document.templateLibrary`**.
2. Para cada tipo semeado com template (DFD, ETP, TR, RISK_MAP, PRICE_RESEARCH, DESPACHO, OFICIO, NOTA_TECNICA, AUTORIZACAO, DECLARACAO), o seeder lê a definição estática da biblioteca (fixture versionado com o release da plataforma) e cria um `DocumentTemplate` (`name = "<Tipo> — Modelo padrão"`, `isSystem = true`, `isActive = true`) com a versão 1 (`sections`, `layout` fixo — RN-TPL-02, `fieldConfig = {}`, `importMappings` semeado só para TR — §5.8) já em `status = PUBLISHED`, `publishedAt = now`, `contentHash` calculado (RFC 8785).
3. O seeder atualiza `DocumentType.defaultTemplateId` para o template recém-criado.
4. A etapa é marcada `DONE` no checklist e segue para `workflow.seedWorkflows`. Nenhum evento de domínio próprio é emitido — a semeadura integra a transação e o evento `TenantProvisioned` (US-099).
5. Ao aceitar o convite e abrir **Templates** (SCR-033, US-107), o administrador já vê os 10 modelos publicados, com o selo "Modelo padrão da plataforma", e pode usá-los imediatamente para criar documentos (módulos próprios) ou revisá-los (US-108: nova versão → editar → publicar).
6. Quando a plataforma publica uma biblioteca padrão mais nova (release futuro), o changelog da plataforma indica quais tipos de documento tiveram o texto-base ou as seções atualizados. Não há detecção automática de divergência nem endpoint dedicado no MVP 1 (lacuna registrada em Dependências) — para adotar, o administrador usa o fluxo já existente de nova versão (`TPL-06`, que clona a versão corrente do próprio template), ajusta manualmente o conteúdo conforme o changelog e publica pelo fluxo normal (`TPL-08`/`TPL-10`, US-107/108). A adoção é sempre opcional.

## Fluxos alternativos
- **FA-01 — Tipo sem template:** `DOCUMENTO_EXTERNO` (`kind = UPLOADED`) não recebe template — não há seção/layout para um arquivo externo; `defaultTemplateId` permanece nulo.
- **FA-02 — Retomada após falha parcial:** se a transação de provisionamento falhar durante `document.templateLibrary`, nenhum template parcial fica persistido (RN-TPL-33); ao reexecutar o comando, só a etapa pendente roda.
- **FA-03 — Nome reservado já usado:** improvável no provisionamento (tenant novo), mas se o administrador tentar criar manualmente (US-107) um template com o nome reservado ("<Tipo> — Modelo padrão") para o mesmo `documentTypeId`, recebe `TEMPLATE_NAME_TAKEN` (409) — mesma regra de US-107, sem tratamento especial para nomes semeados.
- **FA-04 — Adoção por tipo, não em lote:** a adoção de atualização (passo 6) é por template; o administrador pode adotar a atualização do TR sem tocar nos demais.
- **FA-05 — Descartar o rascunho da atualização:** o rascunho criado por `TPL-06` para incorporar uma atualização é um `DocumentTemplateVersion` comum; pode ser abandonado (nunca publicado) sem efeito — a versão vigente continua ativa.

## Regras de negócio
- **RN-TPL-28** — A semeadura cria um `DocumentTemplate` `isSystem = true` com versão 1 `PUBLISHED` para cada tipo com template (DFD, ETP, TR, RISK_MAP, PRICE_RESEARCH, DESPACHO, OFICIO, NOTA_TECNICA, AUTORIZACAO, DECLARACAO) e define `DocumentType.defaultTemplateId`; `DOCUMENTO_EXTERNO` (`kind = UPLOADED`) não recebe template.
- **RN-TPL-29** — As seções semeadas usam as chaves canônicas de cada tipo (entities.md), na ordem indicada: DFD = `JUSTIFICATION`, `EXPECTED_RESULTS`, `NOTES`; ETP = `NEED_DESCRIPTION`, `PROBLEM`, `OBJECTIVE`, `PCA_ALIGNMENT`, `REQUIREMENTS`, `MARKET_SURVEY`, `ALTERNATIVES`, `ESTIMATES`, `RECOMMENDED_SOLUTION`, `PARCELING`, `RELATED_CONTRACTS`, `EXPECTED_RESULTS`, `ENVIRONMENTAL_IMPACTS`, `PRIOR_MEASURES`, `RISKS`, `CONCLUSION`; TR = `OBJECT`, `JUSTIFICATION`, `SPECIFICATIONS`, `ACCEPTANCE_CRITERIA`, `CONTRACTOR_OBLIGATIONS`, `CONTRACTING_PARTY_OBLIGATIONS`, `DEADLINES`, `DELIVERY`, `PAYMENT`, `OVERSIGHT`, `GUARANTEES`, `SANCTIONS`, `SELECTION_CRITERIA`, `ESTIMATED_VALUE`; RISK_MAP = `INTRODUCTION`, `METHODOLOGY` (narrativas), `RISK_MATRIX` (`render = RISK_MATRIX`), `RISK_LIST` (`render = RISK_LIST`), `NOTES`; PRICE_RESEARCH = `METHODOLOGY` (narrativa), `PRICE_SUMMARY` (`render = PRICE_SUMMARY`, computada), `CONCLUSION`.
- **RN-TPL-30** — DESPACHO, OFICIO, AUTORIZACAO e DECLARACAO recebem seção única `CONTENT` (`requirement = REQUIRED`, `render = TEXT`) com texto-base genérico; NOTA_TECNICA recebe `CONTENT` orientado à justificativa de escolha de fornecedor/preço em contratação direta (Lei 14.133/2021, art. 72). Todas as seções semeadas trazem `helpText`; `legalBasis` é preenchido quando há dispositivo direto e claro (ex.: ETP `NEED_DESCRIPTION` → "Lei 14.133/2021, art. 18, §1º, I"; TR `OBJECT` → "Lei 14.133/2021, art. 6º, XXIII"; DFD → "Decreto 10.947/2022"); nos demais casos fica genérico. Os textos-base são redigidos para revisão pela Procuradoria do tenant — nunca travados.
- **RN-TPL-31** — `layout` semeado usa os valores fixos de RN-TPL-02 (US-107); `fieldConfig = {}` (rótulos/obrigatoriedade dos campos tipados usam os padrões do módulo até o tenant personalizar); `importMappings` só é semeado — com o mapeamento padrão de §5.8 — no template de TR; os demais tipos ficam com `importMappings = null`.
- **RN-TPL-32** — `isSystem = true` é apenas indicador de origem/selo de UI e rastreabilidade; não restringe nenhuma ação disponível a templates comuns (RN-TPL-01 a RN-TPL-27 de US-107/108/109 aplicam-se integralmente) — o template semeado é editável, pode ter novas versões e pode deixar de ser o padrão do tipo (`DTY-04`).
- **RN-TPL-33** — A etapa `document.templateLibrary` é idempotente: templates já criados não são recriados nem duplicados em uma nova tentativa (protegido também pela constraint `(tenant_id, document_type_id, lower(name))`); falha a meio da etapa não deixa template parcial persistido (mesma garantia transacional de US-099).
- **RN-TPL-34** — O conteúdo semeado passa pela mesma validação de publicação do editor (RN-TPL-04 a RN-TPL-09, US-107) antes de ser persistido como `PUBLISHED`; a biblioteca da plataforma nunca pode violar as regras que ela própria impõe aos tenants.
- **RN-TPL-35** — A adoção de uma atualização da biblioteca padrão é manual: usa o fluxo já existente de nova versão (`TPL-06`, que clona a versão `PUBLISHED`/`RETIRED` de maior `versionNumber` do próprio template — RN-TPL-13) seguido de edição (`TPL-08`) conforme o changelog de release da plataforma e publicação (`TPL-10`). Não há, no MVP 1, comparação automática de `contentHash` contra a biblioteca da plataforma nem endpoint dedicado de detecção — lacuna registrada em Dependências.
- **RN-TPL-36** — A adoção é sempre opcional e nunca automática; sem efeito retroativo (mesma RN-TPL-16/RN-TPL-27) — adotar uma atualização não altera versões já publicadas nem documentos criados a partir delas. Aplica-se a mesma exclusividade de rascunho de RN-TPL-10/RN-TPL-13 (`TEMPLATE_DRAFT_EXISTS`, 409, se já houver rascunho para o template).

## Campos
| Tipo de documento | `documentTypeCode` | Nome do template semeado | Seções (chaves, em ordem) | Base legal principal |
|---|---|---|---|---|
| DFD | `DFD` | DFD — Modelo padrão | `JUSTIFICATION`, `EXPECTED_RESULTS`, `NOTES` | Decreto 10.947/2022 |
| ETP | `ETP` | ETP — Modelo padrão | `NEED_DESCRIPTION`…`CONCLUSION` (16 chaves — RN-TPL-29) | Lei 14.133/2021, art. 18, §1º |
| TR | `TR` | Termo de Referência — Modelo padrão | `OBJECT`…`ESTIMATED_VALUE` (14 chaves — RN-TPL-29) | Lei 14.133/2021, art. 6º, XXIII |
| RISK_MAP | `RISK_MAP` | Mapa de Riscos — Modelo padrão | `INTRODUCTION`, `METHODOLOGY`, `RISK_MATRIX`, `RISK_LIST`, `NOTES` | Lei 14.133/2021 (gestão de riscos) |
| PRICE_RESEARCH | `PRICE_RESEARCH` | Pesquisa de Preços — Modelo padrão | `METHODOLOGY`, `PRICE_SUMMARY`, `CONCLUSION` | Lei 14.133/2021, art. 23 |
| DESPACHO | `DESPACHO` | Despacho — Modelo padrão | `CONTENT` | Lei 14.133/2021, art. 40 |
| OFICIO | `OFICIO` | Ofício — Modelo padrão | `CONTENT` | — |
| NOTA_TECNICA | `NOTA_TECNICA` | Nota Técnica — Modelo padrão | `CONTENT` | Lei 14.133/2021, art. 72 |
| AUTORIZACAO | `AUTORIZACAO` | Autorização — Modelo padrão | `CONTENT` | Lei 14.133/2021, art. 72 |
| DECLARACAO | `DECLARACAO` | Declaração — Modelo padrão | `CONTENT` | — |
| DOCUMENTO_EXTERNO | `DOCUMENTO_EXTERNO` | *(nenhum — kind UPLOADED)* | — | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Conteúdo semeado reprova a validação de publicação (RN-TPL-34) | CI/seed | "A biblioteca padrão falhou na validação interna." (log; não chega ao usuário) | `TEMPLATE_INVALID` |
| V-02 | `TPL-06` chamado para um template que já tem rascunho (adoção manual de atualização) | API | "Já existe um rascunho em edição para este modelo." | `TEMPLATE_DRAFT_EXISTS` |
| V-03 | Criar template manual com o nome reservado do mesmo tipo | API | "Já existe um modelo com este nome para este tipo de documento." | `TEMPLATE_NAME_TAKEN` |
| V-04 | Sem `TEMPLATE_MANAGE`/`TEMPLATE_PUBLISH` para a adoção manual (nova versão/publicação) | API | "Você não tem permissão para esta ação." | `PERMISSION_DENIED` |

## Permissões
- **Permissão:** `TEMPLATE_VIEW` para ver os templates semeados; `TEMPLATE_MANAGE` para criar manualmente o rascunho que incorpora uma atualização (`TPL-06`); `TEMPLATE_PUBLISH` para publicá-lo (`TPL-10`, US-108).
- **Políticas:** nenhuma política contextual adicional além das já definidas em US-107/108.
- **MFA:** não exigido para `TEMPLATE_VIEW`/`TEMPLATE_MANAGE`; `TEMPLATE_PUBLISH` sem exigência própria (mesma regra de US-108). A semeadura em si corre sob o operador de plataforma com MFA (US-099), não sob um usuário do tenant.
- **Sem permissão:** botão "Nova versão" oculto sem `TEMPLATE_MANAGE`; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | Semeadura não emite evento próprio | Integra a transação de `TenantProvisioned` (US-099) |
| `TemplateVersionPublished` | `template.version_published` | Publicação do rascunho que incorporou uma atualização da biblioteca | Reaproveitado de US-108 (`TPL-10`); sem payload adicional |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma na semeadura inicial. A divulgação de atualizações da biblioteca padrão ocorre pelo changelog de release da plataforma (fora do produto); notificação in-app fica para versão futura (decisão de escopo, não lacuna). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Biblioteca de templates padrão

  Background:
    Given que o tenant "Prefeitura de São José" foi provisionado com os tipos de documento semeados (US-061)
    And a biblioteca padrão da plataforma define conteúdo para DFD, ETP, TR, RISK_MAP, PRICE_RESEARCH, DESPACHO, OFICIO, NOTA_TECNICA, AUTORIZACAO e DECLARACAO

  Scenario: [Sucesso] Provisionamento semeia a biblioteca padrão
    When a etapa "document.templateLibrary" do checklist de provisionamento for executada
    Then devem existir 10 templates com "isSystem" igual a verdadeiro, um por tipo semeado com template
    And cada um deve ter a versão 1 com status "PUBLISHED", "contentHash" preenchido e seções conforme RN-TPL-29
    And "DOCUMENTO_EXTERNO" não deve ter "defaultTemplateId"
    And cada "DocumentType" correspondente deve ter "defaultTemplateId" apontando para o template semeado

  Scenario: [Sucesso] Administrador usa a biblioteca semeada imediatamente
    Given que "Marta" tem "TEMPLATE_VIEW"
    When "Marta" abrir a tela "Templates"
    Then deve ver 10 modelos com o selo "Modelo padrão da plataforma"
    And deve conseguir abrir "Termo de Referência — Modelo padrão" e ver as seções "OBJECT", "JUSTIFICATION" e "SPECIFICATIONS" entre outras

  Scenario: [Validação] Biblioteca com seção inválida é rejeitada antes do release
    Given que a definição de um tipo na fixture da biblioteca tem uma seção com "render" incompatível
    When a fixture for validada no pipeline de build (RN-TPL-34)
    Then a validação deve falhar com código "TEMPLATE_INVALID"
    And o release não deve avançar para produção

  Scenario: [Permissão] Usuário sem TEMPLATE_MANAGE não inicia a adoção manual
    Given que "Bruno" tem apenas "TEMPLATE_VIEW"
    When "Bruno" acessar a tela "Templates"
    Then o botão "Nova versão" não deve ser exibido para os templates semeados
    When "Bruno" chamar TPL-06 diretamente para o template "TR — Modelo padrão"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Isolamento da biblioteca semeada entre tenants
    Given que o tenant "Prefeitura B" também foi provisionado e tem seu próprio template "ETP — Modelo padrão"
    When um usuário da "Prefeitura de São José" tentar acessar por id o template de "Prefeitura B" (TPL-03)
    Then a API deve responder 404
    And os dois templates "ETP — Modelo padrão" devem ter ids e "tenantId" diferentes, com conteúdo independente

  Scenario: [Duplicidade] Reexecutar o provisionamento após falha não duplica a biblioteca
    Given que a etapa "document.templateLibrary" já concluiu para 6 dos 10 tipos quando o banco falhou
    When o operador reexecutar "pnpm cf tenant:provision --file sao-jose.json"
    Then somente os 4 tipos pendentes devem ser semeados
    And não deve haver templates duplicados para os 6 tipos já concluídos

  Scenario: [Concorrência] Duas tentativas simultâneas de iniciar a adoção da mesma atualização
    Given que o template "TR — Modelo padrão" não tem rascunho
    When duas requisições TPL-06 para esse template chegarem simultaneamente
    Then uma deve responder 201 com uma nova versão "DRAFT"
    And a outra deve responder 409 com código "TEMPLATE_DRAFT_EXISTS"

  Scenario: [Falha de banco] Banco indisponível durante a semeadura da biblioteca
    Given que o banco de dados fica indisponível durante a etapa "document.templateLibrary"
    When o provisionamento for executado
    Then nenhum template parcial deve ser persistido
    And a etapa deve permanecer "PENDING" no checklist
    And a reexecução posterior, com o banco disponível, deve concluir a semeadura

  Scenario: [Falha de integração] Definição da biblioteca ausente ou corrompida no release
    Given que a fixture da biblioteca padrão não pode ser carregada pelo seeder
    When a etapa "document.templateLibrary" for executada
    Then a etapa deve falhar com um erro claro e permanecer "PENDING"
    And nenhuma outra etapa do checklist deve ser afetada
    And o erro deve ser reportado com o nome do tipo de documento que falhou ao carregar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Fixture da biblioteca inválida (CI/seed) | — | `TEMPLATE_INVALID` | — (não chega ao usuário; bloqueia o release) | — |
| Rascunho já existente ao iniciar a adoção manual | 409 | `TEMPLATE_DRAFT_EXISTS` | "Já existe um rascunho em edição para este modelo." | Abre o rascunho existente |
| Nome reservado em uso | 409 | `TEMPLATE_NAME_TAKEN` | "Já existe um modelo com este nome para este tipo de documento." | Erro no campo "Nome" |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Ação oculta/desabilitada |
| Falha ao carregar a fixture no seeder | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir o provisionamento agora." | CLI/API reporta etapa `PENDING`; permite nova tentativa |

## Dependências
- **Stories:** US-108 (publicação/versão e padrão do tipo — reaproveitados integralmente por esta story). Indiretas: US-107 (editor e validação de template), US-061 (tipos de documento semeados), US-099 (checklist de provisionamento que invoca este seeder).
- **Decisões/ADRs:** DEC-016, DEC-017 (ADR-006).
- **Configurações:** nenhuma chave dedicada — a biblioteca é um fixture versionado com o release da plataforma, não configuração do tenant.
- **Lacunas nas fontes canônicas:** entities.md e api.md não definem uma entidade para "a biblioteca padrão mantida pela plataforma" nem um mecanismo de detecção/comparação de atualizações futuras dela (conferido por grep em ambos — nenhuma ocorrência). Conceito mais próximo adotado nesta story: a adoção de uma atualização é manual, pelo fluxo já existente de nova versão + edição + publicação (`TPL-06`/`TPL-08`/`TPL-10`, US-107/108), orientada pelo changelog de release da plataforma (fora da API). Proposta para uma story futura, caso o produto queira automatizar a detecção: um endpoint de comparação de `contentHash` no catálogo `TPL-` (a numerar) e um indicador correspondente na tela de Templates.

## Impacto técnico
- A semeadura roda dentro da mesma transação de provisionamento (custo desprezível: ~10 inserts + versões); não altera o orçamento de performance de US-099.
- `contentHash` deve reaproveitar a mesma canonicalização RFC 8785 de US-108 (utilitário único, não duplicar implementação).
- A fixture da biblioteca evolui com o release da plataforma; o pipeline de build deve validar a fixture contra `sectionDefinitionSchema`/`layoutDefinitionSchema` antes do deploy (RN-TPL-34), para que uma biblioteca inválida nunca chegue a quebrar um provisionamento.
- Imutabilidade das versões publicadas combinada com adoção opt-in protege os tenants de mudanças de texto legal não revisadas — risco de confiabilidade jurídica mitigado por desenho, não por processo manual.

## Backend
- **Módulo(s):** `document` (dono); reaproveita `TemplateValidationService` e o utilitário de hash de US-107/108.
- **Casos de uso:** `SeedTemplateLibraryStep` (chamado pelo checklist de US-099); a adoção manual de atualização reaproveita os casos de uso de `TPL-06`/`TPL-08`/`TPL-10` (US-108), sem caso de uso próprio.
- **Domínio:** reaproveita `DocumentTemplate`/`DocumentTemplateVersion` (US-107/108); fixture estático `packages/template-library` (proposta da lacuna) com uma definição por tipo de documento.
- **Integrações internas:** `document` (`DocumentType.defaultTemplateId`); `platform` (`SeederRegistry`/checklist, US-099).
- **Transação:** passos 1–4 do fluxo principal correm na mesma transação de US-099; a adoção manual (passo 6) reaproveita a transação já existente de `TPL-06` (US-108).

## Frontend
- **Tela(s):** SCR-033 (`/admin/templates`) — selo "Modelo padrão da plataforma" nos `isSystem`; o botão "Nova versão" já existente (US-108) é o mesmo usado para iniciar a adoção manual de uma atualização; SCR-114 para revisar/publicar o rascunho (fluxo já existente de US-107/108/109).
- **Componentes:** `SystemTemplateBadge`.
- **Estados:** nenhum carregamento adicional (lista já existente de US-107); sem empty state específico — sempre há os templates semeados.
- **Acessibilidade:** selo expresso também em texto (não só cor/ícone).

## Banco de dados
- **Tabelas escritas:** `document_templates`, `document_template_versions`; atualização de `document_types.default_template_id`.
- **Migrações:** nenhuma nova — reaproveita o esquema de US-061/107/108.
- **Índices/constraints relevantes:** reaproveita `UNIQUE (tenant_id, document_type_id, lower(name))` em `document_templates` e `UNIQUE (tenant_id, template_id, version_number)` em `document_template_versions`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| TPL-01, TPL-03 | GET | `/templates`, `/templates/{id}` | — | Sem alteração — exibem os templates semeados (`isSystem = true`) normalmente | 200 |
| TPL-06 | POST | `/templates/{id}/versions` | `TEMPLATE_MANAGE` | Reaproveitado para iniciar manualmente a adoção de uma atualização da biblioteca (clona a versão corrente; o administrador ajusta o conteúdo conforme o changelog da plataforma) | 201, 409 (`TEMPLATE_DRAFT_EXISTS`) |
| TPL-08, TPL-10 | PATCH / POST | `/template-versions/{versionId}`, `/template-versions/{versionId}/publish` | — | Fluxo normal de edição/publicação (US-107/108) | 200 |

## Logs
- `info` `template_library.seeded` — `tenantId`, quantidade de templates criados, `durationMs`.
- `warn` `template_library.update_check_failed` — falha ao calcular/comparar `contentHash` da biblioteca vigente.
- `error` `template_library.seed_failed` — `documentTypeCode` que falhou ao carregar/validar, `correlationId` (stack em `debug`).
- **Nunca logar:** o conteúdo das seções (apenas chaves e contagens).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `tenant.provision` | `CONFIGURATION` | Commit do provisionamento | Inclui a contagem de templates semeados (reaproveitado de US-099; sem ação própria por item) |
| `template.update` | `CONFIGURATION` | Criação manual do rascunho que incorpora uma atualização da biblioteca (`TPL-06`) | Reaproveitado de US-108, sem campo adicional |
| `template.version_publish` | `CONFIGURATION` | Publicação do rascunho adotado (`TPL-10`) | Reaproveitado de US-108, sem campo adicional |

## Testes necessários
- **Unitários:** fixture de cada um dos 10 tipos passa em `sectionDefinitionSchema`/`layoutDefinitionSchema`; cálculo de `contentHash` estável.
- **Integração (Testcontainers PostgreSQL):** semeadura idempotente em reexecução; `defaultTemplateId` apontando corretamente; RLS impede leitura de template de outro tenant.
- **API/contrato:** `TPL-01`/`TPL-03` exibindo os templates semeados; `TPL-06`/`TPL-08`/`TPL-10` reaproveitados conforme api.md (snapshot OpenAPI).
- **RBAC e multi-tenant:** só `TEMPLATE_MANAGE` inicia uma nova versão (`TPL-06`); acesso cruzado de tenant → 404.
- **Concorrência:** duas chamadas simultâneas de `TPL-06` para o mesmo template → uma 201, outra `TEMPLATE_DRAFT_EXISTS`.
- **E2E (Playwright):** provisionar tenant → abrir Templates → ver os 10 modelos → abrir um e ver as seções corretas.
- **Falha/resiliência:** interrupção do banco a meio da etapa não deixa template parcial; fixture corrompida falha de forma isolada sem afetar as demais etapas do checklist.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (seed + API) e passando no CI
- [ ] Os 10 templates semeados validados contra `sectionDefinitionSchema`/`layoutDefinitionSchema` no pipeline de build
- [ ] `defaultTemplateId` verificado para cada `DocumentType` com template
- [ ] `TEMPLATE_VIEW`/`TEMPLATE_MANAGE`/`TEMPLATE_PUBLISH` aplicados na API; UI oculta/desabilita conforme permissão
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `TPL-01`/`TPL-03`/`TPL-06` compatível com api.md para os templates semeados
- [ ] Logs sem conteúdo de seções; métricas de semeadura e de adoção de atualização
- [ ] Revisão de conteúdo jurídico-base por produto/Procuradoria de referência
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reaproveita integralmente os mecanismos de edição/publicação de US-107/108; a complexidade está no conteúdo dos 10 tipos e no mecanismo leve de detecção/adoção de atualização, não em infraestrutura nova.

## Prioridade
**P0** — sem a biblioteca semeada, o tenant provisionado não tem como elaborar DFD/ETP/TR no primeiro dia; bloqueia a adoção do produto.

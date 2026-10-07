---
id: US-013
title: "Sigilo do orçamento estimado"
epic: EP-001
feature: FT-007
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-001, US-097]
modules: [process, document, access, timeline, platform]
screens: [SCR-006]
endpoints: [PRC-33]
permissions: [PROCESS_SET_CONFIDENTIAL_BUDGET, PROCESS_VIEW_CONFIDENTIAL_BUDGET, PROCESS_VIEW]
events: [ProcessConfidentialityChanged]
---

# US-013 — Sigilo do orçamento estimado

## Título
Sigilo do orçamento estimado

## Descrição
**Como** gestor de contratações (ou autoridade competente), **quero** marcar e desmarcar o orçamento estimado de um processo como sigiloso, **para** cumprir o art. 24 da Lei 14.133/2021 sem deixar de permitir que quem decide e os órgãos de controle vejam os valores.

Com `isBudgetConfidential = true`, a API passa a mascarar (`null` + `<campo>Masked: true`) os valores estimados do processo, dos itens, da pesquisa de preços, do ETP e do TR para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` sobre o processo nem detém a custódia atual; documentos de pesquisa de preços passam a `confidentiality = RESTRICTED`. A máscara é aplicada por uma política central de serialização — nunca tela a tela — e cobre também PDFs, exportações, timeline e notificações.

## Contexto
- Art. 24 da Lei 14.133/2021: o orçamento estimado pode ter caráter sigiloso até a fase de julgamento da licitação, ressalvada a necessidade de seu conhecimento pelos órgãos de controle interno e externo (parágrafo único, inciso I).
- DEC-030 e POL-09 definem a máscara central; DEC-024 define a visibilidade do processo em si, que não é afetada — o sigilo é só do valor, não do processo.
- Relaciona-se a US-001 (processo e `estimatedValue`), US-005 (edição do valor) e US-006 (itens com `referenceUnitPrice`); e, em outros épicos, às stories de pesquisa de preços, ETP e TR, que aplicam a mesma máscara aos próprios campos de valor.

## Objetivo
Garantir que, com o orçamento marcado como sigiloso, 100% das leituras de valores estimados (API, PDF, exportação, timeline, notificação) fiquem mascaradas para quem não atende POL-09, que a mudança seja auditável nos dois sentidos (ativar/desativar) e que os órgãos de controle interno e externo nunca percam o acesso.

## Persona
- **Principal:** Gestor de contratações (perfil `GESTOR_CONTRATACOES`, escopo `TENANT`) — junto da Autoridade competente, único perfil com `PROCESS_SET_CONFIDENTIAL_BUDGET` por padrão.
- **Secundária:** Autoridade competente (`AUTORIDADE_COMPETENTE`, escopo `ORGANIZATION`).
- **Quem consulta valores mesmo sigilosos (`PROCESS_VIEW_CONFIDENTIAL_BUDGET`):** também Planejamento, Compras, Contabilidade, Jurídico, Controle Interno e Auditor (permissions.md §3.2), além de quem detém a custódia atual (POL-09).

## Pré-condições
- O processo existe (US-001) e o usuário tem `PROCESS_VIEW`.
- Para alterar o sigilo: `PROCESS_SET_CONFIDENTIAL_BUDGET` em escopo que cubra o processo; conhece a `version` atual (`ETag`/`If-Match` — DEC-104).

## Fluxo principal
1. No painel do processo (SCR-006), quem tem `PROCESS_SET_CONFIDENTIAL_BUDGET` vê o interruptor "Orçamento sigiloso" com o estado atual.
2. Ao alternar, um diálogo de confirmação explica o efeito ("Os valores estimados deste processo ficarão visíveis só a quem tem a permissão específica ou está com o processo; órgãos de controle continuam vendo normalmente.") e pede confirmação.
3. O front envia `PUT /api/v1/processes/{id}/confidentiality` (PRC-33) com `{ isBudgetConfidential }` e `If-Match`.
4. A API, em uma transação: autoriza `PROCESS_SET_CONFIDENTIAL_BUDGET`; confere `If-Match` (RN-PROC-144); grava `Process.isBudgetConfidential`; ao ativar, marca `confidentiality = RESTRICTED` nos documentos de pesquisa de preços do processo (RN-PROC-139); grava timeline `CONFIDENTIALITY_CHANGED`; audita `process.confidentiality_change`; publica `ProcessConfidentialityChanged`; incrementa `version`.
5. A API responde **200** com o processo atualizado e novo `ETag`; o painel passa a exibir (ou remover) o selo "Orçamento sigiloso".
6. A partir desse commit, toda leitura de valores do processo (resumo, itens, pesquisa, ETP, TR, PDFs, exportações) aplica a máscara de POL-09; a primeira leitura do valor real por alguém autorizado, por sessão e processo, audita `process.confidential_view` (RN-PROC-143).

## Fluxos alternativos
- **FA-01 — Custodiante sem a permissão de visualização:** quem detém a custódia atual (`currentResponsibleId`) vê o valor mesmo sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (POL-09), mas não pode ligar/desligar o sigilo sem `PROCESS_SET_CONFIDENTIAL_BUDGET`.
- **FA-02 — Exportação e PDF:** a exportação CSV (PRC-34) e as renderizações (`DocumentRendition`) exibem o valor mascarado para quem não atende a política; nunca omitem a coluna/campo.
- **FA-03 — Desativar o sigilo:** mesmo endpoint com `isBudgetConfidential: false`; os documentos de pesquisa de preços voltam à confidencialidade padrão do tipo; os valores deixam de ser mascarados para quem tem `PROCESS_VIEW`.
- **FA-04 — Documento de pesquisa `RESTRICTED` sem permissão:** a lista de documentos mostra título e status; conteúdo e PDF exigem POL-09 (DEC-024).

## Regras de negócio
- **RN-PROC-137** — `Process.isBudgetConfidential` (padrão `false`) só é alterado via `PUT /processes/{id}/confidentiality` por quem tem `PROCESS_SET_CONFIDENTIAL_BUDGET` cobrindo o processo; nunca por `PATCH` genérico do processo (DEC-030).
- **RN-PROC-138** — Com `isBudgetConfidential = true`, os campos de valor estimado do processo, dos itens (`referenceUnitPrice`), da pesquisa de preços, do ETP e do TR são serializados como `null` + `<campo>Masked: true` para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo e não é o `currentResponsibleId` (POL-09); o campo nunca é omitido do contrato.
- **RN-PROC-139** — Ao ativar, todo `Document` do tipo pesquisa de preços do processo passa `confidentiality = RESTRICTED` (ainda que já `FINALIZED`/`APPROVED`); ao desativar, volta à confidencialidade padrão do `DocumentType`.
- **RN-PROC-140** — PDFs/`DocumentRendition`, exportações (CSV) e notificações aplicam a mesma máscara (POL-09); nenhum canal pode revelar o valor a quem não atende a política.
- **RN-PROC-141** — Entradas de timeline derivadas de eventos que exponham valor (ex.: `PROCESS_UPDATED` com `estimatedValue`, `QUOTATION_EXCLUDED`) recebem visibilidade `BUDGET_RESTRICTED` enquanto o processo estiver sigiloso, visíveis só a quem atende POL-09.
- **RN-PROC-142** — Os perfis `CONTROLE_INTERNO` e `AUDITOR` mantêm `PROCESS_VIEW_CONFIDENTIAL_BUDGET` por padrão, preservando o acesso dos órgãos de controle interno e externo mesmo com o processo sigiloso (art. 24, parágrafo único, I).
- **RN-PROC-143** — A primeira leitura do valor real por um usuário autorizado, por sessão e processo, gera auditoria `process.confidential_view` (categoria `ACCESS`); leituras seguintes na mesma sessão não repetem o registro.
- **RN-PROC-144** — Alterar o sigilo exige `If-Match` com a `version` atual do processo (DEC-104); divergência responde `VERSION_CONFLICT` (412) com `currentVersion` no corpo.
- **RN-PROC-145** — Não há notificação dedicada à mudança de sigilo (apenas timeline `CONFIDENTIALITY_CHANGED` e auditoria); participantes e responsável não são avisados por in-app/e-mail especificamente por isso.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Orçamento sigiloso | `isBudgetConfidential` | interruptor | Sim (no corpo do `PUT`) | booleano; RN-PROC-137 | `false` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campo `isBudgetConfidential` ausente ou não booleano | Front + API (Zod) | "Informe se o orçamento é sigiloso." | `VALIDATION_ERROR` (`REQUIRED`/`INVALID_FORMAT`) |
| V-02 | `If-Match` ausente | API | — (front sempre envia) | `PRECONDITION_REQUIRED` |
| V-03 | `If-Match` divergente (processo alterado por outra ação) | API | "Este processo foi alterado por outra pessoa. Recarregue e tente novamente." | `VERSION_CONFLICT` |
| V-04 | Sem `PROCESS_SET_CONFIDENTIAL_BUDGET` no escopo | API | "Você não tem permissão para definir o sigilo deste processo." | `PERMISSION_DENIED` |

## Permissões
- **Permissão:** `PROCESS_SET_CONFIDENTIAL_BUDGET` cobrindo o processo, para ativar/desativar (PRC-33). `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo, para ver valores mascarados em qualquer leitura (aplicada globalmente, não só aqui).
- **Políticas:** POL-09 (máscara central, em todos os pontos listados no Contexto).
- **MFA:** exigida quando `security.mfaPolicy` ∈ {`ADMINS`, `ALL`} (POL-14 — ambas as permissões envolvidas são risco `H`); caso contrário, não exigida.
- **Sem permissão:** o interruptor aparece desabilitado com a dica "Só o gestor ou a autoridade competente pode alterar"; a API responde 403 `PERMISSION_DENIED` e audita `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessConfidentialityChanged` | `process.confidentiality_changed` | Commit da ativação ou desativação | Payload `{ isBudgetConfidential }` |

Projeção síncrona na mesma transação: `ProcessTimelineEntry` (`CONFIDENTIALITY_CHANGED`, visibilidade `STANDARD` — o próprio fato de ser sigiloso não é segredo).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma (RN-PROC-145); apenas timeline e auditoria. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Sigilo do orçamento estimado

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" tem valor estimado "150000.00" e version "1"
    And "Carla" tem o perfil "GESTOR_CONTRATACOES" com "PROCESS_SET_CONFIDENTIAL_BUDGET"
    And "Hugo" tem apenas "PROCESS_VIEW" sobre o processo "0012/2026"
    And "Iris" tem o perfil "CONTROLE_INTERNO"

  Scenario: [Sucesso] Marcar o orçamento como sigiloso
    When "Carla" ativar "Orçamento sigiloso" com "If-Match" igual a "1"
    Then o processo deve ter "isBudgetConfidential" igual a verdadeiro e "version" igual a "2"
    And os documentos de pesquisa de preços do processo devem passar a "confidentiality" "RESTRICTED"
    And deve gerar registro de auditoria "process.confidentiality_change"
    And deve gerar o evento "ProcessConfidentialityChanged"
    When "Hugo" consultar o processo
    Then o campo "estimatedValue" deve vir nulo com "estimatedValueMasked" igual a verdadeiro
    When "Iris" consultar o processo
    Then o campo "estimatedValue" deve mostrar "150000.00"
    And deve gerar registro de auditoria "process.confidential_view"

  Scenario: [Sucesso] Reverter o sigilo
    Given que o processo "0012/2026" está com "isBudgetConfidential" igual a verdadeiro e "version" igual a "2"
    When "Carla" desativar "Orçamento sigiloso" com "If-Match" igual a "2"
    Then o processo deve ter "isBudgetConfidential" igual a falso
    When "Hugo" consultar o processo
    Then o campo "estimatedValue" deve mostrar "150000.00" sem máscara

  Scenario: [Validação] Corpo sem o campo isBudgetConfidential
    When "Carla" enviar PUT para a confidencialidade sem o campo "isBudgetConfidential"
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "isBudgetConfidential"
    And o sigilo do processo não deve ser alterado

  Scenario: [Permissão] Usuário sem PROCESS_SET_CONFIDENTIAL_BUDGET
    When "Hugo" enviar PUT para a confidencialidade do processo "0012/2026"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "PROCESS_SET_CONFIDENTIAL_BUDGET"

  Scenario: [Tenant incorreto] Processo de outro tenant
    Given que o processo "0099/2026" pertence ao tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", enviar PUT para a confidencialidade do processo "0099/2026"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"
    And a resposta não deve revelar que o processo existe em outro tenant

  Scenario: [Duplicidade] Reenvio da mesma alteração com o If-Match desatualizado
    Given que "Carla" ativou o sigilo e o processo está em "version" igual a "2"
    When "Carla" reenviar a mesma requisição de ativação com "If-Match" igual a "1", por não ter recebido a resposta anterior a tempo
    Then a API deve responder 412 com código "VERSION_CONFLICT" e "currentVersion" igual a "2"
    And o estado do sigilo não deve mudar novamente nem gerar novo evento

  Scenario: [Concorrência] Duas alterações simultâneas do mesmo processo
    Given que "Carla" e "Breno" têm "PROCESS_SET_CONFIDENTIAL_BUDGET" e ambos carregaram o processo em "version" igual a "1"
    When ambos enviarem PUT para a confidencialidade quase ao mesmo tempo, cada um com "If-Match" igual a "1"
    Then exatamente um deve responder 200 e avançar para "version" igual a "2"
    And o outro deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao alterar o sigilo
    Given que o banco de dados fica indisponível durante a transação
    When "Carla" ativar "Orçamento sigiloso"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o campo "isBudgetConfidential" não deve ser alterado

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Carla" ativar "Orçamento sigiloso"
    Then a alteração deve ser salva e a API deve responder 200
    And o evento "ProcessConfidentialityChanged" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Campo ausente/tipo inválido | 422 | `VALIDATION_ERROR` | "Informe se o orçamento é sigiloso." | Mantém o estado anterior do interruptor |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Não foi possível confirmar a versão do processo." | Recarrega o processo |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Este processo foi alterado por outra pessoa. Recarregue e tente novamente." | Recarrega e mantém a intenção do usuário |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para definir o sigilo deste processo." | Interruptor desabilitado |
| Processo inexistente/outro tenant/não visível | 404 | `PROCESS_NOT_FOUND` | — | Página 404 (SCR-111) |
| Sessão expirada | 401 | `SESSION_EXPIRED` | "Sua sessão expirou. Entre novamente para continuar." | Redireciona ao login |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém estado anterior; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Mantém estado anterior |

## Dependências
- **Stories:** US-001 (processo e `estimatedValue`), US-097 (permissões e escopos). Indiretas: US-004 (painel onde o controle aparece), US-005 (edição do valor estimado), US-006 (itens com `referenceUnitPrice`) e as stories de pesquisa de preços, ETP e TR (outros épicos), que aplicam a mesma máscara aos próprios campos de valor.
- **Decisões/ADRs:** DEC-030, DEC-024, DEC-055, DEC-104.
- **Configurações:** `security.mfaPolicy` (define se a MFA é exigida — POL-14).
- **Lacunas nas fontes canônicas:** não há tela (`SCR-NNN`) própria para o diálogo de confirmação de sigilo no inventário (`mvp-01/features.md`, Apêndice A, só lista `SCR-112`, `SCR-113` e `SCR-116` na faixa de diálogos do processo); usei `SCR-006` (onde o controle vive, no cabeçalho/"Mais informações") e registro a lacuna — proposta: o time de produto definir um novo identificador de tela quando quiser destacar esse diálogo à parte.

## Impacto técnico
- Não cria tabela nova; usa a coluna já existente `Process.isBudgetConfidential` (entities.md §4) e o enum `Confidentiality` de `Document`.
- A máscara (`ConfidentialFieldsInterceptor`) é um componente transversal usado por esta e por outras stories (itens, pesquisa, ETP, TR); esta story é dona apenas do comando que liga/desliga a flag e da cascata para documentos de pesquisa — o interceptor central deve ser compartilhado, não duplicado por módulo.
- `process.confidential_view` exige um controle de "1× por sessão/processo" (ex.: chave Redis com TTL da sessão) para não poluir a auditoria a cada `GET`.

## Backend
- **Módulo(s):** `process` (dono da flag), `document` (cascata de `confidentiality` na pesquisa de preços), `access` (`ConfidentialFieldsInterceptor`, `AuthorizationService`), `platform` (`OutboxWriter`).
- **Casos de uso:** `SetProcessConfidentialityCommand` → `SetProcessConfidentialityHandler`.
- **Domínio:** `Process.setBudgetConfidential(flag)` (RN-PROC-137..139, emite `ProcessConfidentialityChanged`); `ConfidentialFieldsInterceptor` aplicado na serialização de `Process`, `ProcessItem`, `PriceResearch`, `Etp`, `TermOfReference`.
- **Integrações internas:** `access.AuthorizationService.assertCan('PROCESS_SET_CONFIDENTIAL_BUDGET', { processId })`; `document` para atualizar `confidentiality` dos documentos de pesquisa.
- **Transação:** passo 4 do fluxo principal em uma transação única; `version` incrementado; auditoria e outbox na mesma transação.

## Frontend
- **Tela(s):** SCR-006 (cabeçalho/"Mais informações" do painel do processo).
- **Componentes:** `ConfidentialBudgetToggle`, `ConfirmConfidentialityDialog`, selo "Orçamento sigiloso" reutilizado em listas e exportações.
- **Estados:** loading no interruptor durante a chamada; erro mantém o estado anterior com toast; selo "Sigiloso" visível onde quer que o valor apareça mascarado.
- **Acessibilidade e responsividade:** interruptor com rótulo e descrição associados (`aria-describedby` explicando o efeito); diálogo de confirmação navegável por teclado; selo com contraste AA e texto (não só cor).

## Banco de dados
- **Tabelas:** `processes` (coluna `is_budget_confidential`, já existente), `documents` (coluna `confidentiality`, já existente).
- **Migrações:** nenhuma nova.
- **Índices/constraints relevantes:** nenhum específico desta story (reaproveita `UNIQUE (tenant_id, code)` e o controle de `version` do processo — DEC-055).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-33 | PUT | `/api/v1/processes/{id}/confidentiality` | `{ isBudgetConfidential: boolean }` + `If-Match` | `200 { data: Process }` com `isBudgetConfidential`, `version` novo | 200, 401, 403, 404, 412, 422, 428, 429, 500, 503 |

## Logs
- `info` `process.confidentiality_changed` — `processId`, `isBudgetConfidential`, `correlationId`.
- `info` `process.confidential_view` — primeira leitura do valor real na sessão (sem o valor em si).
- `error` `process.confidentiality_change_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** o valor estimado em si, em nenhum nível (inclusive `debug`).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.confidentiality_change` | `DATA_CHANGE` | Commit da ativação/desativação | `changes`: `isBudgetConfidential` (de/para). `metadata`: `version` |
| `process.confidential_view` | `ACCESS` | 1ª leitura do valor real por sessão/processo | `metadata`: `processId` (sem o valor) |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `metadata`: `reasonCode = PROCESS_SET_CONFIDENTIAL_BUDGET` |

## Testes necessários
- **Unitários:** `Process.setBudgetConfidential` (RN-PROC-137..139); `ConfidentialFieldsInterceptor` (mascaramento e des-mascaramento).
- **Integração (Testcontainers):** cascata para documentos de pesquisa de preços; `process.confidential_view` registrado 1× por sessão; RLS por tenant.
- **API/contrato:** `estimatedValue`/`estimatedValueMasked` sempre presentes (nunca omitidos) conforme api.md §1.4.
- **RBAC e multi-tenant:** matriz de perfis para `PROCESS_SET_CONFIDENTIAL_BUDGET` e `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (inclui `CONTROLE_INTERNO`/`AUDITOR` vendo mesmo sigiloso); custodiante vendo sem a permissão.
- **Concorrência:** duas alterações simultâneas com o mesmo `If-Match` → uma 200, outra 412.
- **E2E (Playwright):** ativar, confirmar máscara para quem não tem permissão, desativar, confirmar reversão.
- **Acessibilidade/performance:** axe no diálogo de confirmação; latência da leitura mascarada igual à leitura normal.

## Definition of Done
- [ ] Cenários Gherkin automatizados (API + E2E) passando no CI
- [ ] `PROCESS_SET_CONFIDENTIAL_BUDGET` e `PROCESS_VIEW_CONFIDENTIAL_BUDGET` aplicados; interruptor oculto/desabilitado sem permissão
- [ ] `ConfidentialFieldsInterceptor` cobrindo processo, itens, pesquisa, ETP e TR verificado em teste
- [ ] `If-Match`/`VERSION_CONFLICT` comprovado por teste de concorrência
- [ ] Auditoria `process.confidentiality_change` e `process.confidential_view` verificadas em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-33 compatível com api.md
- [ ] Logs sem o valor estimado em nenhum nível
- [ ] Revisão de código e de segurança aprovadas (ação sensível — art. 24)

## Estimativa
**M** — a flag e a política de máscara central (POL-09/DEC-030) já estão definidas nas fontes canônicas; o esforço desta story é o comando de ativação/desativação, a cascata para documentos de pesquisa e a auditoria de visualização, sem novo agregado, migração ou tela própria.

## Prioridade
**P1** — importante para conformidade legal (art. 24) em contratações sensíveis, mas não bloqueia a criação nem a tramitação do processo, que seguem com o orçamento público por padrão.

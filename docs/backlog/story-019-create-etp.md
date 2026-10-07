---
id: US-019
title: "Criar ETP a partir de template com importação do DFD"
epic: EP-003
feature: FT-011
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-014, US-065, US-110]
modules: [etp, document, process, access, audit, platform]
screens: [SCR-008]
endpoints: [ETP-01, ETP-02, DOC-01, DOC-03]
permissions: [ETP_CREATE]
events: [ETPCreated]
---

# US-019 — Criar ETP a partir de template com importação do DFD

## Título
Criar ETP a partir de template com importação do DFD

## Descrição
**Como** integrante da equipe de planejamento da contratação, **quero** criar o Estudo Técnico Preliminar (ETP) do processo a partir do template vigente, podendo importar os dados já levantados no Documento de Formalização da Demanda (DFD), **para** iniciar o ETP sem retrabalho e com os 16 elementos do art. 18, §1º, da Lei 14.133/2021 organizados desde o primeiro instante.

A criação ocorre a partir do painel de documentos do processo (SCR-006) ou diretamente na tela do ETP (SCR-008). O sistema cria o documento ETP (`kind = STRUCTURED`, tipo semeado `ETP`) vinculado ao template publicado vigente, com as 16 seções na situação `EMPTY` (ou `FILLED`, quando houver `defaultContent` resolvido a partir de variáveis do processo). Quando o usuário opta por importar do DFD, o sistema copia a descrição da necessidade, os itens e a situação no PCA do DFD mais recente em status finalizado/aprovado, registrando a origem (`importedFromDfdVersionId`). O ETP nasce em `DRAFT`, sob custódia do criador (padrão), pronto para ser editado seção a seção (US-020).

## Contexto
- Base legal: art. 6º, XX, e art. 18, §1º, I a XIII, e §2º, da Lei 14.133/2021; a IN SEGES/ME 58/2022 detalha o conteúdo de cada elemento. O ETP tem 16 seções, cada uma com uma exigência configurável (`REQUIRED`, `REQUIRED_OR_JUSTIFY`, `OPTIONAL`), semeada por configuração (DEC-016) e não fixada em código.
- O DFD (US-014) é o primeiro artefato do processo; na prática dos órgãos o ETP é elaborado a partir dele — por isso a importação evita redigitar objeto, justificativa, itens e situação no PCA já levantados.
- Modelo documental híbrido (DEC-017/ADR-006): o ETP tem cabeçalho tipado 1:1 (`Etp`) e seções narrativas (`Document.draftContent`, TipTap JSON); itens ficam em `DocumentItem`, referenciando o `ProcessItem` canônico (DEC-019) — a importação não duplica o item, apenas cria a linha do item no ETP.
- Documento é artefato do processo (DEC-010); ciclo de vida único (DEC-018) com `DRAFT` inicial. A conclusão formal do ETP (validação de completude e finalização via DOC-10) é tratada na US-023, fora do escopo desta story.

## Objetivo
Permitir que um usuário autorizado crie o ETP do processo em menos de 1 minuto, com as 16 seções do template corretamente configuradas e, quando aplicável, os dados do DFD (necessidade, itens e PCA) já aproveitados sem digitação manual — reduzindo o tempo de abertura do estudo e eliminando divergências entre DFD e ETP na origem.

## Persona
- **Principal:** Equipe de planejamento da contratação (perfil `PLANEJAMENTO`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`); área requisitante (`REQUISITANTE`) quando acumula a redação do estudo.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE`.
- Usuário possui `ETP_CREATE` em escopo que cubra a unidade atual do processo (POL-02).
- Processo existe, é visível ao usuário (DEC-024) e está em status `DRAFT`, `IN_PROGRESS` ou `RETURNED`.
- Tipo de documento `ETP` está habilitado na etapa atual do processo (`WorkflowStage.documentTypeCodes` vazio ou contendo `ETP`).
- Não existe outro ETP ativo (não cancelado) no processo.
- Existe uma versão publicada do template do tipo `ETP` no tenant (configuração semeada — US-110).
- Para importar do DFD: existe um DFD do processo (não cancelado) em status `FINALIZED` ou `APPROVED` (US-014/US-065).

## Fluxo principal
1. No painel do processo (SCR-006) ou na lista de documentos, o usuário aciona **"Criar ETP"**.
2. O sistema consulta `ETP-01` para confirmar que não há ETP ativo e `DOC-01` para localizar um DFD elegível para importação; se houver, exibe o cartão "Importar dados do DFD 0005/2026?" com objeto, nº de itens e situação no PCA do DFD (via `DOC-03`), pré-selecionado.
3. O usuário mantém a importação marcada (ou desmarca, se preferir começar em branco) e clica em **"Criar ETP"**.
4. O front envia `POST /api/v1/processes/{id}/etps` (`ETP-02`) com `{ importFromDfd: true|false }` e `Idempotency-Key` (gerada uma vez por interação), desabilitando o botão e exibindo "Criando ETP…".
5. A API, em uma transação com `app.tenant_id` definido:
   1. autoriza `ETP_CREATE` + POL-02 (custódia/participação, status do processo, tipo permitido na etapa);
   2. verifica que não existe ETP ativo no processo (singleton) → senão, `DOCUMENT_ALREADY_EXISTS`;
   3. carrega a versão publicada vigente do template `ETP` do tenant e resolve `defaultContent` das 16 seções (variáveis do processo);
   4. cria `Document` (`documentTypeId` do tipo ETP, `status = DRAFT`, `kind = STRUCTURED`, `confidentiality` do tipo, `responsibleId = createdById`, `singletonKey = documentTypeId`) e o cabeçalho `Etp` (`conclusion = PENDING`);
   5. se `importFromDfd = true`: localiza o DFD elegível do processo (`FINALIZED`/`APPROVED`, não cancelado), usa `approvedVersionId` quando existir, senão `currentVersionId`; copia objeto/justificativa para a seção `NEED_DESCRIPTION` (estado `FILLED`), copia a situação no PCA do processo para `PCA_ALIGNMENT`, cria um `DocumentItem` no ETP para cada item do DFD (mesmo `processItemId`, mesma `quantity`) e grava `importedFromDfdVersionId`;
   6. grava `AuditLog` `document.create` e o evento `DocumentCreated` (especializado como `ETPCreated`) no outbox;
   7. confirma a transação.
6. A API responde **201** com o ETP criado, `Location: /api/v1/etps/{id}` e `ETag: "1"`.
7. O front invalida a lista de documentos do processo e navega para **SCR-008** (`/processos/[id]/etp/[etpId]`), abrindo a primeira seção pendente.

## Fluxos alternativos
- **FA-01 — Criar sem importação:** com `importFromDfd = false` (ou sem DFD elegível), todas as seções nascem conforme `defaultContent` do template, sem dados do DFD; `importedFromDfdVersionId` fica nulo.
- **FA-02 — Nenhum DFD elegível:** quando não há DFD, ou o único existente está `DRAFT`/`RETURNED`/`CANCELED`, a opção de importação não é exibida; a API rejeita `importFromDfd: true` nesse caso (ver V-04).
- **FA-03 — ETP já existe:** o botão "Criar ETP" não é exibido quando já há um ETP ativo; a lista de documentos oferece "Abrir ETP" no lugar.
- **FA-04 — Reenvio após falha de rede:** o front reenvia com a mesma `Idempotency-Key`; a API devolve a resposta original (`Idempotent-Replayed: true`) e nenhum ETP duplicado é criado.
- **FA-05 — Tipo ETP não permitido na etapa atual:** o botão "Criar ETP" fica desabilitado com a dica "Este documento não é permitido na etapa atual"; tentativa via API responde `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`.

## Regras de negócio
- **RN-ETP-01** — O ETP é um `Document` do tipo semeado `ETP` (`kind = STRUCTURED`), único ativo por processo (`singletonKey = documentTypeId`; índice único por `(tenant_id, process_id, singleton_key)` entre documentos não cancelados).
- **RN-ETP-02** — O template vigente define as 16 seções (`NEED_DESCRIPTION`, `PROBLEM`, `OBJECTIVE`, `PCA_ALIGNMENT`, `REQUIREMENTS`, `MARKET_SURVEY`, `ALTERNATIVES`, `ESTIMATES`, `RECOMMENDED_SOLUTION`, `PARCELING`, `RELATED_CONTRACTS`, `EXPECTED_RESULTS`, `ENVIRONMENTAL_IMPACTS`, `PRIOR_MEASURES`, `RISKS`, `CONCLUSION`) com `requirement` semeado por configuração (DEC-016): `REQUIRED` em `NEED_DESCRIPTION`, `ESTIMATES`, `PARCELING`, `CONCLUSION`; `REQUIRED_OR_JUSTIFY` em `PCA_ALIGNMENT`, `REQUIREMENTS`, `MARKET_SURVEY`, `ALTERNATIVES`, `RECOMMENDED_SOLUTION`, `EXPECTED_RESULTS`, `PRIOR_MEASURES`, `RELATED_CONTRACTS`, `ENVIRONMENTAL_IMPACTS`, `RISKS`; `OPTIONAL` em `PROBLEM`, `OBJECTIVE`. Alterar essa configuração não afeta ETPs já criados.
- **RN-ETP-03** — Sem importação, cada seção nasce no estado `EMPTY`, exceto quando o template define `defaultContent` (variáveis `{{...}}` do processo resolvidas na criação), hipótese em que nasce `FILLED`.
- **RN-ETP-04** — A importação do DFD (`importFromDfd = true`) só é aceita quando existe, no processo, um DFD não cancelado em status `FINALIZED` ou `APPROVED`; a versão de origem é a `approvedVersionId` do DFD quando existir, senão a `currentVersionId`.
- **RN-ETP-05** — Efeitos da importação: o objeto/justificativa da necessidade do DFD preenche a seção `NEED_DESCRIPTION` (`FILLED`); a situação no PCA do processo preenche `PCA_ALIGNMENT` (`FILLED`); `Etp.importedFromDfdVersionId` recebe o id da versão de origem. As demais seções seguem a RN-ETP-03.
- **RN-ETP-06** — Cada item do DFD gera um `DocumentItem` no ETP referenciando o mesmo `processItemId` (DEC-019), com a mesma `quantity`; a memória de cálculo (`calculationMemo`) nasce vazia (preenchida na US-022). Itens do ETP nunca duplicam o `ProcessItem`.
- **RN-ETP-07** — Permissão `ETP_CREATE` + POL-02: custódia atual do processo ou participação `COLLABORATOR`/`CONSULTANT`, processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`, tipo `ETP` permitido na etapa atual.
- **RN-ETP-08** — `responsibleId` do ETP é o criador por padrão; `confidentiality` inicial é a do tipo `ETP` (torna-se `RESTRICTED` apenas quando houver valor sigiloso — DEC-030, aplicável a partir da US-022).
- **RN-ETP-09** — Toda a criação (documento, cabeçalho `Etp`, itens importados, auditoria, evento) ocorre em uma única transação; qualquer falha desfaz tudo.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Importar dados do DFD | `importFromDfd` | booleano | Não | só `true` quando há DFD elegível (RN-ETP-04) | `true` quando há DFD elegível; senão `false` |
| *(sistema)* Documento | `documentId`, `code`, `title`, `status` | — | — | RN-ETP-01 | gerados |
| *(sistema)* Conclusão | `conclusion` | enum (`EtpConclusion`) | — | — | `PENDING` |
| *(sistema)* Origem da importação | `importedFromDfdVersionId` | uuid | — | RN-ETP-04/05 | gerado quando importa |
| *(sistema)* Responsável | `responsibleId` | uuid | — | RN-ETP-08 | criador |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Já existe ETP ativo no processo | API | "Este processo já tem um ETP. Abra o estudo existente." | `DOCUMENT_ALREADY_EXISTS` |
| V-02 | Sem permissão/escopo ou etapa não permite o tipo | API | "Você não pode criar o ETP neste processo." / "Este documento não é permitido na etapa atual." | `PERMISSION_DENIED` / `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-03 | Processo em status não editável | API | "O processo não está em um status que permita criar documentos." | `DOCUMENT_NOT_EDITABLE` |
| V-04 | `importFromDfd = true` sem DFD elegível | API | "Não há um DFD finalizado neste processo para importar." | `VALIDATION_ERROR` (`NOT_ALLOWED` no campo `importFromDfd`) |
| V-05 | Mesma `Idempotency-Key` com corpo diferente | API | "Esta solicitação já foi enviada com outros dados. Recarregue a página." | `IDEMPOTENCY_KEY_REUSED` |

## Permissões
- **Permissão:** `ETP_CREATE` com escopo que cubra a unidade atual do processo.
- **Políticas:** POL-02 (edição de documento, aplicada também à criação: custódia/participação + status do processo + tipo permitido na etapa).
- **MFA:** não exigido (`ETP_CREATE` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão "Criar ETP" não é exibido; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ETPCreated` (`DocumentCreated`) | `document.created.etp` | Commit da criação | Payload inclui `documentId`, `documentTypeCode = "ETP"`, `kind`; `sourceDocumentId` nulo (a importação copia dados, não duplica o documento) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: o ETP nasce sob custódia do próprio criador, como o processo. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Criar ETP a partir de template com importação do DFD

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And existe o processo "0012/2026" na etapa "Estudos preliminares", sob custódia do "Setor de Manutenção"
    And o usuário "Carla" tem vínculo ativo e o perfil "PLANEJAMENTO" com "ETP_CREATE" sobre o "Setor de Manutenção"
    And existe a versão publicada do template "ETP" com as 16 seções padrão

  Scenario: [Sucesso] Criar ETP importando dados do DFD finalizado
    Given que o DFD "0005/2026" do processo está "FINALIZED" com 2 itens e situação no PCA "PLANNED"
    When "Carla" criar o ETP com "Importar dados do DFD" marcado
    Then o ETP deve ser criado com status "DRAFT" e conclusão "PENDING"
    And a seção "NEED_DESCRIPTION" deve estar "FILLED" com o objeto/justificativa do DFD
    And a seção "PCA_ALIGNMENT" deve estar "FILLED" com a situação "PLANNED"
    And o ETP deve ter 2 itens, um para cada item do DFD
    And o campo "importedFromDfdVersionId" deve apontar para a versão do DFD "0005/2026"
    And deve gerar registro de auditoria "document.create"
    And deve gerar o evento "ETPCreated"
    And a API deve responder 201 com o cabeçalho "Location" e "ETag" igual a "1"

  Scenario: [Sucesso] Criar ETP sem importação
    When "Carla" criar o ETP com "Importar dados do DFD" desmarcado
    Then o ETP deve ser criado com as 16 seções no estado "EMPTY" (ou "FILLED" apenas onde houver conteúdo padrão do template)
    And o campo "importedFromDfdVersionId" deve ficar vazio

  Scenario: [Validação] Importação solicitada sem DFD elegível
    Given que o processo não possui nenhum DFD finalizado ou aprovado
    When a API receber "POST /api/v1/processes/{id}/etps" com "importFromDfd" igual a verdadeiro
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" no campo "importFromDfd"
    And nenhum ETP deve ser criado

  Scenario: [Permissão] Usuário sem ETP_CREATE
    Given que o usuário "Bruno" possui apenas o perfil "SOMENTE_LEITURA"
    When "Bruno" acessar o painel do processo "0012/2026"
    Then o botão "Criar ETP" não deve ser exibido
    When "Bruno" enviar "POST /api/v1/processes/{id}/etps"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "ETP_CREATE"

  Scenario: [Tenant incorreto] Processo de outro tenant
    Given que o processo "0099/2026" pertence ao tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", enviar "POST /api/v1/processes/0099.../etps"
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser lido ou alterado

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Carla" criou o ETP com a chave de idempotência "K1" e recebeu 201
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com o mesmo ETP e o cabeçalho "Idempotent-Replayed: true"
    And deve existir apenas um ETP no processo

  Scenario: [Concorrência] Duas criações simultâneas no mesmo processo
    Given que o processo "0012/2026" ainda não tem ETP
    When duas requisições válidas de criação do ETP chegarem simultaneamente
    Then exatamente uma deve responder 201
    And a outra deve responder 409 com código "DOCUMENT_ALREADY_EXISTS"
    And deve existir exatamente um ETP no processo

  Scenario: [Falha de banco] Banco indisponível durante a criação
    Given que o banco de dados fica indisponível durante a transação de criação do ETP
    When "Carla" clicar em "Criar ETP"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhum documento, item ou auditoria deve ser persistido

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox e a fila "domain-events" estão indisponíveis
    When "Carla" criar o ETP com sucesso
    Then a API deve responder 201
    And o evento "ETPCreated" deve permanecer com status "PENDING" no outbox
    And quando o relay voltar o evento deve ser publicado uma única vez
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| ETP já existe | 409 | `DOCUMENT_ALREADY_EXISTS` | "Este processo já tem um ETP. Abra o estudo existente." | Substitui "Criar ETP" por "Abrir ETP" |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não pode criar o ETP neste processo." | Oculta/desabilita o botão |
| Tipo não permitido na etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "Este documento não é permitido na etapa atual." | Botão desabilitado com dica |
| Processo não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "O processo não está em um status que permita criar documentos." | Botão oculto |
| Importação sem DFD elegível | 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`) | "Não há um DFD finalizado neste processo para importar." | Desmarca e desabilita a opção de importação |
| Recurso de outro tenant/não visível | 404 | `NOT_FOUND` | "Processo não encontrado." | Redireciona à lista |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta solicitação já foi enviada com outros dados." | Gera nova chave |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível criar o ETP agora. Tente novamente em instantes." | Botão "Tentar novamente"; exibe correlationId |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-014 (DFD — fonte da importação), US-065 (ciclo de vida genérico do documento: finalizar/submeter, usado para o DFD atingir status elegível), US-110 (provisionamento/semeadura do template ETP e configurações do tenant). Indireta: US-020 (edição das seções criadas aqui).
- **Decisões/ADRs:** DEC-010, DEC-016, DEC-017, DEC-018, DEC-019, DEC-030; ADR-006.
- **Configurações:** semeadura do template `ETP` e de `SectionDefinition.requirement` por seção (DEC-016).
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Reaproveita o padrão de comando transacional já estabelecido para documentos (validação → autorização POL-02 → domínio → repositórios → auditoria → outbox) — não introduz um novo padrão, apenas o aplica ao tipo `ETP`.
- A cópia de itens do DFD é uma leitura seguida de inserção dentro da mesma transação, sem acoplamento ao módulo do DFD além da leitura do cabeçalho/itens via repositório genérico de `document`; evita duplicar `ProcessItem` (DEC-019).
- A criação não é concorrida como a numeração de processos; o único ponto de contenção é o índice único de singleton por processo, que resolve a corrida da criação simultânea (cenário de Concorrência).

## Backend
- **Módulo(s):** `etp` (dono do cabeçalho `Etp`); usa `document` (ciclo de vida genérico, templates, `DocumentItem`), `process` (visibilidade, status), `access` (`AuthorizationService`, POL-02), `audit`, `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `CreateEtpCommand` → `CreateEtpHandler`.
- **Domínio:** `Etp.create(props)` (fábrica que aplica RN-ETP-01..06); `Document.createStructured(typeCode, templateVersion)`; `DocumentItem.fromDfdItem(...)` quando importa.
- **Integrações internas:** `document.TemplateFacade.getPublishedVersion('ETP')`, `document.DocumentRepository.findEligibleDfd(processId)`.
- **Transação:** passos 5.1–5.7 do fluxo principal em uma transação interativa Prisma com `app.tenant_id`.

## Frontend
- **Tela(s):** painel do processo (SCR-006) e SCR-008 (`/processos/[id]/etp/[etpId]`).
- **Componentes:** `CreateEtpButton`, `ImportFromDfdCard` (preview do DFD elegível), `useMutation(createEtp)` com `Idempotency-Key` gerada por interação.
- **Estados:** loading (skeleton no cartão de importação), vazio (sem DFD elegível — cartão oculto), erro (toast com mensagem de V-04/`DOCUMENT_ALREADY_EXISTS`), sucesso (navegação para SCR-008).
- **Acessibilidade e responsividade:** foco no título da tela ao navegar para o ETP; `aria-live` para o toast de erro; botão principal com estado de carregamento; layout em coluna única < 768 px.

## Banco de dados
- **Tabelas:** `documents`, `etps`, `document_items`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma nova (usa tabelas e colunas de entities.md §4, incluindo `etps.imported_from_dfd_version_id`).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, document_id)` em `etps`; `UNIQUE (tenant_id, process_id, singleton_key) WHERE status <> 'CANCELED' AND deleted_at IS NULL` em `documents`; `UNIQUE (tenant_id, document_id, process_item_id)` em `document_items`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| ETP-02 | POST | `/api/v1/processes/{id}/etps` | `{ importFromDfd?: boolean }` + `Idempotency-Key` | `201 { data: Etp }` com `id`, `documentId`, `code`, `status`, `conclusion`, `importedFromDfdVersionId`, `version` | 201, 401, 403, 404, 409, 422, 429, 500, 503 |
| ETP-01 | GET | `/api/v1/processes/{id}/etps` | — | `200 { data: [Etp] }` (0 ou 1 item, singleton) | 200, 403, 404 |
| DOC-01 | GET | `/api/v1/processes/{id}/documents` | `?typeCode=DFD` | `200 { data: [Document] }` para localizar o DFD elegível | 200, 403, 404 |
| DOC-03 | GET | `/api/v1/documents/{id}` | — | `200 { data: Document }` (preview do DFD: objeto, itens, PCA) | 200, 403, 404 |

## Logs
- `info` `document.created` — `documentId`, `documentTypeCode = "ETP"`, `importedFromDfd` (booleano), `durationMs`, `tenantId`, `userId`, `correlationId`.
- `warn` `idempotency.store_unavailable` — quando o Redis falhar.
- `error` `document.create_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** objeto, descrição, conteúdo das seções, valores estimados.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.create` | `DATA_CHANGE` | Commit da criação | `changes`: `documentTypeCode`, `importedFromDfdVersionId`. `metadata`: `code`, `idempotencyKey` |
| `access.denied` | `ACCESS` | Tentativa sem permissão/escopo | `reasonCode = ETP_CREATE` |

## Testes necessários
- **Unitários:** fábrica `Etp.create` (RN-ETP-01..06); resolução de `defaultContent`; cópia de itens do DFD.
- **Integração (Testcontainers):** atomicidade da criação com importação; singleton impede segundo ETP; RLS impede leitura do DFD de outro tenant.
- **API/contrato:** respostas e erros conforme api.md; cabeçalhos `Location`, `ETag`, `Idempotent-Replayed`.
- **RBAC e multi-tenant:** matriz de perfis × escopos; processo de outro tenant → 404.
- **Concorrência:** duas criações simultâneas no mesmo processo → uma 201, outra `DOCUMENT_ALREADY_EXISTS`.
- **E2E (Playwright):** criar com e sem importação; abrir ETP existente em vez de criar novo.
- **Acessibilidade/performance:** axe sem violações sérias no cartão de importação.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] `ETP_CREATE` + POL-02 aplicados na API; botão oculto/desabilitado conforme regras
- [ ] Singleton e importação cobertos por teste de concorrência e de atomicidade
- [ ] Auditoria `document.create` e evento `ETPCreated` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de ETP-01, ETP-02, DOC-01, DOC-03 compatível com api.md
- [ ] Logs sem dados sensíveis
- [ ] Acessibilidade (axe) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — reaproveita o padrão transacional de documentos já estabelecido; a complexidade adicional está na cópia controlada de dados do DFD (necessidade, itens, PCA) e na checagem de elegibilidade, sem novos padrões transversais.

## Prioridade
**P0** — o ETP é pré-requisito legal (art. 18) para seguir a fase preparatória; sem ele, nenhuma outra story do épico (seções, alternativas, estimativas, validação) pode avançar.

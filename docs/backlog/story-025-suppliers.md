---
id: US-025
title: "Cadastrar e manter fornecedores"
epic: EP-004
feature: FT-016
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-097, US-100]
modules: [supplier, access, audit, platform]
screens: [SCR-107]
endpoints: [SUP-01, SUP-02, SUP-03, SUP-04, SUP-05, SUP-06]
permissions: [SUPPLIER_VIEW, SUPPLIER_MANAGE]
events: [SupplierCreated, SupplierUpdated]
---

# US-025 — Cadastrar e manter fornecedores

## Título
Cadastrar e manter fornecedores

## Descrição
**Como** servidor do setor de Compras (ou gestor de contratações), **quero** manter um cadastro único de fornecedores do órgão — com CNPJ (numérico ou alfanumérico) ou CPF validado e deduplicado —, **para** reutilizar os mesmos fornecedores em pesquisas de preços e demais processos, sem redigitar nem duplicar dados a cada contratação.

O cadastro de fornecedores é um recurso do tenant, independente de processo (DEC-010): existe uma tela própria (SCR-107) e qualquer pesquisa de preços (US-026) referencia fornecedores já cadastrados por `documentNumber`. O sistema valida o dígito verificador conforme o tipo de documento — incluindo o CNPJ alfanumérico da IN RFB 2.229/2024 —, impede duplicidade por tenant, criptografa e mascara o CPF, e só permite exclusão quando o fornecedor não estiver em uso.

## Contexto
- Hoje os fornecedores são recadastrados a cada pesquisa de preços (em planilhas ou formulários avulsos), o que gera divergência de nome/contato e nenhuma reutilização de histórico.
- A partir de 2026, a Receita Federal (IN RFB 2.229/2024) passou a emitir CNPJ alfanumérico (12 caracteres `[0-9A-Z]` + 2 dígitos verificadores); o sistema precisa aceitar ambos os formatos desde o MVP 1.
- Fornecedor é uma das exceções de DEC-010 (cadastro do tenant, sem `processId`); é referenciado por `PriceSource` (US-026) como fonte de pesquisa direta (art. 23, §1º, IV da Lei 14.133/2021).
- CPF é dado pessoal sensível (DEC-086): criptografado em repouso e mascarado nas respostas da API; a busca/deduplicação usa *blind index* (HMAC) em vez do valor em claro.

## Objetivo
Permitir que qualquer usuário autorizado cadastre um fornecedor válido (CNPJ numérico, alfanumérico ou CPF) em menos de 1 minuto, com 100% dos cadastros deduplicados por documento no tenant e 0% de CPF exposto em claro pela API.

## Persona
- **Principal:** Setor de Compras (perfil `COMPRAS`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), Planejamento (`PLANEJAMENTO`).

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE`.
- Usuário possui `SUPPLIER_VIEW` (para consultar) ou `SUPPLIER_MANAGE` (para criar/editar/excluir).

## Fluxo principal
1. O usuário acessa **"Fornecedores"** (SCR-107, `/fornecedores`) e clica em **"Novo fornecedor"**.
2. O sistema abre o formulário com **Tipo de documento** (CNPJ, CPF ou Estrangeiro), **Número do documento**, **Razão social**, e os campos opcionais (Nome fantasia, E-mail, Telefone, Website, Contato, Endereço, Observações).
3. O usuário escolhe o tipo, informa o número — a interface aplica a máscara correspondente (CNPJ numérico `00.000.000/0000-00`; CNPJ alfanumérico sem máscara, só agrupamento visual; CPF `000.000.000-00`) — e preenche a Razão social.
4. Ao sair do campo, o front valida o dígito verificador localmente (RN-PRICE-15/16) e consulta `SUP-06` (lookup) para alertar antecipadamente sobre duplicidade.
5. O usuário clica em **"Salvar"**. O front envia `POST /api/v1/suppliers` (`SUP-02`) com `Idempotency-Key`.
6. A API valida o corpo, normaliza e valida o dígito verificador do documento, cuidando de CPF (criptografa e gera hash) ou CNPJ (mantém em claro e gera hash), verifica duplicidade por `(tenantId, documentType, documentNumberHash)` e grava o `Supplier`, o evento `SupplierCreated` e a auditoria `supplier.create`.
7. A API responde **201** com o fornecedor (CPF já mascarado) e `ETag: "1"`; o front fecha o formulário, mostra o toast "Fornecedor cadastrado" e atualiza a lista.

## Fluxos alternativos
- **FA-01 — Editar fornecedor:** a partir da lista/detalhe, "Editar" abre o mesmo formulário preenchido; `PATCH /api/v1/suppliers/{id}` (`SUP-04`) com `If-Match`; documento (tipo/número) **não** é editável após criado (RN-PRICE-14) — para corrigir um documento errado, cadastre um novo fornecedor e inative/exclua o antigo.
- **FA-02 — Inativar fornecedor:** alternar **"Ativo"** para desligado via `SUP-04`; o fornecedor some das seleções de nova fonte de pesquisa, mas permanece no histórico de pesquisas já concluídas.
- **FA-03 — Excluir fornecedor sem uso:** "Excluir" em um fornecedor nunca referenciado por `PriceSource` executa `DELETE /api/v1/suppliers/{id}` (`SUP-05`, exclusão lógica); com confirmação por diálogo.
- **FA-04 — Tentar excluir fornecedor em uso:** o botão "Excluir" fica desabilitado com dica "Fornecedor usado em pesquisas de preço"; se chamado diretamente, a API responde `SUPPLIER_IN_USE` (409).
- **FA-05 — Fornecedor estrangeiro:** tipo "Estrangeiro" aceita número livre (até 20 caracteres), sem validação de dígito verificador e sem criptografia.
- **FA-06 — Busca por documento:** `GET /api/v1/suppliers/lookup?documentNumber=` (`SUP-06`) normaliza o número recebido e retorna o fornecedor pelo *blind index*, usado pela pré-validação do formulário e pela seleção de fornecedor em `PriceSource` (US-026).

## Regras de negócio
- **RN-PRICE-14** — Obrigatórios: `documentType`, `documentNumber`, `legalName`; demais campos opcionais. `documentType`/`documentNumber` são imutáveis após a criação.
- **RN-PRICE-15** — CNPJ numérico: 14 dígitos com dígitos verificadores pelo algoritmo padrão (pesos 5,4,3,2,9,8,7,6,5,4,3,2 e 6,5,4,3,2,9,8,7,6,5,4,3,2, módulo 11, resto < 2 → DV 0). CNPJ alfanumérico (IN RFB 2.229/2024): 12 caracteres `[0-9A-Z]` + 2 dígitos verificadores numéricos, calculados com os mesmos pesos sobre o valor de cada caractere (código ASCII − 48; dígitos '0'–'9' valem 0–9, letras 'A'–'Z' valem 17–42) — ex.: base `12ABC34501DE` gera DV `35`, documento válido `12.ABC.345/01DE-35`. Inválido → `INVALID_CNPJ`.
- **RN-PRICE-16** — CPF: 11 dígitos com dígito verificador padrão (pesos 10..2 e 11..2, módulo 11). Armazenado criptografado (`documentNumberEncrypted`, AES-256-GCM via KMS — DEC-086); `documentNumber` sempre retornado mascarado (`***.456.789-**`); inválido → `INVALID_CPF`.
- **RN-PRICE-17** — `documentNumberHash` (HMAC do número normalizado, sem máscara/pontuação) garante a unicidade `(tenant_id, document_type, document_number_hash) WHERE deleted_at IS NULL` e é usado por `SUP-06`; duplicidade → `SUPPLIER_ALREADY_EXISTS` (409).
- **RN-PRICE-18** — `documentType = FOREIGN`: `documentNumber` livre (até 20 caracteres, trim), sem validação de dígito verificador, sem criptografia nem hash de CPF (usa o próprio valor normalizado para unicidade).
- **RN-PRICE-19** — Exclusão (`SUP-05`) é lógica (+SD) e só é permitida quando não existir nenhuma `PriceSource` não excluída referenciando o fornecedor; caso contrário, `SUPPLIER_IN_USE` (409) — reaproveitado do catálogo existente; não há código específico para "fornecedor em uso" nas fontes canônicas (ver Dependências → Lacunas).
- **RN-PRICE-20** — Inativar (`isActive = false`) é reversível, não é exclusão, e apenas remove o fornecedor das listas de seleção para novas fontes de pesquisa; fontes já criadas continuam referenciando-o normalmente.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Tipo de documento | `documentType` | seleção (`SupplierDocumentType`) | Sim | imutável após criar | — |
| Número do documento | `documentNumber` | texto | Sim | RN-PRICE-15/16/18; imutável após criar | — |
| Razão social / Nome | `legalName` | texto | Sim | 2–250 caracteres | — |
| Nome fantasia | `tradeName` | texto | Não | até 250 caracteres | — |
| E-mail | `email` | e-mail | Não | formato válido | — |
| Telefone | `phone` | texto | Não | até 20 caracteres | — |
| Website | `website` | url | Não | até 255 caracteres | — |
| Contato | `contactName` | texto | Não | até 150 caracteres | — |
| Endereço | `addressStreet`…`addressZipCode` | texto/CEP | Não | mesmos campos de Organization | — |
| Ativo | `isActive` | interruptor | Não | — | `true` |
| Observações | `notes` | texto longo | Não | até 5.000 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campos obrigatórios presentes | Front + API (Zod) | "Informe o {campo}." | `VALIDATION_ERROR` |
| V-02 | Dígito verificador de CNPJ inválido (numérico ou alfanumérico) | Front + API | "CNPJ inválido. Verifique o número digitado." | `VALIDATION_ERROR` (`INVALID_CNPJ`) |
| V-03 | Dígito verificador de CPF inválido | Front + API | "CPF inválido. Verifique o número digitado." | `VALIDATION_ERROR` (`INVALID_CPF`) |
| V-04 | Documento duplicado no tenant | API (+ índice único) | "Já existe um fornecedor cadastrado com este documento." | `SUPPLIER_ALREADY_EXISTS` |
| V-05 | `email`/`website` em formato inválido | Front + API | "Informe um {campo} válido." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-06 | Limites de tamanho (razão social, nome fantasia, observações) | Front + API | "O {campo} deve ter no máximo X caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-07 | Alterar `documentType`/`documentNumber` em edição | API | "Documento não pode ser alterado. Cadastre um novo fornecedor." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-08 | Excluir fornecedor em uso | API | "Este fornecedor está em uso em pesquisas de preço e não pode ser excluído." | `SUPPLIER_IN_USE` |

## Permissões
- **Permissão:** `SUPPLIER_VIEW` (consultar); `SUPPLIER_MANAGE` (criar, editar, inativar, excluir).
- **Políticas:** nenhuma política contextual (recurso do tenant, sem escopo por unidade/processo — DEC-010).
- **MFA:** não exigido (`SUPPLIER_MANAGE` é risco M), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** "Novo fornecedor", "Editar" e "Excluir" ficam ocultos/desabilitados sem `SUPPLIER_MANAGE`; a rota `/fornecedores` retorna SCR-111 (403) sem `SUPPLIER_VIEW`; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `SupplierCreated` | `supplier.created` | Commit da criação | `supplierId`, `documentType` |
| `SupplierUpdated` | `supplier.updated` | Commit de qualquer edição (inclui inativação) | `supplierId`, `documentType`, `changedFields[]` |

Exclusão (`SUP-05`) gera apenas auditoria (`supplier.delete`); não há evento de domínio dedicado nas fontes canônicas (ver Dependências → Lacunas).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: cadastro de apoio, sem fluxo de aprovação ou custódia. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Cadastrar e manter fornecedores

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o usuário "Carla" tem vínculo ativo e o perfil "COMPRAS" com `SUPPLIER_MANAGE`

  Scenario: [Sucesso] Cadastrar fornecedor com CNPJ numérico válido
    When "Carla" cadastrar o fornecedor "Construtora ABC Ltda" com CNPJ "11.222.333/0001-81"
    Then o fornecedor deve ser criado com "documentType" "CNPJ"
    And deve gerar o evento "SupplierCreated"
    And deve gerar registro de auditoria "supplier.create"
    And a API deve responder 201 com "ETag" igual a "1"

  Scenario: [Sucesso] Cadastrar fornecedor com CNPJ alfanumérico válido (IN RFB 2.229/2024)
    When "Carla" cadastrar um fornecedor com CNPJ "12.ABC.345/01DE-35"
    Then o fornecedor deve ser criado normalmente
    And o campo "documentNumber" deve ser retornado em claro (CNPJ não é mascarado)

  Scenario: [Sucesso] Cadastrar fornecedor pessoa física com CPF mascarado
    When "Carla" cadastrar o fornecedor "João da Silva" com CPF "111.444.777-35"
    Then o fornecedor deve ser criado com "documentType" "CPF"
    And o campo "documentNumber" retornado deve ser "***.444.777-**"
    And o número em claro não deve aparecer em nenhuma resposta da API

  Scenario: [Validação] CNPJ com dígito verificador inválido
    When "Carla" tentar cadastrar um fornecedor com CNPJ "11.222.333/0001-00"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_CNPJ" no campo "documentNumber"
    And nenhum fornecedor deve ser criado

  Scenario: [Permissão] Usuário sem SUPPLIER_MANAGE
    Given que o usuário "Bruno" possui apenas "SUPPLIER_VIEW"
    When "Bruno" enviar POST para "/api/v1/suppliers" com um corpo válido
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "SUPPLIER_MANAGE"

  Scenario: [Tenant incorreto] Lookup não revela fornecedor de outro tenant
    Given que existe um fornecedor com CNPJ "11.222.333/0001-81" no tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", consultar "SUP-06" com o mesmo CNPJ
    Then a API deve responder 200 com lista vazia
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Mesmo documento cadastrado duas vezes no tenant
    Given que já existe o fornecedor "Construtora ABC Ltda" com CNPJ "11.222.333/0001-81"
    When "Carla" tentar cadastrar outro fornecedor com o mesmo CNPJ
    Then a API deve responder 409 com código "SUPPLIER_ALREADY_EXISTS"
    And nenhum segundo fornecedor deve ser criado

  Scenario: [Concorrência] Duas criações simultâneas com o mesmo CNPJ
    When duas requisições para cadastrar o CNPJ "11.222.333/0001-81" chegarem simultaneamente
    Then exatamente uma deve responder 201
    And a outra deve responder 409 com código "SUPPLIER_ALREADY_EXISTS"
    And deve existir apenas um fornecedor com esse documento

  Scenario: [Falha de banco] Banco indisponível durante o cadastro
    Given que o banco de dados fica indisponível durante a transação de criação
    When "Carla" tentar cadastrar um fornecedor válido
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhum fornecedor deve ser persistido

  Scenario: [Falha de integração] KMS indisponível ao cadastrar fornecedor com CPF
    Given que o serviço de KMS está indisponível
    When "Carla" tentar cadastrar um fornecedor com CPF
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum CPF deve ser persistido sem criptografia
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido (schema) | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos com `errors[]` |
| CNPJ com DV inválido | 422 | `VALIDATION_ERROR` (`INVALID_CNPJ`) | "CNPJ inválido. Verifique o número digitado." | Foca o campo |
| CPF com DV inválido | 422 | `VALIDATION_ERROR` (`INVALID_CPF`) | "CPF inválido. Verifique o número digitado." | Foca o campo |
| Documento duplicado | 409 | `SUPPLIER_ALREADY_EXISTS` | "Já existe um fornecedor cadastrado com este documento." | Mostra link para o fornecedor existente |
| Alterar documento em edição | 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`) | "Documento não pode ser alterado. Cadastre um novo fornecedor." | Campo bloqueado na edição |
| Exclusão de fornecedor em uso | 409 | `SUPPLIER_IN_USE` | "Este fornecedor está em uso em pesquisas de preço e não pode ser excluído." | Oferece "Inativar" como alternativa |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerenciar fornecedores." | Oculta ações de escrita |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Este fornecedor foi alterado por outra pessoa. Recarregue os dados." | Recarrega e destaca diferenças |
| Banco/KMS indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém dados; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Mantém dados; botão copiar código |

## Dependências
- **Stories:** US-097 (autorização e escopos), US-100 (dependência indicada no backlog do épico; descrição não detalhada no pacote de contexto). US-026 consome este cadastro (fornecedor de `PriceSource`).
- **Decisões/ADRs:** DEC-010, DEC-024, DEC-086.
- **Configurações:** nenhuma específica.
- **Lacunas nas fontes canônicas:** (1) ~~código para fornecedor em uso~~ — resolvida: `SUPPLIER_IN_USE` (409) incluído em api.md §2.2. (2) a descrição de US-100 não está disponível no pacote de contexto do épico; cita-se apenas o identificador. (3) campos de endereço assumidos iguais aos de `Organization` ("como Organization" no pacote), cujas colunas exatas não constam deste pacote.

## Impacto técnico
- Primeiro cadastro do produto sem `processId` e sem escopo por unidade (DEC-010): usa só `SUPPLIER_VIEW`/`SUPPLIER_MANAGE` em nível de tenant, sem `ProcessAccess`.
- Criptografia de CPF reusa o padrão de envelope encryption (KMS) de DEC-086; qualquer novo campo sensível futuro deve seguir o mesmo par `*Encrypted` + `*Hash`.
- Validação de CNPJ alfanumérico é nova no produto (vigência 2026); deve ficar isolada em um validador único (`CnpjValidator`) reutilizável por qualquer módulo que valide CNPJ.
- Índice trigram em `legal_name`/`trade_name` sustenta a busca textual da lista (SCR-107) com custo previsível.

## Backend
- **Módulo(s):** `supplier` (dono); usa `platform` (KMS/envelope encryption, `OutboxWriter`), `access` (`AuthorizationService`), `audit` (`AuditService`).
- **Casos de uso:** `CreateSupplierCommand`/`CreateSupplierHandler`, `UpdateSupplierCommand`/`UpdateSupplierHandler`, `DeleteSupplierCommand`/`DeleteSupplierHandler`, `LookupSupplierQuery`/`LookupSupplierHandler`.
- **Domínio:** `Supplier.create(props)`; `CnpjValidator` (numérico e alfanumérico — RN-PRICE-15); `CpfValidator` (RN-PRICE-16); value object `DocumentNumber` (normalização, hash, máscara de exibição).
- **Integrações internas:** `platform.EncryptionService.encrypt/decrypt` (CPF), `platform.BlindIndexService.hash` (dedup/lookup).
- **Transação:** criação/edição/exclusão em transação única com `app.tenant_id`; grava `Supplier`, `AuditLog` e evento no outbox.

## Frontend
- **Tela(s):** SCR-107 (`/fornecedores`), formulário em modal ou painel lateral.
- **Componentes:** `DataTable` com busca (`q`) e filtro "Ativos/Inativos"; `SupplierForm` (React Hook Form + Zod), `DocumentTypeSelect`, `DocumentNumberInput` (máscara dinâmica por tipo), `AddressFieldset`.
- **Estados:** skeleton na lista; vazio ("Nenhum fornecedor cadastrado. Cadastre o primeiro."); erro com "Tentar novamente"; botão "Salvar" com estado de carregamento.
- **Acessibilidade e responsividade:** máscara de documento anunciada por `aria-describedby`; erros em `aria-live`; formulário em coluna única < 768 px.

## Banco de dados
- **Tabelas:** `suppliers`.
- **Migrações:** criação de `suppliers` (Padrão + SD) conforme entities.md.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, document_type, document_number_hash) WHERE deleted_at IS NULL`; GIN trigram em `legal_name`/`trade_name`; índice `(tenant_id, document_number)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| SUP-01 | GET | `/api/v1/suppliers` | `?q=&isActive=&page=&pageSize=` | `200 { data: [Supplier], meta }` | 200, 403 |
| SUP-02 | POST | `/api/v1/suppliers` | `{ documentType, documentNumber, legalName, tradeName?, email?, phone?, website?, contactName?, address…?, notes? }` + `Idempotency-Key` | `201 { data: Supplier }` | 201, 403, 409, 422, 503 |
| SUP-03 | GET | `/api/v1/suppliers/{id}` | — | `200 { data: Supplier }` | 200, 403, 404 |
| SUP-04 | PATCH | `/api/v1/suppliers/{id}` | campos editáveis (exceto documento) + `If-Match` | `200 { data: Supplier }` | 200, 403, 404, 412, 422 |
| SUP-05 | DELETE | `/api/v1/suppliers/{id}` | `If-Match` | `204` | 204, 403, 404, 409, 412 |
| SUP-06 | GET | `/api/v1/suppliers/lookup?documentNumber=` | — | `200 { data: Supplier \| null }` | 200, 403 |

## Logs
- `info` `supplier.created` — `supplierId`, `documentType`, `tenantId`, `userId`, `correlationId`.
- `info` `supplier.updated` — `supplierId`, `changedFields[]`.
- `warn` `supplier.encryption_retry` — nova tentativa de criptografia de CPF.
- `error` `supplier.create_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** `documentNumber` em claro (CPF), e-mail, telefone, endereço, observações.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `supplier.create` | `DATA_CHANGE` | Commit da criação | `changes`: campos não sensíveis; CPF registrado como hash. `metadata`: `documentType` |
| `supplier.update` | `DATA_CHANGE` | Commit de edição | `changes`: campos alterados |
| `supplier.deactivate` | `DATA_CHANGE` | `isActive` passa a `false` | `metadata`: motivo (se informado) |
| `supplier.delete` | `DATA_CHANGE` | Exclusão lógica | `metadata`: `documentType` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = SUPPLIER_MANAGE` |

## Testes necessários
- **Unitários:** `CnpjValidator` (numérico e alfanumérico, casos válidos/inválidos de IN RFB 2.229/2024); `CpfValidator`; normalização e hash de `DocumentNumber`; mascaramento de CPF.
- **Integração (Testcontainers PostgreSQL + Redis):** unicidade por `(tenant_id, document_type, document_number_hash)`; criptografia/decriptografia via KMS de teste; RLS entre tenants.
- **API/contrato:** respostas e erros conforme api.md; `ETag`/`If-Match`; nunca retornar CPF em claro.
- **RBAC e multi-tenant:** `SUPPLIER_VIEW` vs `SUPPLIER_MANAGE`; lookup não revela fornecedor de outro tenant.
- **Concorrência:** duas criações simultâneas com o mesmo documento → uma 201, outra 409.
- **E2E (Playwright):** cadastrar, editar, inativar e tentar excluir fornecedor em uso.
- **Acessibilidade/performance:** axe sem violações sérias no formulário; busca com 10k fornecedores < 300 ms (p95).

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `SUPPLIER_VIEW`/`SUPPLIER_MANAGE` aplicados na API; UI oculta/desabilita conforme permissão
- [ ] CPF nunca retornado em claro em nenhuma resposta (teste de contrato dedicado)
- [ ] Auditoria e eventos (`SupplierCreated`/`SupplierUpdated`) verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de SUP-01..06 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas `supplier_created_total`
- [ ] Acessibilidade (axe) e responsividade (360 px) verificadas
- [ ] Revisão de código e de segurança aprovadas (criptografia de CPF)
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — CRUD de tenant sem processo, mas com validação de dígito verificador (CNPJ numérico e alfanumérico — regra nova de 2026), criptografia/blind index de CPF e deduplicação; sem fluxo de workflow/aprovação.

## Prioridade
**P0** — bloqueia o registro de fontes de pesquisa de preços (US-026), que depende de fornecedores cadastrados para a pesquisa direta.

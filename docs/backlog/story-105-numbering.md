---
id: US-105
title: "Numeração configurável e segura sob concorrência"
epic: EP-017
feature: FT-057
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-103]
modules: [catalog]
screens: [SCR-041]
endpoints: [SET-02, SET-04]
permissions: [SETTINGS_MANAGE]
events: [TenantSettingsChanged]
---

# US-105 — Numeração configurável e segura sob concorrência

## Título
Configurar numeração de processos e documentos

## Descrição
**Como** administrador do órgão, **quero** configurar a máscara, o escopo e o momento de atribuição do número de processos e documentos, e confiar que a numeração nunca se repete nem deixa lacunas mesmo sob concorrência, **para** que cada protocolo seja único, previsível e aceito como identificador oficial pelo órgão.

A geração do número em si (`NumberSequence`, incremento transacional) é infraestrutura reaproveitada por toda criação de processo ou documento (US-001 e outras); esta story entrega a configuração (máscara, escopo, momento de atribuição), a prévia antes de salvar e as garantias de unicidade/concorrência por trás dela.

## Contexto
- Hoje a numeração é manual (planilhas, livros de protocolo), gerando duplicidade e desconfiança. DEC-028 define máscara configurável por chave de configuração (`numbering.process.mask`, `numbering.document.<TYPE>.mask`/`numbering.document.defaultMask`) com tokens `{seq:N}`, `{year}`, `{org}` (sigla do órgão) e `{type}` (documentos); escopo da sequência tenant (padrão) ou órgão; reinício anual.
- O número é gerado por `NumberSequence.lastValue` incrementado via `UPDATE … SET last_value = last_value + 1 RETURNING` **na mesma transação** do recurso numerado — o mesmo padrão já estabelecido por US-001 (RN-PROC-04/05) para processos; esta story generaliza o mecanismo para reúso por documentos.
- Tipos de documento semeados já têm máscara própria (`RISK_MAP`: `"MR {seq:4}/{year}"`; `PRICE_RESEARCH`: `"PP {seq:4}/{year}"` — entities.md §7); os demais usam `numbering.document.defaultMask` (`"{type} {seq:4}/{year}"`).
- `numbering.process.assignOn` (`CREATE`, padrão, ou `START`) decide **quando** o processo é numerado; esta story valida e armazena a configuração — o efeito pertence a quem cria/autua o processo (US-001/US-047).

## Objetivo
Garantir número único e sem lacunas em 100% das criações concorrentes no mesmo par (escopo, ano), com prévia confiável antes de salvar qualquer máscara e sem permitir configuração inválida chegar a produção.

## Persona
- **Principal:** Administrador do órgão (perfil `ADMIN_ORGAO`, escopo `TENANT`).
- **Secundárias:** Time de engenharia — toda story que cria processo/documento numerado reaproveita a `NumberingFacade` desta story.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` com `SETTINGS_MANAGE`.
- Registro de configurações disponível com os valores padrão semeados (US-103, US-099).

## Fluxo principal
1. O administrador acessa **Administração → Configurações** (SCR-041), grupo "Numeração"; o front carrega `numbering.process.mask`/`scope`/`assignOn` e `numbering.document.defaultMask` via `GET /settings` (`SET-01`, US-103).
2. Edita a máscara do processo (ex.: `"{org}-{seq:4}/{year}"`) e clica em **"Pré-visualizar"**; o front chama `POST /numbering/preview` (`SET-04`) com a máscara/escopo ainda não salvos.
3. O sistema responde com um exemplo formatado usando o próximo valor hipotético da sequência corrente, **sem** incrementá-la.
4. O administrador clica em **"Salvar"**; o front envia `PATCH /settings` (`SET-02`) com `{ values, expectedVersions }` para as chaves alteradas.
5. A API valida cada chave (`NUMBERING_MASK_INVALID` se faltar `{seq:N}`/`{year}`, ou se `{org}` estiver ausente com `scope = ORGANIZATION`), grava o `TenantSetting`, audita `settings.update` e publica um único `TenantSettingsChanged`.
6. Se a mudança for de `numbering.process.scope`, a tela exibe o aviso não bloqueante "Esta mudança vale a partir do próximo exercício" (DEC-028).

## Fluxos alternativos
- **FA-01 — Virada de ano:** à meia-noite de 1º de janeiro no fuso do tenant, uma nova linha de `NumberSequence` é criada sob demanda para o novo ano; a sequência do ano anterior não é reutilizada.
- **FA-02 — Concorrência:** duas criações simultâneas no mesmo par (escopo, ano) obtêm números consecutivos por bloqueio de linha (`UPDATE … RETURNING`); nenhuma recebe o mesmo número.
- **FA-03 — Rollback não consome número:** se a transação do recurso numerado falhar após obter o número, o incremento do `NumberSequence` é desfeito junto (mesma transação); o próximo número gerado é consecutivo ao último efetivamente confirmado.
- **FA-04 — Prévia sem salvar:** `SET-04` calcula sobre a máscara informada no corpo da requisição, nunca sobre a persistida, permitindo comparar antes de decidir.

## Regras de negócio
- **RN-TEN-67** — A máscara deve conter `{seq:N}` (`N` entre 1 e 6) e `{year}`; pode conter `{org}` (exige escopo `ORGANIZATION`) e, somente em máscaras de documento, `{type}`; token desconhecido ou `{seq}` sem `N` → `NUMBERING_MASK_INVALID`.
- **RN-TEN-68** — Escopo `TENANT`: `sequenceKey = "PROCESS:*:<ano>"` (ou `"DOCUMENT:<TYPE>:*:<ano>"`); escopo `ORGANIZATION`: `sequenceKey` inclui o `organizationId`. Alterar `numbering.process.scope` só produz efeito a partir do próximo exercício; sequências já abertas no ano corrente não são migradas.
- **RN-TEN-69** — O número é obtido por `UPDATE … SET last_value = last_value + 1 RETURNING last_value` na mesma transação do processo/documento numerado (linha criada sob demanda via `INSERT … ON CONFLICT DO NOTHING`); o rollback dessa transação desfaz o incremento — nenhum número confirmado é repetido ou pulado.
- **RN-TEN-70** — `year` é o ano corrente no fuso do tenant no instante da numeração.
- **RN-TEN-71** — `numbering.process.assignOn` (`CREATE` ou `START`) define somente **quando** a numeração ocorre; esta story valida e armazena o valor — o efeito é aplicado pela story que cria ou autua o processo (US-001/US-047).
- **RN-TEN-72** — Tipos de documento semeados usam a máscara própria de `DocumentType.numberingMask` (`RISK_MAP`, `PRICE_RESEARCH`); os demais usam `numbering.document.defaultMask`, salvo override específico em `numbering.document.<TYPE>.mask`.
- **RN-TEN-73** — `SET-04` (prévia) calcula o próximo valor hipotético (`lastValue + 1`) sem gravar nem incrementar a sequência real.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Máscara do processo | `numbering.process.mask` | texto curto | Não (só se alterada) | RN-TEN-67 | `"{seq:4}/{year}"` |
| Escopo da numeração | `numbering.process.scope` | seleção (`TENANT`\|`ORGANIZATION`) | Não | RN-TEN-68 | `"TENANT"` |
| Momento da numeração | `numbering.process.assignOn` | seleção (`CREATE`\|`START`) | Não | RN-TEN-71 | `"CREATE"` |
| Máscara padrão de documento | `numbering.document.defaultMask` | texto curto | Não | RN-TEN-67/72 | `"{type} {seq:4}/{year}"` |
| *(sistema)* Versão esperada por chave | `expectedVersions["<chave>"]` | int | Sim, por chave alterada | — | `version` lido em `SET-01` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Máscara sem `{seq:N}` ou `{year}`, ou token desconhecido | Front + API | "A máscara deve conter {seq:N} e {year}; verifique os marcadores usados." | `NUMBERING_MASK_INVALID` |
| V-02 | Escopo `ORGANIZATION` sem `{org}` na máscara | Front + API | "Com numeração por órgão, a máscara deve incluir {org}." | `NUMBERING_MASK_INVALID` |
| V-03 | `expectedVersions` divergente do atual | API | "Esta configuração foi alterada por outra pessoa. Recarregue." | `VERSION_CONFLICT` |
| V-04 | `expectedVersions` ausente para chave alterada | API | "Recarregue a página de configurações e tente novamente." | `PRECONDITION_REQUIRED` |

## Permissões
- **Permissão:** `SETTINGS_MANAGE`, risco `H`, sem variação de escopo (sempre `TENANT`); prévia (`SET-04`) exige a mesma permissão (altera o que é exibido a partir de dados de configuração sensíveis ao negócio).
- **Políticas:** nenhuma política contextual própria.
- **MFA:** exigido quando `security.mfaPolicy` é `ADMINS` ou `ALL` (POL-14).
- **Sem permissão:** grupo "Numeração" oculto na tela de configurações; API responde 403 `PERMISSION_DENIED` em `SET-02`/`SET-04` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TenantSettingsChanged` | `tenant.settings_changed` | Commit do `PATCH` que altera alguma chave `numbering.*` | Payload: `keys[]` com as chaves de numeração alteradas |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma; alteração de numeração não gera notificação. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Configurar numeração de processos e documentos

  Background:
    Given que o usuário está autenticado no tenant "Prefeitura de São José"
    And possui vínculo ativo com a permissão "SETTINGS_MANAGE"

  Scenario: [Sucesso] Pré-visualizar e salvar uma máscara válida
    Given que o último número de processo do tenant em 2026 é 11
    When o administrador pré-visualizar a máscara "{seq:4}/{year}"
    Then o sistema deve mostrar o exemplo "0012/2026" sem alterar a sequência
    When o administrador salvar essa máscara
    Then deve gerar registro de auditoria "settings.update"
    And deve gerar o evento "TenantSettingsChanged" com "numbering.process.mask" em "keys"

  Scenario: [Validação] Máscara sem o token {year}
    When o administrador tentar salvar a máscara "{seq:4}"
    Then a API deve responder 422 com código "NUMBERING_MASK_INVALID"
    And nenhuma configuração deve ser alterada

  Scenario: [Permissão] Usuário sem SETTINGS_MANAGE
    Given que o usuário "Bruno" possui apenas o perfil "SOMENTE_LEITURA"
    When "Bruno" enviar PATCH alterando "numbering.process.mask"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Cabeçalho de tenant sem vínculo
    When o administrador enviar a requisição com "X-Tenant-Id" de um tenant em que não possui vínculo
    Then a API deve responder 403 com código "MEMBERSHIP_INACTIVE"
    And nenhuma configuração de numeração deve ser lida ou alterada

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que o administrador salvou a máscara com a chave de idempotência "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o mesmo resultado e o cabeçalho "Idempotent-Replayed: true"

  Scenario: [Concorrência] Numerações simultâneas no mesmo escopo e ano
    Given que o último número de processo do tenant em 2026 é 0
    When 50 processos válidos forem criados simultaneamente
    Then devem existir 50 processos com números de 1 a 50, sem repetição e sem lacunas

  Scenario: [Falha de banco] Banco indisponível ao salvar a máscara
    Given que o banco de dados fica indisponível
    When o administrador tentar salvar uma nova máscara
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a configuração anterior deve permanecer inalterada

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When o administrador salvar uma máscara válida
    Then a configuração deve ser salva e a API deve responder 200
    And o evento "TenantSettingsChanged" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Máscara inválida | 422 | `NUMBERING_MASK_INVALID` | "A máscara deve conter {seq:N} e {year}; verifique os marcadores usados." | Erro no campo da máscara; prévia não avança |
| `expectedVersions` divergente | 412 | `VERSION_CONFLICT` | "Esta configuração foi alterada por outra pessoa. Recarregue." | Recarrega o grupo "Numeração" |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para alterar a numeração." | Grupo oculto |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém dados; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-103 (registro de configurações e mecanismo genérico `SET-01`/`SET-02`). Consumida por US-001 (RN-PROC-04/05), US-047 (`assignOn = START`), US-014/016/023/029/032/035/039 (numeração de documentos estruturados).
- **Decisões/ADRs:** DEC-028, DEC-003, DEC-104, DEC-105; ADR-002.
- **Configurações:** `numbering.process.mask`, `numbering.process.scope`, `numbering.process.assignOn`, `numbering.document.defaultMask`, `numbering.document.<TYPE>.mask`.
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Reaproveita o padrão de **contenção de numeração** já estabelecido em US-001: o `UPDATE … RETURNING` bloqueia a linha da sequência até o commit; transações que numeram devem permanecer curtas (mesma meta p95 < 600 ms).
- `NumberingFacade` passa a ser o único ponto de geração de número para processos **e** documentos — qualquer mudança de contrato aqui afeta todas as stories de criação de documento estruturado.
- Prévia (`SET-04`) é somente leitura e não deve competir pelo lock da sequência real.

## Backend
- **Módulo(s):** `catalog` (dono); usa `tenancy` (`SettingsRegistry`, US-103).
- **Casos de uso:** `PreviewNumberingMaskQuery` (`SET-04`); validação de `numbering.*` plugada no `UpdateSettingsCommand` (`SET-02`, US-103) via schema Zod registrado.
- **Domínio:** `NumberingFacade.next(sequenceKey)` / `.preview(mask, scope)` / `.formatMask(mask, tokens)`; VO `NumberMask` (parse e validação de tokens).
- **Transação:** `next()` sempre executa dentro da transação do recurso numerado (US-001 e símiles); `preview()` é uma leitura isolada, sem efeito colateral.

## Frontend
- **Tela(s):** SCR-041 (`/admin/configuracoes`), grupo "Numeração".
- **Componentes:** `MaskField` com prévia ao vivo (debounce chamando `SET-04`), `ScopeSelect`, `AssignOnSelect`, aviso não bloqueante de efeito futuro do escopo.
- **Estados:** indicador de "calculando prévia…"; erro de máscara inline; "salvando…" na confirmação.
- **Acessibilidade e responsividade:** prévia anunciada via `aria-live`; campos com rótulo e descrição associados.

## Banco de dados
- **Tabelas:** `number_sequences` (leitura/escrita pela `NumberingFacade`); `tenant_settings` (chaves `numbering.*`, via US-103).
- **Migrações:** nenhuma nova (tabelas já definidas em entities.md §4).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, sequence_key)` em `number_sequences`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| SET-02 | PATCH | `/settings` | `{ values: { "numbering.process.mask": "…" }, expectedVersions: { "numbering.process.mask": versão } }` | `200 { data: { "<chave>": { value, version } } }` | 200, 403, 412, 422, 428 |
| SET-04 | POST | `/numbering/preview` | `{ mask, scope? }` | `200 { data: { example, nextValue } } }` | 200, 403, 422 |

## Logs
- `info` `numbering.assigned` — `sequenceKey`, `value`, `durationMs`, `tenantId`.
- `warn` `numbering.lock_wait` — espera > 200 ms no bloqueio da sequência.
- `error` `numbering.mask_invalid` — `mask`, motivo, correlationId.
- **Nunca logar:** nada sensível adicional (chaves e máscaras não são dados pessoais).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `settings.update` | `CONFIGURATION` | Commit do `PATCH` que altera `numbering.*` (ação já definida em US-103) | `changes`: valor anterior/novo de cada chave de numeração alterada |

## Testes necessários
- **Unitários:** parser/formatador de máscara (`{seq:4}/{year}`, `{org}-{seq:5}/{year}`, `{type} {seq:4}/{year}`); validação de tokens desconhecidos; exigência de `{org}` em escopo `ORGANIZATION`.
- **Integração (Testcontainers PostgreSQL):** concorrência da sequência (`UPDATE … RETURNING`); rollback não consome número; isolamento por tenant.
- **Concorrência:** 50 numerações simultâneas no mesmo (escopo, ano) → valores 1..50 sem lacunas nem duplicatas.
- **API/contrato:** `SET-04` conforme api.md; `SET-02` com validação específica de `NUMBERING_MASK_INVALID`.
- **RBAC e multi-tenant:** com/sem `SETTINGS_MANAGE`; configuração de um tenant nunca visível/afetada por outro.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + integração) e passando no CI
- [ ] `SETTINGS_MANAGE` aplicado na API; grupo "Numeração" oculto sem permissão
- [ ] Concorrência da sequência comprovada por teste de carga (50 criações paralelas)
- [ ] Auditoria `settings.update` e evento `TenantSettingsChanged` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `SET-02`/`SET-04` compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de latência da numeração e trace
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — tokens e validação de máscara, prévia e reúso do mecanismo de sequência entre processos e documentos; exige testes de concorrência cuidadosos, mas sem orquestração transacional nova.

## Prioridade
**P0** — todo processo e documento numerado do MVP 1 depende desta configuração estar correta desde o primeiro tenant.

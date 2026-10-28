---
id: US-098
title: "Meu perfil e preferências"
epic: EP-016
feature: FT-054
mvp: 1
priority: P1
estimate: S
status: Especificada
depends_on: [US-087]
modules: [identity]
screens: [SCR-039]
endpoints: [ME-01, ME-02]
permissions: []        # capacidade implícita — ver/editar o próprio perfil (permissions.md §7)
events: []              # sem evento de domínio; gera auditoria profile.update
---

# US-098 — Meu perfil e preferências

## Título
Meu perfil e preferências

## Descrição
**Como** usuário autenticado, **quero** ver e editar meus dados de perfil (nome social, telefone) e minhas preferências de interface, **para** manter minhas informações corretas e usar o sistema do jeito mais confortável, sem depender do administrador para ajustes simples.

A tela "Meu perfil" (SCR-039) exibe os dados do `User` (identidade global — DEC-012). E-mail, CPF e dados de vínculo (cargo, lotação, perfis) ficam somente leitura aqui; senha e MFA são atalhos para o Authentik. Mudanças são imediatas e não exigem aprovação.

## Contexto
- DEC-012: `User` é a identidade global, por isso nome e e-mail não são "por tenant" e o nome social (Decreto 8.727/2016) deve prevalecer na exibição quando preenchido; esta tela complementa US-089/US-090 (atalhos de senha/MFA) e US-093 (vínculos) em SCR-039.

## Objetivo
Permitir que qualquer usuário atualize seus dados editáveis e preferências em menos de 1 minuto, com 100% das alterações auditadas e refletidas imediatamente na interface.

## Persona
- **Principal:** Qualquer usuário autenticado, em qualquer perfil (capacidade implícita, não depende de perfil).

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` (US-087).

## Fluxo principal
1. O usuário abre **"Meu perfil"** (menu do avatar → SCR-039, `/perfil`).
2. O sistema carrega `GET /me` (`ME-01`): nome, nome social, e-mail (leitura), telefone, cargo/lotação do vínculo ativo (leitura), preferências e atalhos **"Alterar senha"**/**"Autenticação em duas etapas"** (abrem o Authentik em nova aba).
3. O usuário edita nome social, telefone e/ou preferências e clica em **"Salvar"**.
4. O front valida (Zod) e envia `PATCH /api/v1/me` com `If-Match` (ETag do `GET` anterior).
5. A API valida, atualiza o `User`, grava `AuditLog` `profile.update` e responde **200** com novo `ETag`.
6. O front atualiza nome exibido e preferências aplicadas (tema/densidade) e exibe "Perfil atualizado".

## Fluxos alternativos
- **FA-01 — Remover nome social:** campo vazio volta a exibir o nome civil em toda a interface.
- **FA-02 — Edição concorrente:** `If-Match` divergente (duas abas) → `VERSION_CONFLICT`; o front recarrega `GET /me` e pede repetir a edição.

## Regras de negócio
- **RN-IAM-109** — Campos editáveis via `PATCH /me` (`ME-02`): `name` (2–200 caracteres), `socialName` (opcional, mesmas regras), `phone` (opcional, formato BR). `email`, `cpfEncrypted`, `status`, `isPlatformOperator` e dados de vínculo **não** são editáveis por este endpoint.
- **RN-IAM-110** — Com `socialName` preenchido, é o nome exibido em toda a interface (Decreto 8.727/2016); `name` permanece o nome civil usado em registros formais (auditoria, documentos).
- **RN-IAM-111** — `preferences` (jsonb) só aceita as chaves registradas (densidade, tema, órgão padrão); chave fora do registro → `SETTING_KEY_UNKNOWN` (422).
- **RN-IAM-112** — `PATCH /me` exige `If-Match` com o `version` atual do `User`; divergente → `VERSION_CONFLICT` (412); ausente → `PRECONDITION_REQUIRED` (428).
- **RN-IAM-113** — Toda alteração grava `AuditLog` `profile.update` com os campos alterados (`changes`); `email` nunca é alterado por este fluxo.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nome | `name` | texto curto | Sim | 2–200 caracteres; trim | — |
| Nome social | `socialName` | texto curto | Não | 2–200 caracteres | — |
| Telefone | `phone` | texto curto | Não | formato BR | — |
| Densidade | `preferences.density` | seleção | Não | registro (RN-IAM-111) | `comfortable` |
| Tema | `preferences.theme` | seleção | Não | registro (RN-IAM-111) | `light` (DEC-186; era `system`) |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `name` ausente/curto ou `phone` em formato inválido | Front + API | "Informe seu nome (mín. 2 caracteres)." / "Informe um telefone válido." | `VALIDATION_ERROR` |
| V-02 | Chave de preferência desconhecida | API | "Preferência não reconhecida." | `SETTING_KEY_UNKNOWN` |
| V-03 | `If-Match` ausente ou divergente | API | "Seus dados foram atualizados em outra aba. Recarregue." | `VERSION_CONFLICT`/`PRECONDITION_REQUIRED` |

## Permissões
- **Permissão:** nenhuma — capacidade implícita de qualquer vínculo ativo (permissions.md §7).
- **Políticas:** nenhuma política contextual; **MFA:** não exigido.
- **Sem permissão:** não aplicável; sem vínculo ativo, `/perfil` redireciona para SCR-111 (sessão expirada/sem vínculo).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio; a alteração é registrada apenas em auditoria (`profile.update`). |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Meu perfil e preferências

  Background:
    Given que o usuário "Elisa" está autenticada no tenant "Prefeitura A"
    And possui vínculo ativo

  Scenario: [Sucesso] Atualizar nome social e tema
    When "Elisa" definir o nome social "Eli" e o tema "dark" e clicar em "Salvar"
    Then a API deve responder 200 com o nome social atualizado
    And deve gerar registro de auditoria "profile.update"

  Scenario: [Validação] Nome muito curto
    When "Elisa" apagar o campo "Nome" e tentar salvar
    Then o sistema deve exibir "Informe seu nome (mín. 2 caracteres)."
    And o botão "Salvar" deve permanecer desabilitado

  Scenario: [Permissão] Sem vínculo ativo no tenant
    Given que o vínculo de "Elisa" não está "ACTIVE"
    When "Elisa" acessar "/perfil"
    Then a aplicação deve redirecioná-la para a página de erro de vínculo inativo

  Scenario: [Tenant incorreto] Cabeçalho de tenant sem vínculo
    When "Elisa" enviar "PATCH /me" com "X-Tenant-Id" de um tenant em que não possui vínculo
    Then a API deve responder 403 com código "MEMBERSHIP_INACTIVE"

  Scenario: [Duplicidade] Clique duplo em "Salvar"
    Given que "Elisa" clicou em "Salvar" e a primeira requisição já foi aplicada
    When o clique duplo disparar uma segunda requisição com o mesmo "If-Match" já superado
    Then a segunda deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Concorrência] Edição simultânea em duas abas
    Given que "Elisa" tem o perfil aberto em duas abas com o mesmo "ETag"
    When ambas as abas enviarem "PATCH /me" com alterações diferentes
    Then apenas a primeira deve responder 200
    And a segunda deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao salvar
    Given que o banco de dados fica indisponível
    When "Elisa" clicar em "Salvar"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o formulário deve manter os dados preenchidos

  Scenario: [Falha de integração] Sessão Redis indisponível
    Given que o Redis de sessão está indisponível
    When "Elisa" tentar acessar "/perfil"
    Then o BFF deve responder 503 e exibir "Não foi possível carregar sua sessão agora."
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Conflito de versão | 412 | `VERSION_CONFLICT` | "Seus dados foram atualizados em outra aba. Recarregue." | Recarrega `GET /me` |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Não foi possível salvar. Recarregue a página." | Recarrega `GET /me` |
| Vínculo inativo / sessão expirada | 401/403 | `MEMBERSHIP_INACTIVE`/`SESSION_EXPIRED` | "Seu acesso não está ativo. Entre novamente." | Redireciona (SCR-111/login) |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente." | Mantém dados; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-087 (sessão). Relacionadas: US-089/US-090 (atalhos de senha/MFA), US-093 (vínculos para órgão padrão).
- **Decisões/ADRs:** DEC-012. **Configurações:** nenhuma (preferências são por usuário, não por tenant).
- **Lacunas nas fontes canônicas:** nenhuma (valores de `preferences.density`/`theme` registrados em entities.md).

## Impacto técnico
Baixo risco: alteração restrita ao próprio `User`, sem novas tabelas; único cuidado é a concorrência otimista (`If-Match`) para evitar perda de alterações entre abas.

## Backend
- **Módulo(s):** `identity` (dono).
- **Casos de uso:** `GetMyProfileQuery` (`ME-01`); `UpdateMyProfileCommand` → `UpdateMyProfileHandler` (`ME-02`).
- **Domínio:** `User.updateProfile(props)` (aplica RN-IAM-109..111), em transação única com o `AuditLog`.

## Frontend
- **Tela(s):** SCR-039 (`/perfil`).
- **Componentes:** `ProfileForm`, `PreferencesFieldset`, `AuthentikShortcutLinks`.
- **Estados e acessibilidade:** loading (skeleton), erro, sucesso (toast com `aria-live`); layout em coluna única < 768 px.

## Banco de dados
- **Tabelas:** `users` (update).
- **Migrações/Índices:** nenhuma nova; usa `version` padrão para concorrência otimista.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| ME-01 | GET | `/me` | — | `200 { data: User }` com `ETag` | 200, 401 |
| ME-02 | PATCH | `/me` | `{ name?, socialName?, phone?, preferences? }` + `If-Match` | `200 { data: User }` | 200, 412, 422, 428 |

## Logs
- `info` `profile.updated` (`userId`, `correlationId`); **nunca logar** CPF, telefone completo ou e-mail além do nível `debug`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `profile.update` | `SECURITY` | Commit da atualização | `changes`: campos alterados (`name`, `socialName`, `phone`, `preferences`) |

## Testes necessários
- **Unitários e integração (Testcontainers):** RN-IAM-109..111 (campos editáveis, precedência do nome social, chaves de preferência); concorrência otimista (`If-Match`).
- **API/contrato, RBAC, E2E (Playwright) e acessibilidade:** `ME-01`/`ME-02` conforme api.md; `X-Tenant-Id` sem vínculo → 403; editar nome social/tema e ver refletido na SCR-039; axe sem violações.

## Definition of Done
- [ ] Cenários Gherkin automatizados e passando no CI
- [ ] Concorrência otimista e auditoria `profile.update` verificadas em teste
- [ ] OpenAPI de ME-01/ME-02 compatível com api.md; logs sem dados sensíveis
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**S** — CRUD simples sobre um único agregado (`User`), sem novas tabelas e sem eventos de domínio.

## Prioridade
**P1** — melhora a experiência do usuário, mas não bloqueia nenhuma jornada de negócio do MVP 1.

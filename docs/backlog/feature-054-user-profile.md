---
id: FT-054
title: "Perfil do usuário"
epic: EP-016
mvp: 1
priority: P1
stories: [US-098]
status: Especificada
---

# FT-054 — Perfil do usuário

## Título
Perfil do usuário

## Épico
EP-016 — Identidade, acesso e RBAC

## Descrição
Entrega a tela "Meu perfil" (SCR-039), onde qualquer usuário autenticado consulta e edita seus dados pessoais editáveis (nome social, telefone) e preferências de interface (densidade, tema, órgão padrão), além de atalhos para os fluxos do Authentik (senha, MFA). É a única feature do épico sem dependência de perfil — toda pessoa com vínculo ativo a utiliza.

## Valor para o usuário e para o órgão
- Autonomia do usuário para manter seus próprios dados corretos (incluindo nome social, conforme Decreto 8.727/2016) sem abrir chamado com o administrador.
- Preferências de interface persistentes melhoram a usabilidade no uso diário.

## Personas
- Qualquer usuário autenticado (`User`) — não depende de perfil (capacidade implícita).

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-098 | Meu perfil e preferências | P1 | S | US-087 |

## Escopo
- Visualização de dados do `User` e do vínculo ativo (cargo, lotação — somente leitura).
- Edição de nome social, telefone e preferências (densidade, tema, órgão padrão).
- Atalhos para alterar senha e gerenciar MFA (fluxos do Authentik).

## Fora de escopo
- Preferências de notificação (tratadas em US-113, feature própria).
- Edição de e-mail, CPF ou dados de vínculo (cargo, lotação, perfis) — feita pelo administrador (FT-052/FT-053).
- Listagem/encerramento remoto de sessões ativas — fora desta entrega.

## Regras de negócio da feature
- Campos editáveis pelo próprio usuário via `PATCH /me`: `name`, `socialName`, `phone` e `preferences` (chaves registradas apenas); `email` e dados de vínculo permanecem somente leitura (US-098, RN-IAM-109, RN-IAM-111).
- Nome social, quando preenchido, prevalece na exibição em toda a interface (Decreto 8.727/2016); `name` permanece o nome civil usado em registros formais (RN-IAM-110).
- Atualização usa concorrência otimista (`If-Match`/`ETag` do `User`) e gera auditoria `profile.update` com os campos alterados (RN-IAM-112, RN-IAM-113).

## Telas
- SCR-039 — Meu perfil (`/perfil`)

## Endpoints
- `ME-01` `GET /me`
- `ME-02` `PATCH /me`

## Entidades
- `User` — único agregado afetado.

## Eventos
- Nenhum evento de domínio; a alteração é registrada apenas como auditoria `profile.update`.

## Permissões
- Nenhuma — capacidade implícita de qualquer vínculo ativo (permissions.md §7).

## Dependências
- US-087 (sessão autenticada). Relacionadas: US-089/US-090 (atalhos de senha/MFA), US-093 (lista de vínculos usada para o órgão padrão).

## Critérios de aceite da feature
```gherkin
Feature: Perfil do usuário

  Scenario: Atualizar nome social e preferências
    Given que "Elisa" está autenticada e com vínculo ativo
    When "Elisa" definir o nome social "Eli" e o tema "dark" em "/perfil" e salvar
    Then a interface deve exibir "Eli" no lugar do nome civil
    And a preferência de tema deve ser aplicada imediatamente
    And deve gerar registro de auditoria "profile.update"
```

## Métricas de sucesso
- Percentual de usuários que personalizam ao menos uma preferência — acompanhado, sem meta rígida no MVP 1.
- Conflitos de concorrência (`VERSION_CONFLICT`) resolvidos sem perda de dados reportada.

## Riscos
- Edição simultânea em duas abas sobrescrevendo alterações — mitigação: concorrência otimista com `If-Match`, recarregando o formulário no conflito.

## Definition of Done da feature
- [ ] US-098 concluída e aceita
- [ ] Jornada E2E de edição do próprio perfil automatizada
- [ ] Documentação atualizada

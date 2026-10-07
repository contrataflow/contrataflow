---
id: FT-056
title: "Estrutura organizacional"
epic: EP-017
mvp: 1
priority: P0
stories: [US-101, US-102]
status: Especificada
---

# FT-056 — Estrutura organizacional

## Título
Estrutura organizacional

## Épico
EP-017 — Tenant e estrutura organizacional

## Descrição
Esta feature cobre o cadastro dos órgãos/entidades com CNPJ próprio dentro do tenant (`Organization`) e a organização de cada órgão em uma árvore de secretarias, departamentos e setores (`Department`), com titular e substituto por unidade. É a base para que a criação de processos, a tramitação, as aprovações e a fila de trabalho encontrem sempre a unidade e o responsável corretos.

## Valor para o usuário e para o órgão
- Um tenant que abrange mais de um órgão (ex.: Prefeitura, Fundo Municipal de Saúde, autarquia) mantém cada CNPJ e sigla corretos, com numeração por órgão confiável quando configurada.
- Processos sempre se abrem com órgão, secretaria e setor solicitante corretos desde o primeiro cadastro.
- Titular e substituto corretos alimentam a resolução de aprovador (`DEPARTMENT_HEAD`), a atribuição automática de processo e a fila de trabalho da unidade.

## Personas
- Administrador do órgão (`ADMIN_ORGAO`, escopo `TENANT`) — cadastra e mantém órgãos e unidades.
- Demais perfis — leitores implícitos nos seletores de órgão/unidade (criação de processo, aprovações, atribuição).

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-101 | Gerenciar órgãos/entidades | P0 | S | US-100 |
| US-102 | Gerenciar secretarias e setores | P0 | M | US-101 |

## Escopo
- Cadastro, edição, ativação/inativação de órgãos (nome, sigla, CNPJ, tipo, contato, logotipo).
- Árvore de unidades por órgão: criar, editar, mover (recalculando `path`/`depth` da subárvore), ativar/desativar e excluir (quando sem referências).
- Titular e substituto por unidade, com elegibilidade verificada.

## Fora de escopo
- Lotação de usuários nas unidades (EP-016, US-093).
- Numeração por órgão em si (FT-057/US-105 apenas consome `Organization.shortName`).
- Integração com o PNCP (MVP 3).

## Regras de negócio da feature
- `shortName` e `cnpj` são únicos por tenant; `shortName` alimenta o token `{org}` da numeração (RN-TEN-39/40).
- O órgão principal (`tenants.primaryOrganizationId`) ou o único órgão ativo não pode ser inativado (`PRIMARY_ORGANIZATION_REQUIRED`, RN-TEN-41).
- `path`/`depth` de `Department` são calculados e mantidos exclusivamente pela aplicação; mover uma unidade recalcula toda a subárvore na mesma transação e nunca permite ciclo (`DEPARTMENT_CYCLE`, RN-TEN-45/46).
- "Secretaria" (nível 1) é toda unidade `SECRETARIAT`/`BOARD` ou raiz do órgão; o rótulo exibido é configurável (RN-TEN-49, `labels.secretariat`).
- Excluir uma unidade só é permitido sem nenhuma referência (processo, acesso, lotação, titularidade, regra de etapa); caso contrário, `DEPARTMENT_HAS_REFERENCES` e a alternativa é desativar (RN-TEN-51).

## Telas
- SCR-032 — Secretarias (órgãos, secretarias, setores) (`/admin/estrutura`)

## Endpoints
- ORG-01..04 `GET/POST/GET/PATCH /organizations[/{id}]`
- DEP-01..09 `GET/GET/POST/GET/PATCH/POST/POST/POST/DELETE /departments[/{id}][/lookup|/move|/activate|/deactivate]`

## Entidades
- `Organization` — dona desta feature; base para numeração por órgão e PNCP (MVP 3).
- `Department` — dona desta feature; árvore por órgão com titular/substituto.

## Eventos
- `OrganizationCreated` / `OrganizationUpdated`
- `DepartmentCreated` / `DepartmentUpdated` / `DepartmentMoved` / `DepartmentDeactivated`

## Permissões
- `ORGANIZATION_MANAGE` — cadastrar e manter órgãos/entidades.
- `DEPARTMENT_MANAGE` — cadastrar e manter secretarias e setores.

## Dependências
- **Features/stories:** depende de FT-055 (contexto de tenant; órgão principal semeado no provisionamento). Habilita US-001 (RN-PROC-02/03), US-050 (POL-05), US-051/US-052 (`DEPARTMENT_HEAD`, POL-03), US-056 (fila da unidade) e FT-057 (numeração por órgão, rótulos).
- **Decisões/ADRs:** DEC-011, DEC-024, DEC-028, DEC-080..083, DEC-104; ADR-002.

## Critérios de aceite da feature
```gherkin
Feature: Estrutura organizacional

  Scenario: Montar a estrutura completa de um órgão
    Given que o órgão principal "Prefeitura Municipal de São José" já existe
    When o administrador cadastrar a secretaria "Secretaria de Obras" e o setor "Setor de Manutenção" sob ela
    Then a árvore do órgão deve mostrar as duas unidades no nível correto
    And ambas devem estar disponíveis nos seletores de criação de processo
```

## Métricas de sucesso
- 100% dos processos abertos com `organizationId`/`requestingDepartmentId` válidos e ativos desde o primeiro dia.
- 0 ciclos ou inconsistências de `path`/`depth` detectados em produção.

## Riscos
- Estrutura organizacional incompleta ou incorreta trava a resolução de aprovador/atribuição — mitigado por validações de elegibilidade de titular/substituto e por "Secretaria" sempre resolvível (unidade raiz como fallback).

## Definition of Done da feature
- [ ] US-101 e US-102 concluídas e aceitas
- [ ] Jornada E2E "cadastrar órgão e montar a árvore de unidades" automatizada
- [ ] Documentação do administrador do órgão atualizada

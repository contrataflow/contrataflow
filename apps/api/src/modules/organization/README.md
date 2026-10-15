# `organization`

Estrutura organizacional: secretarias e setores (DEC-040).

- **Unidades (US-102):** `Department` em árvore por órgão com caminho materializado (`path`
  `/<idRaiz>/…/<id>/`, `depth` 0 na raiz — RN-TEN-45), DEP-01..09. Mover recalcula a subárvore na
  mesma transação, sob trava consultiva por (tenant, órgão) e `FOR UPDATE` da subárvore (sem ciclo
  — RN-TEN-46). Exclusão física só sem referências: sub-unidades e lotações conferidas antes; o
  resto pelas FKs `ON DELETE RESTRICT` (`DEPARTMENT_HAS_REFERENCES`).
- **Titular/substituto (RN-TEN-48):** vínculo ativo com lotação na unidade (`identity`) ou perfil
  com escopo que a cubra (`access` — hoje o escopo padrão `TENANT`; atribuição real na US-096).
- **Fachada:** `OrganizationFacade.findDepartmentForApproval` (aprovador `DEPARTMENT_HEAD`,
  workflow e tipos de documento).
- **Dependências de mesmo nível** (exceção em DEC-041): `access`, `identity` e `tenancy` (órgão
  ativo — `TenancyFacade.organizationStatus`).

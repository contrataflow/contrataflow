-- US-099 · Provisionamento e ciclo de vida do tenant pela plataforma (RN-TEN-02). Nenhuma tabela
-- nova: `tenants` (com o formato do slug e o motivo obrigatório na suspensão) vem da US-087/US-100.
-- Aqui entram o slug imutável depois da ativação e a impressão do pedido (retomada).

SET ROLE cf_owner;

-- 1. RN-TEN-02: o slug só muda enquanto o tenant está em `PROVISIONING` (correção antes da
-- ativação); depois é imutável — inclusive para o cf_platform — e continua reservado para sempre.
CREATE FUNCTION cf_tenants_slug_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."slug" IS DISTINCT FROM OLD."slug" AND OLD."status" <> 'PROVISIONING' THEN
    RAISE EXCEPTION 'tenants: slug é imutável depois do provisionamento'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'O identificador do tenant não muda depois da ativação (US-099 · RN-TEN-02).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_tenants_slug_immutable() FROM PUBLIC;

CREATE TRIGGER "tenants_slug_immutable" BEFORE UPDATE ON "tenants"
  FOR EACH ROW EXECUTE FUNCTION cf_tenants_slug_immutable();

-- 2. FA-01: impressão do pedido de provisionamento (SHA-256 de slug + CNPJ do órgão principal +
-- e-mail do primeiro administrador). A reexecução só retoma o MESMO pedido; outro CNPJ ou e-mail
-- com o mesmo slug → 409 `TENANT_SLUG_TAKEN`, inclusive em corrida. Coluna só do cf_platform: os
-- GRANTs por coluna de cf_app/cf_worker (US-100) não a incluem.
ALTER TABLE "tenants" ADD COLUMN "provisioning_fingerprint" CHAR(64);

RESET ROLE;

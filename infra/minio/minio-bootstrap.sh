#!/bin/sh
# RN-FND-16 · storage.md §3, §11 — bootstrap idempotente do MinIO (job `minio-bootstrap`).
# Reexecutar não duplica nada: buckets com --ignore-existing, lifecycle substituído por inteiro
# (`mc ilm import`), usuário e política sobrescritos. Nunca imprime credenciais.
set -eu

log() { printf '%s\n' "minio-bootstrap: $*"; }
fail() { printf '%s\n' "env.bootstrap_failed minio-bootstrap: $*" >&2; exit 1; }

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null \
  || fail "não foi possível autenticar no MinIO"

# Buckets lógicos (storage.md §3). Object Lock só pode ser habilitado na criação (implica
# versionamento); a retenção é por objeto (§9.3), sem retenção padrão no bucket.
mc mb --ignore-existing "local/$S3_BUCKET_QUARANTINE" >/dev/null
mc mb --ignore-existing "local/$S3_BUCKET_DOCUMENTS" >/dev/null
mc mb --ignore-existing --with-lock "local/$S3_BUCKET_RENDITIONS" >/dev/null
mc version enable "local/$S3_BUCKET_DOCUMENTS" >/dev/null

# Lifecycle (storage.md §3.2) — `import` substitui a configuração inteira (idempotente).
mc ilm import "local/$S3_BUCKET_QUARANTINE" >/dev/null <<'JSON'
{"Rules":[{"ID":"expire-unscanned","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":1}}]}
JSON
mc ilm import "local/$S3_BUCKET_DOCUMENTS" >/dev/null <<'JSON'
{"Rules":[{"ID":"noncurrent-cleanup","Status":"Enabled","Filter":{"Prefix":""},"NoncurrentVersionExpiration":{"NoncurrentDays":90}}]}
JSON
mc ilm import "local/$S3_BUCKET_RENDITIONS" >/dev/null <<'JSON'
{"Rules":[{"ID":"expire-previews","Status":"Enabled","Filter":{"Tag":{"Key":"cf-retention","Value":"ephemeral"}},"Expiration":{"Days":1},"NoncurrentVersionExpiration":{"NoncurrentDays":1}}]}
JSON

# Usuário da aplicação com menor privilégio (espelha a união dos papéis da API e do worker em
# produção — storage.md §3.1): sem DeleteObject em documents/renditions, nunca o usuário root.
POLICY_FILE=/tmp/contrataflow-app-policy.json
cat >"$POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListBuckets",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": [
        "arn:aws:s3:::$S3_BUCKET_QUARANTINE",
        "arn:aws:s3:::$S3_BUCKET_DOCUMENTS",
        "arn:aws:s3:::$S3_BUCKET_RENDITIONS"
      ]
    },
    {
      "Sid": "Quarantine",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::$S3_BUCKET_QUARANTINE/*"]
    },
    {
      "Sid": "Evidence",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObjectTagging",
        "s3:GetObjectTagging"
      ],
      "Resource": [
        "arn:aws:s3:::$S3_BUCKET_DOCUMENTS/*",
        "arn:aws:s3:::$S3_BUCKET_RENDITIONS/*"
      ]
    },
    {
      "Sid": "RenditionsRetention",
      "Effect": "Allow",
      "Action": ["s3:PutObjectLegalHold", "s3:PutObjectRetention"],
      "Resource": ["arn:aws:s3:::$S3_BUCKET_RENDITIONS/*"]
    }
  ]
}
JSON

mc admin user add local "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null \
  || fail "não foi possível criar o usuário da aplicação"
mc admin policy create local contrataflow-app "$POLICY_FILE" >/dev/null \
  || fail "política contrataflow-app inválida"
# `attach` falha quando a política já está vinculada; o que importa é o estado final.
mc admin policy attach local contrataflow-app --user "$S3_ACCESS_KEY_ID" >/dev/null 2>&1 || true
# A imagem do mc não tem grep: o `case` do shell confere o vínculo.
USER_INFO=$(mc admin user info local "$S3_ACCESS_KEY_ID" --json)
case "$USER_INFO" in
  *contrataflow-app*) ;;
  *) fail "política contrataflow-app não vinculada ao usuário da aplicação" ;;
esac

log "buckets $S3_BUCKET_QUARANTINE, $S3_BUCKET_DOCUMENTS e $S3_BUCKET_RENDITIONS prontos"

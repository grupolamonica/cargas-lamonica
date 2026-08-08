#!/usr/bin/env bash
# backup-database.sh — Dump CIFRADO do banco de produção (DC-283 / ALTO-12)
#
# O backup-lamonica.sh salva .env e certificados do Traefik. NÃO salva o banco —
# onde vive tudo: cargas, cadastros, motoristas, CNH, CPF, dados bancários.
# Perder a VPS hoje não perde o banco (é Supabase gerenciado), mas um DELETE
# errado, uma migration ruim ou um comprometimento de conta perdem — e não há
# nada de onde restaurar sob nosso controle.
#
# Uso:  BACKUP_GPG_PASSPHRASE=... bash scripts/backup-database.sh
#
# ─── Quatro obstáculos que este script resolve (todos verificados na VPS) ─────
#
# 1. Não há pg_dump instalado na VPS. Roda dentro de container, como o backup
#    dos certificados já faz.
# 2. SUPABASE_DB_URL aponta para o pooler na porta 6543 (modo transaction), onde
#    pg_dump NÃO funciona — ele precisa de estado de sessão. A mesma credencial
#    responde em modo sessão na 5432.
# 3. A URL carrega `?pgbouncer=true`, que o libpq rejeita com
#    "invalid URI query parameter".
# 4. O servidor é PostgreSQL 17; pg_dump 16 aborta com version mismatch. Daí a
#    imagem pinada — se o Supabase subir para 18, o erro é explícito e a
#    correção é trocar PG_IMAGE.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/backups/db}"
APP_DIR="${APP_DIR:-/opt/apps/lamonica}"
PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"
RETENTION_DAYS="${BACKUP_DB_RETENTION_DAYS:-30}"
DATE="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="$BACKUP_DIR/lamonica-db-$DATE.sql.gz.gpg"

log() { echo "[backup-database] $*"; }
die() { echo "[backup-database] ERRO: $*" >&2; exit 1; }

# ─── Cifra obrigatória ───────────────────────────────────────────────────────
# O dump é a base inteira em texto plano: CNH, CPF, endereço, dados bancários,
# credenciais de portal. Gravar isso sem cifra transformaria o backup no maior
# vazamento de PII do sistema. Sem passphrase o script ABORTA — nunca degrada
# para dump aberto.
if [ -z "${BACKUP_GPG_PASSPHRASE:-}" ]; then
  die "BACKUP_GPG_PASSPHRASE nao definida. O dump contem a base inteira de PII e nao sera gravado sem cifra."
fi
command -v gpg >/dev/null 2>&1 || die "gpg nao encontrado — necessario para cifrar o dump."

# ─── Conexão em modo sessão ──────────────────────────────────────────────────
# Lê a URL de dentro do container do backend, que já tem o segredo carregado —
# assim a credencial não precisa ser duplicada em nenhum outro lugar. Nunca é
# impressa.
log "Derivando conexao em modo sessao a partir do container do backend..."
DUMP_URL="$(docker exec lamonica-backend-1 node -e '
const raw = process.env.SUPABASE_DB_URL;
if (!raw) { process.exit(3); }
const u = new URL(raw);
u.port = "5432";                       // modo sessao (pg_dump nao roda no 6543)
u.searchParams.delete("pgbouncer");    // libpq rejeita este parametro
u.searchParams.set("sslmode", "require");
process.stdout.write(u.toString());
')" || die "nao foi possivel ler SUPABASE_DB_URL do container lamonica-backend-1."

[ -n "$DUMP_URL" ] || die "SUPABASE_DB_URL vazia."

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# ─── Dump ────────────────────────────────────────────────────────────────────
# Sai comprimido do container e entra direto no gpg: o texto plano nunca toca o
# disco. --no-owner/--no-acl porque o restore vai para outro dono.
log "Rodando pg_dump ($PG_IMAGE)..."
set +e
docker run --rm -e PGURL="$DUMP_URL" "$PG_IMAGE" \
  sh -c 'pg_dump --no-owner --no-acl --clean --if-exists "$PGURL" | gzip -9' \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase "$BACKUP_GPG_PASSPHRASE" \
        --output "$DUMP_FILE"
PIPE_STATUS=("${PIPESTATUS[@]}")
set -e

[ "${PIPE_STATUS[0]}" -eq 0 ] || die "pg_dump falhou (codigo ${PIPE_STATUS[0]})."
[ "${PIPE_STATUS[1]}" -eq 0 ] || die "gpg falhou (codigo ${PIPE_STATUS[1]})."

chmod 600 "$DUMP_FILE"
SIZE="$(du -h "$DUMP_FILE" | cut -f1)"
log "OK: $DUMP_FILE ($SIZE)"

# ─── Verificação ─────────────────────────────────────────────────────────────
# Backup que nunca foi lido não é backup. Decifra, testa a integridade do gzip e
# confere que o conteúdo é mesmo um dump — pega arquivo truncado, passphrase
# errada e "dump" de 0 byte por erro silencioso.
log "Verificando o arquivo gerado..."
if ! gpg --batch --quiet --decrypt --passphrase "$BACKUP_GPG_PASSPHRASE" "$DUMP_FILE" 2>/dev/null \
     | gzip -t; then
  rm -f "$DUMP_FILE"
  die "arquivo gerado nao passou na verificacao — removido para nao dar falsa sensacao de backup."
fi

TABELAS="$(gpg --batch --quiet --decrypt --passphrase "$BACKUP_GPG_PASSPHRASE" "$DUMP_FILE" 2>/dev/null \
  | gunzip | grep -c '^CREATE TABLE' || true)"
if [ "${TABELAS:-0}" -lt 10 ]; then
  rm -f "$DUMP_FILE"
  die "dump com apenas ${TABELAS:-0} tabelas — abaixo do esperado. Removido."
fi
log "Verificado: $TABELAS tabelas no dump."

# ─── Cópia fora da VPS ───────────────────────────────────────────────────────
# Backup no mesmo servidor da aplicação cobre erro humano, não perda da máquina.
# O comando de envio é injetado por env para não acoplar o script a um provedor.
if [ -n "${BACKUP_OFFSITE_CMD:-}" ]; then
  log "Enviando copia off-site..."
  BACKUP_FILE="$DUMP_FILE" sh -c "$BACKUP_OFFSITE_CMD" && log "OK: copia off-site enviada" \
    || log "ATENCAO: envio off-site FALHOU — o backup local existe, mas nao ha copia fora da VPS"
else
  log "ATENCAO: BACKUP_OFFSITE_CMD nao definido — backup existe SO nesta VPS."
fi

# ─── Retenção ────────────────────────────────────────────────────────────────
find "$BACKUP_DIR" -name "lamonica-db-*.sql.gz.gpg" -mtime "+$RETENTION_DAYS" -delete 2>/dev/null || true

log "Concluido — $DATE"

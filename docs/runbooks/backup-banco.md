# Runbook — Backup cifrado do banco (DC-283 / ALTO-12)

## O que estava acontecendo

O `backup-lamonica.sh` salva `backend.env`, `.env` e os certificados do Traefik. **Não salva o banco** — onde vive tudo: cargas, cadastros, motoristas, CNH, CPF, dados bancários.

Pior: apurado na VPS em 2026-08-07, **o script não estava agendado**. Não havia entrada no crontab do usuário, nada em `/etc/cron*` e nenhum systemd timer. O backup mais recente em `/opt/backups` era de **2026-04-25** — rodou uma vez, à mão, e parou.

Ou seja: não havia backup do banco, e o backup do que existia estava três meses defasado.

> Perder a VPS hoje não perde o banco — ele é Supabase gerenciado. Mas um `DELETE` errado, uma migration ruim ou um comprometimento de conta perdem, e não havia nada sob nosso controle de onde restaurar.

## Como o script novo funciona

`scripts/backup-database.sh` gera um dump **cifrado** do banco de produção.

```bash
BACKUP_GPG_PASSPHRASE='<a passphrase>' bash scripts/backup-database.sh
```

### Quatro obstáculos reais que ele contorna

Todos verificados na VPS antes de escrever — cada um faria o script falhar:

| Obstáculo | Como o script resolve |
|---|---|
| Não há `pg_dump` instalado na VPS | Roda dentro de container, como o backup dos certificados já fazia |
| `SUPABASE_DB_URL` aponta para o pooler na **6543** (modo transaction), onde `pg_dump` não funciona | Deriva a mesma credencial na **5432** (modo sessão) |
| A URL carrega `?pgbouncer=true`, que o libpq rejeita | Remove o parâmetro |
| O servidor é PostgreSQL **17**; `pg_dump` 16 aborta com version mismatch | Imagem pinada em `postgres:17-alpine` |

Se o Supabase subir para o Postgres 18, o script falha com mensagem explícita de version mismatch — a correção é trocar `PG_IMAGE`.

### Decisões de segurança

**A cifra é obrigatória, não opcional.** Sem `BACKUP_GPG_PASSPHRASE` o script aborta e não grava nada. Um dump é a base inteira em texto plano — gravá-lo sem cifra transformaria o backup no maior vazamento de PII do sistema. O texto plano nunca toca o disco: sai comprimido do container e entra direto no `gpg`.

**Guarde a passphrase fora da VPS.** Passphrase ao lado do backup não é cifra, é decoração.

**O script verifica o que gerou.** Decifra, testa a integridade do gzip e confere que há mais de 10 tabelas. Se qualquer checagem falhar, o arquivo é **removido** — melhor não ter backup do que ter um arquivo corrompido dando falsa sensação de segurança.

## Agendar (é isto que faltava)

Uma entrada no crontab do usuário `antonio-magalhaes`:

```bash
crontab -e
```

```
0 3 * * * BACKUP_GPG_PASSPHRASE="$(cat /opt/apps/lamonica/.backup-passphrase)" /usr/bin/bash /opt/apps/lamonica/scripts/backup-database.sh >> /var/log/backup-database.log 2>&1
```

O arquivo da passphrase precisa de `chmod 600`. E vale agendar o `backup-lamonica.sh` junto — ele também não roda desde abril.

## Cópia fora da VPS

Backup no mesmo servidor da aplicação cobre erro humano, **não** perda da máquina. O script tem um gancho:

```bash
export BACKUP_OFFSITE_CMD='rclone copy "$BACKUP_FILE" remoto:lamonica-backups/'
```

Sem `BACKUP_OFFSITE_CMD` o script avisa em toda execução que o backup existe só na VPS. `rclone` ainda **não está instalado** lá — instalar e configurar o destino é ação de infra, fora deste PR.

## Testar a restauração

Backup nunca restaurado não é backup — é esperança. Trimestralmente, contra um banco descartável (nunca contra produção):

```bash
gpg --batch --decrypt --passphrase "$BACKUP_GPG_PASSPHRASE" \
    /opt/backups/db/lamonica-db-AAAAMMDD-HHMMSS.sql.gz.gpg \
  | gunzip \
  | docker run --rm -i -e PGPASSWORD=postgres --network host postgres:17-alpine \
      psql -h localhost -U postgres -d restore_teste
```

Confira depois: contagem de tabelas, `SELECT count(*)` nas principais (`cargas`, `pending_driver_registrations`, `load_public_leads`) e a data do registro mais recente. Registre quando o teste foi feito e o que deu.

## Retenção

Dumps ficam 30 dias por padrão (`BACKUP_DB_RETENTION_DAYS`). Vale lembrar que **o backup também é dado pessoal**: guardar dump por tempo indeterminado recria, dentro do backup, o mesmo problema de retenção indefinida que o CRIT-4 apontou na base.

## O que este runbook não cobre

- **Off-site de fato** — o gancho existe, o destino não. Precisa de instalação e credencial.
- **Imutabilidade (object-lock/WORM)** — dump apagável por quem tem acesso à VPS não protege contra ransomware nem contra alguém apagando o rastro.
- **PITR do Supabase** — vale confirmar no painel se o plano tem point-in-time recovery e com qual retenção. Se tiver, este dump é a segunda camada, não a única; se não tiver, ele é a única e a cadência de 1×/dia define quanto se pode perder.

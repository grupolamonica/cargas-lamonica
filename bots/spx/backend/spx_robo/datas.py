"""Conversao de datas -> unix timestamp para os campos de data do SPX.

Modulo PURO (sem dependencias externas nem I/O) para os campos de DATA que o
SPX/Shopee espera como unix timestamp: `birth_day`, `license_expire_date`,
`rad_expire_date`. Isolado de `flow_motorista` para ser testavel sem puxar o
client HTTP/browser.

⚠️ Regra do fuso (bug GLAUBERT, 2026-08-05): estes timestamps sao
renderizados/comparados pelo portal SPX no fuso do Brasil (UTC-3). Ancorar a
data a MEIA-NOITE fazia o dia "voltar um" na tela da Shopee. A correcao ancora
ao MEIO-DIA UTC — ver `_epoch_seconds`.
"""

from __future__ import annotations

from datetime import datetime, timezone


def _epoch_seconds(dt: datetime) -> int:
    """Epoch (s) da DATA de `dt`, ancorada ao MEIO-DIA UTC.

    Os campos de data do SPX (birth_day, license_expire_date, rad_expire_date)
    trafegam como unix timestamp, e o portal SPX/Shopee os renderiza/compara no
    fuso do Brasil (UTC-3). Ancorar a MEIA-NOITE fazia a data "voltar um dia" na
    tela da Shopee: 00:00 UTC do dia D vira 21:00 do dia D-1 em BRT. Com isso o
    SPX rejeitava a CNH por nao corresponder ao proprio OCR ("a data de validade
    da CNH nao corresponde ao documento"), e a data de nascimento aparecia 1 dia
    a menos. BUG confirmado no cadastro de GLAUBERT (2026-08-05): o bot enviou
    license_expire_date=2051654400 (=2035-01-06 00:00 UTC), que a Shopee exibiu
    como 05/01/2035; e birth_day=242179200 (=1977-09-04 00:00 UTC) -> 03/09/1977.

    Ancorar ao MEIO-DIA UTC preserva o dia-calendario em qualquer fuso de -12h a
    +11h (cobre BRT e o fuso da Shopee/SEA). Como o datetime resultante e
    tz-aware, .timestamp() NAO chama o mktime do C runtime -> tambem funciona
    para datas pre-1970 no Windows (antes lancava OSError 22, caso FLAVIO
    DONIZETTE PINHEIRO nasc. 10/10/1958). Estes campos sao data pura (sem hora),
    entao normalizar a hora para 12:00 nao perde informacao.
    """
    anchored = dt.replace(hour=12, minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
    return int(anchored.timestamp())


def _to_unix_seconds(d: str | int | datetime | None) -> int:
    """Aceita 'YYYY-MM-DD', 'DD/MM/YYYY', datetime, unix int."""
    if d is None or d == "":
        return 0
    if isinstance(d, int):
        return d
    if isinstance(d, datetime):
        return _epoch_seconds(d)
    s = str(d).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%Y/%m/%d", "%d-%m-%Y"):
        try:
            return _epoch_seconds(datetime.strptime(s, fmt))
        except ValueError:
            continue
    # ja eh epoch como string?
    try:
        return int(float(s))
    except ValueError:
        raise ValueError(f"data invalida: {d!r}")

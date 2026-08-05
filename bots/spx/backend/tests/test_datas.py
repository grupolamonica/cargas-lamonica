"""Blindagem do off-by-one de fuso nas datas do SPX (bug GLAUBERT, 2026-08-05).

Os campos de data do SPX (birth_day / license_expire_date / rad_expire_date) vao
como unix timestamp e a Shopee os exibe/compara no fuso do Brasil (UTC-3). Se a
data for ancorada a MEIA-NOITE, o dia "volta um" na tela da Shopee (00:00 UTC do
dia D -> 21:00 do dia D-1 em BRT) e o SPX rejeita a CNH por nao corresponder ao
proprio OCR. Estes testes travam que o timestamp cai no MESMO dia-calendario
tanto em UTC quanto em BRT (e em qualquer fuso de -12h a +11h).

Os asserts usam aritmetica de epoch (epoch + timedelta) em vez de
datetime.fromtimestamp para nao estourar com datas pre-1970 no Windows.
"""

from datetime import datetime, timedelta, timezone

import pytest

from spx_robo.datas import _epoch_seconds, _to_unix_seconds

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
BRT = timezone(timedelta(hours=-3))


def _dia(ts: int, tz: timezone = timezone.utc) -> str:
    return (_EPOCH + timedelta(seconds=ts)).astimezone(tz).strftime("%Y-%m-%d")


def _hora_utc(ts: int) -> int:
    return (_EPOCH + timedelta(seconds=ts)).hour


def test_validade_cnh_glaubert_nao_volta_um_dia_em_brt():
    # CNH validade 06/01/2035 (armazenada ISO). A regressao ia 2035-01-05 na Shopee.
    ts = _to_unix_seconds("2035-01-06")
    assert _dia(ts) == "2035-01-06"
    assert _dia(ts, BRT) == "2035-01-06"


def test_nascimento_glaubert_dd_mm_yyyy_nao_volta_um_dia():
    # Nascimento 04/09/1977 (formato BR). A regressao exibia 03/09/1977 na Shopee.
    ts = _to_unix_seconds("04/09/1977")
    assert _dia(ts) == "1977-09-04"
    assert _dia(ts, BRT) == "1977-09-04"


def test_dia_calendario_estavel_em_qualquer_fuso_de_menos12_a_mais11():
    ts = _to_unix_seconds("2035-01-06")
    for off in range(-12, 12):  # -12h .. +11h
        tz = timezone(timedelta(hours=off))
        assert _dia(ts, tz) == "2035-01-06"


def test_ancoragem_ao_meio_dia_utc():
    assert _hora_utc(_to_unix_seconds("2035-01-06")) == 12


def test_epoch_seconds_datetime_naive_ancora_meio_dia_utc():
    ts = _epoch_seconds(datetime(2035, 1, 6, 0, 0, 0))  # naive meia-noite
    assert _dia(ts, BRT) == "2035-01-06"
    assert _hora_utc(ts) == 12


def test_pre_1970_nao_estoura_e_mantem_o_dia():
    # caso FLAVIO 10/10/1958: epoch negativo. tz-aware -> sem OSError no Windows.
    ts = _to_unix_seconds("10/10/1958")
    assert ts < 0
    assert _dia(ts) == "1958-10-10"
    assert _dia(ts, BRT) == "1958-10-10"


def test_unix_int_passa_direto_sem_reancorar():
    # o perfil do SPX ja manda unix int — nao pode ser deslocado.
    assert _to_unix_seconds(242179200) == 242179200


def test_epoch_como_string_ainda_e_aceito():
    assert _to_unix_seconds("242179200") == 242179200


def test_vazio_e_none_viram_zero():
    assert _to_unix_seconds(None) == 0
    assert _to_unix_seconds("") == 0


def test_data_invalida_levanta_valueerror():
    with pytest.raises(ValueError):
        _to_unix_seconds("xx/yy/zzzz")

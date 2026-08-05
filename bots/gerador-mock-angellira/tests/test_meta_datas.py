"""As datas do mock AngelLira devem espelhar o portal real, e nao repetir a mesma
data em todos os campos (feedback 2026-08-05): o recebimento vem alguns minutos
APOS o envio (gap de processamento) e o vencimento e ~180 dias apos o recebimento
(padrao real "Dias Vencimento" = 180), nao 365.
"""

from datetime import datetime

from shared.cadastro_map import VALIDADE_DIAS, _meta


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def test_validade_padrao_e_180_nao_365():
    assert VALIDADE_DIAS == 180


def test_recebimento_vem_depois_do_envio():
    m = _meta("2026-00099", "Conforme")
    assert _dt(m["receivingDate"]) > _dt(m["sentDate"])


def test_vencimento_e_recebimento_mais_180_dias_mesma_hora():
    m = _meta("2026-00099", "Conforme")
    recv, limit = _dt(m["receivingDate"]), _dt(m["limitDate"])
    assert (limit.date() - recv.date()).days == 180
    # a hora do vencimento acompanha a do recebimento (padrao real), nao a do envio
    assert (limit.hour, limit.minute, limit.second) == (recv.hour, recv.minute, recv.second)


def test_as_tres_datas_sao_distintas():
    m = _meta("2026-00099", "Conforme")
    assert len({m["sentDate"], m["receivingDate"], m["limitDate"]}) == 3

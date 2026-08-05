"""Blindagem do 422 "Validation error" do AngelLira por telefone duplicado.

Caso GLAUBERT FRANCISCO DE LIMA (2026-08-05): o payload do motorista trazia
telefones=['62984674668','62984674668'] (mesmo numero 2x) e o POST /drivers
falhava com 422 mesmo com todo o resto valido. Empiricamente, dos cadastros
recentes só o GLAUBERT tinha telefone duplicado e foi o único a falhar; múltiplos
telefones DISTINTOS passam. `telefones_para_api` deve COLAPSAR duplicatas.
"""

from angelira_robo.helpers import telefones_para_api


def test_deduplica_telefone_repetido_caso_glaubert():
    out = telefones_para_api(["62984674668", "62984674668"], default_type_id=3)
    assert out == [{"phone": "(62) 98467-4668", "typeId": 3}]


def test_mantem_multiplos_distintos():
    out = telefones_para_api(["62984674668", "1938887766"], default_type_id=3)
    assert [p["phone"] for p in out] == ["(62) 98467-4668", "(19) 3888-7766"]


def test_dedup_normaliza_formatacao_antes_de_comparar():
    # mesma linha escrita de 3 jeitos -> uma entrada só
    out = telefones_para_api(
        ["62984674668", "(62) 98467-4668", "62 98467 4668"], default_type_id=3
    )
    assert out == [{"phone": "(62) 98467-4668", "typeId": 3}]


def test_default_type_id_respeitado():
    assert telefones_para_api(["1938887766"], default_type_id=2)[0]["typeId"] == 2


def test_typeid_do_dict_vence_o_default():
    out = telefones_para_api([{"phone": "62984674668", "typeId": 2}], default_type_id=3)
    assert out == [{"phone": "(62) 98467-4668", "typeId": 2}]


def test_lista_vazia_e_none_viram_lista_vazia():
    assert telefones_para_api([], default_type_id=3) == []
    assert telefones_para_api(None, default_type_id=3) == []


def test_aceita_item_avulso_nao_lista():
    assert telefones_para_api("62984674668", default_type_id=3) == [
        {"phone": "(62) 98467-4668", "typeId": 3}
    ]


def test_ignora_entrada_vazia_no_meio():
    out = telefones_para_api(["", "62984674668"], default_type_id=3)
    assert out == [{"phone": "(62) 98467-4668", "typeId": 3}]

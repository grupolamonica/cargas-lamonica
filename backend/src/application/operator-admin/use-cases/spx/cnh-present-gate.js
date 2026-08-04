/**
 * Gate de CNH do motorista × SPX.
 *
 * O SPX exige o número de registro da CNH no `validate/basic` e rejeita com o
 * retcode 271605013 ("A CNH não pode estar vazia") quando o cadastro chega sem o
 * registro — o robô devolvia isso como 502 opaco ("Falha SPX em etapa
 * desconhecida"). Espelha o `checkCrlvGate` / `checkTelefoneGate`: barra ANTES do
 * disparo com mensagem acionável, para o operador anexar/preencher a CNH e
 * re-disparar. Lê o registro na MESMA ordem do precheck/payload-mapper.
 *
 * @param {object} dados — pending_driver_registrations.dados
 * @returns {{code,message,acao,blocked_by}|null} bloqueio, ou null se OK.
 */
const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");

export function checkCnhPresentGate(dados) {
  if (!dados || typeof dados !== "object") return null;
  const motorista = dados.motorista && typeof dados.motorista === "object" ? dados.motorista : null;
  if (!motorista) return null;

  const cnhRaw = motorista.cnh ?? dados.cnh ?? null;
  const registro = onlyDigits(
    (typeof cnhRaw === "string" ? cnhRaw : (cnhRaw?.registro || cnhRaw?.numero))
    || motorista.cnh_registro
    || motorista.cnh_numero
    || "",
  );
  if (registro) return null; // tem CNH → segue o disparo.

  return {
    code: "SPX_CNH_AUSENTE",
    message: "Número da CNH do motorista ausente. O SPX exige o registro da CNH para cadastrar.",
    acao: "Anexe/preencha a CNH do motorista no cadastro (o OCR extrai o registro) e dispare o SPX novamente.",
    blocked_by: "cnh_motorista",
  };
}

let state = {
    logs: [],
    running: false,
    timerInterval: null,
    timerStart: null
};

document.addEventListener('DOMContentLoaded', () => {
    setInterval(updateLogs, 1500);

    document.getElementById('gerar-btn').addEventListener('click', gerarUnificador);
    document.getElementById('limpar-btn').addEventListener('click', limparFormulario);

    // Mascara CPF
    document.getElementById('cpf-input').addEventListener('input', mascaraCPF);

    // Uppercase placas
    document.getElementById('cavalo-input').addEventListener('input', forcarUppercase);
    document.getElementById('carreta-input').addEventListener('input', forcarUppercase);
});

function mascaraCPF(e) {
    let v = e.target.value.replace(/\D/g, '');
    if (v.length > 11) v = v.substring(0, 11);
    if (v.length > 9) v = v.replace(/(\d{3})(\d{3})(\d{3})(\d{1,2})/, '$1.$2.$3-$4');
    else if (v.length > 6) v = v.replace(/(\d{3})(\d{3})(\d{1,3})/, '$1.$2.$3');
    else if (v.length > 3) v = v.replace(/(\d{3})(\d{1,3})/, '$1.$2');
    e.target.value = v;
}

function forcarUppercase(e) {
    e.target.value = e.target.value.toUpperCase();
}

function limparFormulario() {
    document.getElementById('cpf-input').value = '';
    document.getElementById('cavalo-input').value = '';
    document.getElementById('carreta-input').value = '';
    document.getElementById('cpf-input').focus();
}

async function gerarUnificador() {
    const cpf = document.getElementById('cpf-input').value.replace(/\D/g, '');
    const cavalo = document.getElementById('cavalo-input').value.trim().toUpperCase();
    const carreta = document.getElementById('carreta-input').value.trim().toUpperCase();

    // Validacao: pelo menos UM dos tres
    const hasCpf = cpf && cpf.length >= 11;
    const hasCavalo = !!cavalo;
    const hasCarreta = !!carreta;

    if (!hasCpf && !hasCavalo && !hasCarreta) {
        addLog('error', 'Preencha pelo menos um: CPF, Cavalo ou Carreta.');
        document.getElementById('cpf-input').focus();
        return;
    }
    if (cpf && cpf.length < 11) {
        addLog('error', 'CPF informado e invalido (precisa de 11 digitos). Apague ou complete.');
        document.getElementById('cpf-input').focus();
        return;
    }

    // UI: running state
    const btn = document.getElementById('gerar-btn');
    btn.disabled = true;
    btn.classList.add('running');
    btn.textContent = 'Processando...';
    state.running = true;

    const progressSection = document.getElementById('progress-section');
    progressSection.classList.add('active');
    updateProgress(0, 1, 'Iniciando...');
    startTimer();

    const partes = [];
    if (hasCpf) partes.push(`CPF ${cpf}`);
    if (hasCavalo) partes.push(`Cavalo ${cavalo}`);
    if (hasCarreta) partes.push(`Carreta ${carreta}`);
    const totalSel = (hasCpf ? 1 : 0) + (hasCavalo ? 1 : 0) + (hasCarreta ? 1 : 0);
    const acaoLog = totalSel === 1 ? 'Gerando relatorio' : 'Gerando dossie';
    addLog('info', `${acaoLog}: ${partes.join(' | ')}`);

    try {
        const res = await fetch('/api/gerar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cpf, cavalo, carreta })
        });

        if (res.ok) {
            addLog('success', 'Processo iniciado no servidor.');
        } else {
            const err = await res.json();
            addLog('error', 'Falha: ' + err.detail);
            resetButton();
        }
    } catch (error) {
        addLog('error', 'Erro de comunicacao: ' + error.message);
        resetButton();
    }
}

function startTimer() {
    state.timerStart = Date.now();
    const display = document.getElementById('timer-display');
    const label = document.getElementById('timer-label');
    display.classList.remove('done');
    label.textContent = 'em andamento...';

    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - state.timerStart) / 1000);
        display.textContent = formatTime(elapsed);
    }, 500);
}

function stopTimer() {
    if (state.timerInterval) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
    }
    const display = document.getElementById('timer-display');
    const label = document.getElementById('timer-label');
    if (state.timerStart) {
        const total = Math.floor((Date.now() - state.timerStart) / 1000);
        display.textContent = formatTime(total);
        display.classList.add('done');
        label.textContent = 'tempo total';
    }
}

function formatTime(seconds) {
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function resetButton() {
    const btn = document.getElementById('gerar-btn');
    btn.disabled = false;
    btn.classList.remove('running');
    btn.textContent = 'Gerar Unificador';
    state.running = false;
    stopTimer();

    // Manter barra visivel com tempo total por 30s
    setTimeout(() => {
        const progressSection = document.getElementById('progress-section');
        progressSection.classList.remove('active');
    }, 30000);
}

function updateProgress(step, total, text) {
    const fill = document.getElementById('progress-fill');
    const stepEl = document.getElementById('progress-step');
    const pctEl = document.getElementById('progress-pct');

    const pct = total > 0 ? Math.round((step / total) * 100) : 0;
    fill.style.width = pct + '%';
    stepEl.textContent = text || `Passo ${step}/${total}`;
    pctEl.textContent = pct + '%';
}

async function updateLogs() {
    try {
        const response = await fetch('/api/logs');
        const logs = await response.json();

        if (logs.length > state.logs.length) {
            const newLogs = logs.slice(state.logs.length);
            state.logs = logs;
            appendLogsToUI(newLogs);

            // Atualizar barra de progresso
            for (let i = newLogs.length - 1; i >= 0; i--) {
                const log = newLogs[i];
                if (log.step !== undefined && log.total !== undefined) {
                    updateProgress(log.step, log.total, log.msg);
                    break;
                }
            }

            // Detectar conclusao
            const lastLog = newLogs[newLogs.length - 1];
            if (lastLog && state.running) {
                const level = (lastLog.level || '').toLowerCase();
                const isFinished = (level === 'success' && lastLog.step === lastLog.total) || level === 'error';
                if (isFinished) {
                    setTimeout(resetButton, 1500);
                }
            }
        }
    } catch (e) {
        // silencioso
    }
}

function appendLogsToUI(newLogs) {
    const feed = document.getElementById('log-feed');
    newLogs.forEach(log => {
        const div = document.createElement('div');
        div.className = `log-entry ${log.level.toLowerCase()}`;
        div.innerHTML = `<strong>[${log.time}]</strong> ${log.msg}`;
        feed.appendChild(div);
    });
    feed.scrollTop = feed.scrollHeight;
}

function addLog(level, msg) {
    appendLogsToUI([{
        time: new Date().toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit', second:'2-digit'}),
        level,
        msg
    }]);
}

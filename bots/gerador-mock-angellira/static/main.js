let state = {
    logs: [],
    running: false,
    timerInterval: null,
    timerStart: null
};

document.addEventListener('DOMContentLoaded', () => {
    setInterval(updateLogs, 1500);
    document.getElementById('gerar-btn').addEventListener('click', gerarPDF);
    document.getElementById('exemplo-btn').addEventListener('click', carregarExemplo);
    document.getElementById('limpar-btn').addEventListener('click', limparFormulario);
});

function limparFormulario() {
    document.getElementById('json-input').value = '';
    document.getElementById('json-input').focus();
}

async function carregarExemplo() {
    try {
        const res = await fetch('/api/exemplo');
        const data = await res.json();
        document.getElementById('json-input').value = JSON.stringify(data, null, 2);
        addLog('info', 'Exemplo carregado. Clique em Gerar PDF.');
    } catch (e) {
        addLog('error', 'Falha ao carregar exemplo: ' + e.message);
    }
}

async function gerarPDF() {
    const raw = document.getElementById('json-input').value.trim();
    if (!raw) {
        addLog('error', 'Cole um JSON antes de gerar.');
        document.getElementById('json-input').focus();
        return;
    }

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch (e) {
        addLog('error', 'JSON inválido: ' + e.message);
        return;
    }

    const enforce = document.getElementById('enforce-input').checked;
    const toDownloads = document.getElementById('downloads-input').checked;

    // UI: running state
    const btn = document.getElementById('gerar-btn');
    btn.disabled = true;
    btn.classList.add('running');
    btn.textContent = 'Gerando...';
    state.running = true;

    const progressSection = document.getElementById('progress-section');
    progressSection.classList.add('active');
    updateProgress(0, 1, 'Iniciando...');
    startTimer();

    addLog('info', 'Enviando JSON para renderização...');

    try {
        const res = await fetch('/api/gerar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload, enforce_conforme: enforce, to_downloads: toDownloads })
        });

        if (res.ok) {
            const data = await res.json();
            addLog('success', 'Processo iniciado. Componentes: ' + (data.components || []).join(', '));
        } else {
            const err = await res.json();
            addLog('error', 'Falha: ' + (err.detail || res.status));
            resetButton();
        }
    } catch (error) {
        addLog('error', 'Erro de comunicação: ' + error.message);
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
    btn.textContent = 'Gerar PDF';
    state.running = false;
    stopTimer();

    setTimeout(() => {
        document.getElementById('progress-section').classList.remove('active');
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

            for (let i = newLogs.length - 1; i >= 0; i--) {
                const log = newLogs[i];
                if (log.step !== undefined && log.total !== undefined) {
                    updateProgress(log.step, log.total, log.msg);
                    break;
                }
            }

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
        div.innerHTML = `<strong>[${log.time}]</strong> ${escapeHtml(log.msg)}`;
        feed.appendChild(div);
    });
    feed.scrollTop = feed.scrollHeight;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

function addLog(level, msg) {
    appendLogsToUI([{
        time: new Date().toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit', second: '2-digit'}),
        level,
        msg
    }]);
}

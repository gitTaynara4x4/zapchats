/* conectar.js — VERSÃO REVISADA COMPLETA */

// ==============================
// Utilidades rápidas
// ==============================
const $  = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

// ==============================
// Espera DOM pronto
// ==============================
document.addEventListener('DOMContentLoaded', () => {

  // ---------------------------------------------
  // Sessão básica
  // ---------------------------------------------
  const empresaId = localStorage.getItem('empresa_id');
  const jwtToken  = localStorage.getItem('token');

  if (!empresaId || !jwtToken) {
    alert('Você precisa estar logado para acessar esta página.');
    location.href = '/login.html';
    return;
  }

  const authHeader = { Authorization: `Bearer ${jwtToken}` };

  // ---------------------------------------------
  // Elementos principais
  // ---------------------------------------------
  const modal = $('#modal');
  const form  = $('#form-conectar');

  // ---------------------------------------------
  // Máscara telefone
  // ---------------------------------------------
  const inputNumero = $('#numero');
  inputNumero.addEventListener('input', e => {
    let v = e.target.value.replace(/\D/g, '');
    if (v.length <= 2) {
      v = v.replace(/^(\d{0,2})/, '($1');
    } else {
      v = v.replace(/^(\d{2})(\d+)/, '($1) $2');
    }
    e.target.value = v.slice(0, 15);
  });

  // ---------------------------------------------
  // Helpers modal
  // ---------------------------------------------
  const resetModal = () => {
    form.reset();
    $('#status-input').value = 'LIGADO';

    $$('.btn-status').forEach(b => b.classList.remove('bg-blue-600', 'text-white'));
    $('[data-status="LIGADO"]').classList.add('bg-blue-600', 'text-white');

    $$('.btn-origem').forEach(b => b.classList.remove('bg-blue-600', 'text-white'));
    $('[data-origem="NAC"]').classList.add('bg-blue-600', 'text-white');

    ['qr-canvas', 'qr-img', 'qr-instru', 'btn-refresh'].forEach(id => {
      $('#' + id)?.classList.add('hidden');
    });
  };

  $('#btn-open-modal')?.addEventListener('click', () => modal.classList.remove('hidden'));
  $('#btn-close-modal')?.addEventListener('click', () => { modal.classList.add('hidden'); resetModal(); });
  $('#btn-cancel')?.addEventListener('click', () => { modal.classList.add('hidden'); resetModal(); });
  $('#btn-ok')?.addEventListener('click', () => { modal.classList.add('hidden'); resetModal(); });

  $$('.btn-origem').forEach(btn => btn.addEventListener('click', () => {
    $$('.btn-origem').forEach(b => b.classList.remove('bg-blue-600', 'text-white'));
    btn.classList.add('bg-blue-600', 'text-white');
  }));

  $$('.btn-status').forEach(btn => btn.addEventListener('click', () => {
    $$('.btn-status').forEach(b => b.classList.remove('bg-blue-600', 'text-white'));
    btn.classList.add('bg-blue-600', 'text-white');
    $('#status-input').value = btn.dataset.status;
  }));

  // ---------------------------------------------
  // QRious fallback
  // ---------------------------------------------
  const qrious = new QRious({ element: $('#qr-canvas'), size: 200, level: 'H' });

  // ---------------------------------------------
  // SUBMIT → Cria instância e abre socket
  // ---------------------------------------------
  form.addEventListener('submit', async ev => {
    ev.preventDefault();

    const ddd     = $('#pais-select').value || '55';
    const numero  = inputNumero.value.replace(/\D/g, '');
    const apelido = ev.target.apelido.value || 'ZapChats';
    const status  = $('#status-input').value;
    const origem  = document.querySelector('.btn-origem.bg-blue-600')?.dataset.origem || 'NAC';

    const payload = {
      empresa_id: empresaId,
      numero    : ddd + numero,
      apelido,
      status,
      origem
    };

    try {
      const res = await fetch('/api/onboarding/empresas/conectar', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body   : JSON.stringify(payload)
      });

      if (!res.ok) throw new Error(await res.text());
      const { instanciaId } = await res.json();
      abrirSocket(instanciaId);

    } catch (err) {
      alert('Erro: ' + err.message);
    }
  });

  // ---------------------------------------------
  // WebSocket — Status & QR
  // ---------------------------------------------
  function abrirSocket(instId) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws    = new WebSocket(`${proto}://${location.host}/ws/inst:${instId}`);

    ws.onmessage = ev => {
      const d = JSON.parse(ev.data);

      if (d.base64) {
        $('#qr-img').src = d.base64;
        $('#qr-img').classList.remove('hidden');
        $('#qr-canvas').classList.add('hidden');
        $('#qr-instru').classList.remove('hidden');
        $('#btn-refresh').classList.remove('hidden');
      } else if (d.pairingCode) {
        qrious.value = d.pairingCode;
        $('#qr-canvas').classList.remove('hidden');
        $('#qr-img').classList.add('hidden');
        $('#qr-instru').classList.remove('hidden');
        $('#btn-refresh').classList.remove('hidden');
      }

      if (d.status === 'CONNECTED') {
        ws.close();
        modal.classList.add('hidden');
        resetModal();
        carregarZap();
      }
    };

    $('#btn-refresh').onclick = () => ws.send(JSON.stringify({ action: 'refresh_qr' }));
  }

  // ---------------------------------------------
  // Carrega lista ZapChats ativos/inativos
  // ---------------------------------------------
  async function carregarZap() {
    const res = await fetch(`/api/empresas/${empresaId}/whatsapp`, { headers: authHeader });
    if (!res.ok) return;
    const info = await res.json();

    $('[data-tab=ativos]').textContent   = `Ativos (${info.conectado ? 1 : 0})`;
    $('[data-tab=inativos]').textContent = `Inativos (${info.conectado ? 0 : 1})`;

    const tbl   = $('#lista-zap');
    const tbody = tbl.querySelector('tbody');

    if (info.conectado) {
      $('#placeholder-zap').classList.add('hidden');
      tbl.classList.remove('hidden');

      const numFmt = info.numero.replace(/^(\d{2})(\d{8,9})$/, '($1) $2');

      tbody.innerHTML = `
        <tr class="bg-blue-50">
          <td class="py-2">${info.apelido}</td>
          <td>${numFmt}</td>
          <td>${info.assinatura}</td>
          <td><span class="inline-block w-3 h-3 bg-green-500 rounded-full"></span></td>
          <td class="text-right text-xl text-gray-400">⋮</td>
        </tr>`;
      $('#count-pro').textContent = '1/1';
    } else {
      tbl.classList.add('hidden');
      $('#placeholder-zap').classList.remove('hidden');
      $('#count-pro').textContent = '0/1';
    }

    $('#msg-env').textContent = info.enviadas;
    $('#msg-rec').textContent = info.recebidas;
    $('#msg-tot').textContent = info.enviadas + info.recebidas;
  }

  carregarZap();

  // ---------------------------------------------
  // WebSocket geral — Atualizações
  // ---------------------------------------------
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsEmp = new WebSocket(`${proto}://${location.host}/ws/empresas/${empresaId}`);

  wsEmp.onmessage = ev => {
    const d = JSON.parse(ev.data);
    if (d.inst_status || d.mensagem) carregarZap();
  };

});

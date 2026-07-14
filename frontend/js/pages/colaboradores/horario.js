// frontend/js/pages/colaboradores/horario.js

import { state } from './state.js';
import { getDeptHorarioById } from './setores.js';

export function renderDeptHintBySetorId(setorId, opts = {}){
  const el = document.getElementById('dept-exp-hint');
  if (!el) return;

  const setorNome = opts.setorNome || '';
  const { ini, fim, has } = getDeptHorarioById(setorId, setorNome);

  if (!has){
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  const personalizar = !!opts.personalizar;

  const linha2 = personalizar
    ? '⚙️ <strong>Este colaborador está com horário personalizado.</strong>'
    : '✅ <strong>O colaborador usa esse horário automaticamente.</strong>';

  const cta = personalizar
    ? '<span style="opacity:.85">(desmarque “Personalizar horário” para voltar ao padrão.)</span>'
    : '<span style="opacity:.85">(marque “Personalizar horário” se precisar diferente.)</span>';

  el.style.display = 'block';
  el.innerHTML = `
    <strong>Horário padrão do departamento:</strong> ${ini || '—'}–${fim || '—'}<br>
    ${linha2}<br>
    ${cta}
  `.trim();
}

export function applyExpPersonalizarUI(){
  const rowToggle = document.getElementById('row-exp-toggle');
  const rowIni = document.getElementById('row-exp-ini');
  const rowFim = document.getElementById('row-exp-fim');
  const tgl = document.getElementById('e-exp-personalizar');

  if (!tgl || !rowIni || !rowFim) return;

  if (rowToggle) rowToggle.style.display = state.inlineEdit ? '' : 'none';

  const on = !!tgl.checked;

  rowIni.style.display = on ? '' : 'none';
  rowFim.style.display = on ? '' : 'none';

  const sel = document.getElementById('e-setor');
  const checkedDept = document.querySelector('#e-deptos input[name="dept-edit"]:checked');
  const setorId = sel?.value || checkedDept?.value || '';
  const setorNome = sel?.options?.[sel.selectedIndex]?.text || checkedDept?.closest('label')?.querySelector('strong')?.textContent || '';

  renderDeptHintBySetorId(setorId, {
    personalizar: on,
    setorNome
  });

  if (on){
    const eIni = document.getElementById('e-exp-ini');
    const eFim = document.getElementById('e-exp-fim');

    if (eIni && eFim && !String(eIni.value || '').trim() && !String(eFim.value || '').trim()){
      const { ini, fim } = getDeptHorarioById(setorId, setorNome);

      if (ini) eIni.value = ini;
      if (fim) eFim.value = fim;
    }
  } else {
    const eIni = document.getElementById('e-exp-ini');
    const eFim = document.getElementById('e-exp-fim');

    if (eIni) eIni.value = '';
    if (eFim) eFim.value = '';
  }
}

export function buildHorarioModoPayload(setorId, expOn){
  if (expOn) return 'personalizado';
  if (setorId) return 'departamento';
  return 'livre';
}
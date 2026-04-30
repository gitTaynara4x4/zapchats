// frontend/js/pages/colaboradores/setores.js

import { apiGet } from './api.js';
import { state } from './state.js';
import { $, } from './dom.js';
import { normStr } from './helpers.js';

export async function loadSetores(){
  const tries = [
    '/api/departamentos',
    '/api/departamentos/tree',
    '/api/atendimento/clientes/departamentos',
    '/api/atendimento/clientes/departamentos/tree'
  ];

  for (const u of tries){
    try {
      const data = await apiGet(u);
      const arr = Array.isArray(data) ? data : (data?.items || data?.data || []);

      if (arr?.length){
        const out = [];
        const seen = new Set();

        const getId = x =>
          x?.id ??
          x?.dep_id ??
          x?.departamento_id ??
          x?.setor_id ??
          x?.value ??
          x?.ID ??
          x?.Id;

        const getName = x =>
          x?.nome ??
          x?.name ??
          x?.titulo ??
          x?.label ??
          x?.text ??
          '—';

        const getIni = x =>
          x?.hora_login_inicio_padrao ??
          x?.hora_login_inicio ??
          x?.hora_inicio ??
          x?.expediente_inicio ??
          x?.horario_inicio ??
          x?.inicio_expediente ??
          x?.hora_entrada ??
          x?.entrada ??
          x?.expediente?.inicio ??
          x?.horario?.inicio ??
          null;

        const getFim = x =>
          x?.hora_login_fim_padrao ??
          x?.hora_login_fim ??
          x?.hora_fim ??
          x?.expediente_fim ??
          x?.horario_fim ??
          x?.fim_expediente ??
          x?.hora_saida ??
          x?.saida ??
          x?.expediente?.fim ??
          x?.horario?.fim ??
          null;

        const getKids = x =>
          x?.filhos ??
          x?.children ??
          x?.itens ??
          x?.items ??
          x?.nodes ??
          x?.departamentos ??
          x?.subdepartamentos ??
          x?.sub ??
          [];

        const walk = node => {
          if (!node) return;

          const id0 = getId(node);
          const id = id0 == null ? null : String(id0);
          const nome = String(getName(node) ?? '—');

          if (id && !seen.has(id)){
            seen.add(id);

            const ini = getIni(node);
            const fim = getFim(node);

            out.push({
              id,
              nome,
              hora_login_inicio_padrao: ini != null ? String(ini) : null,
              hora_login_fim_padrao: fim != null ? String(fim) : null,
              hora_login_inicio: ini != null ? String(ini) : null,
              hora_login_fim: fim != null ? String(fim) : null
            });
          }

          const kids = getKids(node);
          if (Array.isArray(kids)) kids.forEach(walk);
        };

        (Array.isArray(arr) ? arr : [arr]).forEach(walk);

        state.setores = out;
        renderSetores();
        return;
      }
    } catch (e) {
      console.warn('[colaboradores] tentativa de carregar setores falhou:', u, e);
    }
  }

  state.setores = [];
  renderSetores();
}

export function renderSetores(){
  const filtroDepto = $('#filtro-depto');
  const fSetor = $('#c-setor');

  if (filtroDepto){
    const first = filtroDepto.querySelector('option');

    filtroDepto.innerHTML = '';

    if (first) filtroDepto.appendChild(first);

    state.setores.forEach(s => {
      filtroDepto.appendChild(new Option(s.nome, s.id));
    });
  }

  if (fSetor){
    fSetor.innerHTML = '';

    state.setores.forEach(s => {
      fSetor.appendChild(new Option(s.nome, s.id));
    });
  }
}

export function getDeptHorarioById(setorId, setorNome){
  let s = state.setores.find(x => String(x.id) === String(setorId));

  if (!s && setorNome){
    const alvo = normStr(setorNome);
    s = state.setores.find(x => normStr(x?.nome) === alvo);
  }

  const ini = (s && (
    s.hora_login_inicio_padrao ??
    s.hora_login_inicio ??
    s.hora_inicio ??
    s.expediente_inicio ??
    s.horario_inicio ??
    s.inicio_expediente ??
    s.hora_entrada ??
    s.entrada ??
    s.expediente?.inicio ??
    s.horario?.inicio
  )) || '';

  const fim = (s && (
    s.hora_login_fim_padrao ??
    s.hora_login_fim ??
    s.hora_fim ??
    s.expediente_fim ??
    s.horario_fim ??
    s.fim_expediente ??
    s.hora_saida ??
    s.saida ??
    s.expediente?.fim ??
    s.horario?.fim
  )) || '';

  return {
    ini: String(ini || ''),
    fim: String(fim || ''),
    has: !!(ini || fim),
    dept: s || null
  };
}
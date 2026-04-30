// frontend/js/pages/colaboradores/coalesce.js

export function coalescePhone(c){
  return c?.telefone ??
    c?.telefone_norm ??
    c?.phone ??
    c?.celular ??
    c?.whatsapp ??
    c?.fone ??
    c?.usuario?.telefone ??
    c?.user?.phone ??
    '';
}

export function coalesceDeptId(c){
  if (!c) return null;

  return (
    c.setor_id ??
    c.departamento_id ??
    c.dep_id ??
    c.depto_id ??
    c.dept_id ??
    c.setor?.id ??
    c.departamento?.id ??
    c.depto?.id ??
    null
  );
}

export function coalesceDeptName(c){
  if (!c) return null;

  return (
    c.setor_nome ??
    c.departamento_nome ??
    c.departamento ??
    c.depto_nome ??
    c.dep_nome ??
    c.setor?.nome ??
    c.departamento?.nome ??
    c.depto?.nome ??
    null
  );
}

export function coalesceName(c){
  return c?.nome ??
    c?.nome_completo ??
    c?.display_name ??
    c?.full_name ??
    c?.usuario?.nome ??
    c?.user?.name ??
    '';
}

export function coalesceEmail(c){
  return c?.email ??
    c?.usuario?.email ??
    c?.user?.email ??
    '';
}

export function coalesceCargo(c){
  return c?.cargo ??
    c?.funcao ??
    c?.usuario?.cargo ??
    c?.user?.job_title ??
    '';
}

export function coalesceHorarioInicio(c){
  return c?.hora_login_inicio ??
    c?.hora_inicio ??
    c?.horario_inicio ??
    c?.expediente_inicio ??
    c?.inicio_expediente ??
    c?.hora_entrada ??
    null;
}

export function coalesceHorarioFim(c){
  return c?.hora_login_fim ??
    c?.hora_fim ??
    c?.horario_fim ??
    c?.expediente_fim ??
    c?.fim_expediente ??
    c?.hora_saida ??
    null;
}

export function isAdminFlag(c){
  return !!(c && (
    c.is_admin === true ||
    /^\s*admin\s*$/i.test(coalesceCargo(c) || '') ||
    (c.usuario && c.usuario.is_admin === true)
  ));
}
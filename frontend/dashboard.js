(async () => {
  // dados salvos no login
  const EMPRESA_ID = localStorage.getItem('empresa_id');
  const IS_ADMIN   = localStorage.getItem('is_admin') === 'true';

  if (!EMPRESA_ID){
    // usuário não autenticado
    return location.href = '/frontend/login.html';
  }

  if (IS_ADMIN){
    // busca dados da empresa para ver se já tem instance_name
    try{
      const inst = await fetch(`/empresas/${EMPRESA_ID}`)
                         .then(r=>r.ok ? r.json() : null);

      if (!inst || !inst.instance_name){
        // ainda não conectou o WhatsApp
        return location.href = '/frontend/conectar.html';
      }
      // já tem instância → CRUD de usuários
      return location.href = '/frontend/equipe.html';

    } catch(e){
      console.error(e);
      alert('Falha ao verificar empresa. Tente novamente.');
      return location.href = '/frontend/login.html';
    }
  }

  // atendente comum → painel de atendimento
  location.href = '/frontend/atendente.html';
})();

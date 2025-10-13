document.addEventListener("DOMContentLoaded", () => {
  const empresa_id = Number(localStorage.getItem('empresa_id'));
  const token = localStorage.getItem('token');
  const tbody = document.getElementById("tbody-usuarios");
  const modal = document.getElementById("modal");
  const btnAdd = document.getElementById("btnAdd");
  const btnCloseModal = document.getElementById("btnCloseModal");
  const form = document.getElementById("form-novo-usuario");
  const selectDepto = document.getElementById("select-departamento");

  // Abrir modal
  btnAdd.onclick = () => { modal.classList.remove("hidden"); };
  btnCloseModal.onclick = () => { modal.classList.add("hidden"); };
  modal.onclick = e => { if (e.target === modal) modal.classList.add("hidden"); };

  // Carregar Departamentos no Select
  async function carregarDepartamentos() {
    const res = await fetch(`/api/departamentos?empresa_id=${empresa_id}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    selectDepto.innerHTML = `<option value="">Selecione...</option>`;
    data.forEach(dep => {
      selectDepto.innerHTML += `<option value="${dep.id}">${dep.nome}</option>`;
    });
  }

  // Listar Usuários
  async function listarUsuarios() {
    const res = await fetch(`/api/usuarios?empresa_id=${empresa_id}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    tbody.innerHTML = "";
    data.forEach(u => {
      tbody.innerHTML += `
        <tr class="border-b">
          <td class="px-4 py-3">${u.nome}</td>
          <td class="px-4 py-3">${u.email}</td>
          <td class="px-4 py-3">${u.departamento_nome || "-"}</td>
          <td class="px-4 py-3 capitalize">${u.cargo || "-"}</td>
        </tr>`;
    });
  }

  // Cadastrar Usuário
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const payload = {
      empresa_id,
      nome: f.nome.value.trim(),
      email: f.email.value.trim(),
      senha: f.senha.value.trim(),
      departamento_id: Number(f.departamento_id.value),
      cargo: f.cargo.value
    };
    const res = await fetch('/api/usuarios', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      modal.classList.add("hidden");
      form.reset();
      await listarUsuarios();
      alert("Usuário cadastrado com sucesso!");
    } else {
      let err = await res.json();
      alert('Erro: ' + (err.detail || JSON.stringify(err)));
    }
  };
// Pega todas as mensagens do banco para a lista extra
fetch(`/api/inicio/todas_mensagens?empresa_id=${empresa_id}`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
})
.then(r => r.json())
.then(data => {
  const listaMensagens = document.getElementById('listaMensagens');
  if (!data.mensagens.length) {
    listaMensagens.innerHTML = '<li class="py-2 text-gray-400">Nenhuma mensagem encontrada.</li>';
    return;
  }
  listaMensagens.innerHTML = '';
  data.mensagens.forEach(msg => {
    const tipoCor = msg.tipo === "entrada" ? "text-green-800" : "text-blue-900";
    listaMensagens.innerHTML += `
      <li class="py-2 flex items-center gap-2">
        <span class="font-bold ${tipoCor}">${msg.nome}:</span>
        <span>${msg.conteudo}</span>
        <span class="ml-auto text-xs text-gray-400">${msg.hora} ${msg.data}</span>
      </li>
    `;
  });
});
  // Inicializar
  carregarDepartamentos();
  listarUsuarios();
});

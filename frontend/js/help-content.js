// Help Center global do ZapsChat.
// Este arquivo existe para manter o carregamento global do head-base sem 404
// e para concentrar metadados das ajudas por página.
(function(){
  'use strict';

  window.ZAPS_HELP_CONTENT = window.ZAPS_HELP_CONTENT || {
    dashboard: {
      path: 'dashboard.html',
      title: 'Dashboard',
      desc: 'Visão rápida dos atendimentos, WhatsApps e principais indicadores.'
    },
    atendimentos: {
      path: 'atendimentos.html',
      title: 'Atendimentos',
      desc: 'Lista de conversas, filtros, histórico, envio de mensagens e ações do cliente.'
    },
    clientes: {
      path: 'clientes.html',
      title: 'Clientes',
      desc: 'Busca, filtros, cadastro, tabela, importação e exportação de contatos.'
    },
    colaboradores: {
      path: 'colaboradores.html',
      title: 'Colaboradores',
      desc: 'Cadastro da equipe, acessos, permissões, departamentos e WhatsApps permitidos.'
    },
    departamentos: {
      path: 'departamentos.html',
      title: 'Departamentos',
      desc: 'Organograma, setores, hierarquia, painel lateral, horários e instâncias.'
    },
    chatbot: {
      path: 'chatbot.html',
      title: 'Chatbot',
      desc: 'Mensagens automáticas, fora de horário, menu de departamentos e preview.'
    },
    disparos: {
      path: 'disparos.html',
      title: 'Disparos',
      desc: 'Envio em massa com instância, mensagem, contatos, revisão e intervalo.'
    },
    midias: {
      path: 'midias.html',
      title: 'Mídias',
      desc: 'Biblioteca de arquivos, busca, filtros, recentes, lista e detalhes.'
    },
    whatsapp: {
      path: 'conectar.html',
      title: 'Conexão WhatsApp',
      desc: 'Status dos números, QR Code, reconexão e conexão de novas instâncias.'
    },
    chatInterno: {
      path: 'chat-interno.html',
      title: 'Chat Interno',
      desc: 'Conversas da equipe, grupos, menções, contatos, anexos e perfil.'
    },
    configuracoes: {
      path: 'configuracoes.html',
      title: 'Configurações',
      desc: 'Tema, feedback, dados da empresa, atendimento e preferências gerais.'
    }
  };
})();

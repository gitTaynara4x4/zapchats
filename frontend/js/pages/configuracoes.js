/* Configuração – ZapChats (ajustada)
   Endpoints esperados (iguais aos atuais):
   - GET  /api/settings
   - PUT  /api/settings                (body JSON completo)
   - GET  /api/setores/                (popula departamentos)
*/

(function(){
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const toast = (msg, ok=true) => {
    const t = $('#toast'); if(!t) return;
    t.textContent = msg;
    t.style.borderColor = ok ? 'var(--border)' : 'var(--red)';
    t.classList.add('show');
    setTimeout(()=> t.classList.remove('show'), 2800);
  };

  const API = {
    settings: '/api/settings',
    setores: '/api/setores/'
  };

  // ======= Modelo enxuto =======
  let model = defaults();

  function defaults(){
    return {
      branding: {
        org_name:'', support_email:'',
        // novo: logo em base64 (data URL); backend pode persistir sem multipart
        logo_data:''    // "data:image/png;base64,AAAA..."
      },
      business_hours: [{ department_id: 'default', days:[1,2,3,4,5], start:'08:00', end:'18:00' }],
      messages: { greeting:'', off_hours:'', survey:'' },
      notifications: { browser:true, email:false },
      privacy: { retention_days:180, allow_export:true },
      routing: { default_department_id:'' }
    };
  }

  // ======= Binds =======
  function fillForm(m){
    // Empresa
    $('#org_name').value = m.branding.org_name || '';
    $('#support_email').value = m.branding.support_email || '';
    if (m.branding.logo_data){
      showLogoPreview(m.branding.logo_data);
    } else {
      hideLogoPreview();
    }

    // Horário
    const days = new Set((m.business_hours?.[0]?.days)||[1,2,3,4,5]);
    ['0','1','2','3','4','5','6'].forEach(d => { $('#d'+d).checked = days.has(+d); });
    $('#h_start').value = m.business_hours?.[0]?.start || '08:00';
    $('#h_end').value = m.business_hours?.[0]?.end || '18:00';
    $('#default_department').value = m.routing?.default_department_id || '';

    // Mensagens
    $('#msg_greeting').value = m.messages?.greeting || '';
    $('#msg_off').value = m.messages?.off_hours || '';
    $('#msg_survey').value = m.messages?.survey || '';

    // Notificações
    $('#notif_browser').checked = !!m.notifications?.browser;
    $('#notif_email').checked = !!m.notifications?.email;

    // Privacidade
    $('#privacy_retention').value = m.privacy?.retention_days ?? 180;
    $('#privacy_export').checked = !!m.privacy?.allow_export;
  }

  function readForm(){
    const days = ['0','1','2','3','4','5','6'].filter(d => $('#d'+d).checked).map(Number);
    return {
      branding: {
        org_name: $('#org_name').value.trim(),
        support_email: $('#support_email').value.trim(),
        logo_data: model.branding.logo_data || ''
      },
      business_hours: [{
        department_id: 'default',
        days: days.length? days : [1,2,3,4,5],
        start: $('#h_start').value || '08:00',
        end: $('#h_end').value || '18:00'
      }],
      messages: {
        greeting: $('#msg_greeting').value,
        off_hours: $('#msg_off').value,
        survey: $('#msg_survey').value
      },
      notifications: {
        browser: $('#notif_browser').checked,
        email: $('#notif_email').checked
      },
      privacy: {
        retention_days: parseInt($('#privacy_retention').value||'180',10),
        allow_export: $('#privacy_export').checked
      },
      routing: {
        default_department_id: $('#default_department').value || ''
      }
    };
  }

  // ======= Logo (upload + preview acessível) =======
  const fileInput = $('#logo_file');
  fileInput.addEventListener('change', async (e)=>{
    const f = e.target.files && e.target.files[0];
    if (!f) { hideLogoPreview(); model.branding.logo_data=''; return; }
    if (!/^image\//.test(f.type)) { toast('Envie uma imagem (PNG/SVG/JPG).', false); return; }
    const dataUrl = await toDataURL(f);
    model.branding.logo_data = dataUrl;
    showLogoPreview(dataUrl, f);
  });

  function toDataURL(file){
    return new Promise((resolve, reject)=>{
      const r = new FileReader();
      r.onerror = reject;
      r.onload = () => resolve(r.result);
      r.readAsDataURL(file);
    });
  }

  function showLogoPreview(dataUrl, file){
    const wrap = $('#logo_preview'); const img = $('#logo_img'); const meta = $('#logo_meta');
    img.src = dataUrl;
    img.alt = 'Prévia da logo da empresa'; // acessibilidade
    meta.textContent = file ? `${file.name} • ${(file.size/1024|0)} KB` : 'Logo carregada';
    wrap.hidden = false;
  }
  function hideLogoPreview(){
    const wrap = $('#logo_preview'); const img = $('#logo_img'); const meta = $('#logo_meta');
    img.removeAttribute('src'); img.alt = ''; meta.textContent = '';
    wrap.hidden = true;
  }

  // ======= Departamentos =======
  async function loadDepartamentos(){
    try{
      const res = await fetch(API.setores, {credentials:'include'});
      if(!res.ok) throw 0;
      const arr = await res.json();
      const sel = $('#default_department');
      sel.innerHTML = '<option value="">— escolher —</option>';
      (arr||[]).forEach(d=>{
        const o = document.createElement('option');
        o.value = d.id ?? d.setor_id ?? d._id ?? '';
        o.textContent = d.nome || d.name || `Depto ${o.value}`;
        sel.appendChild(o);
      });
      if(model.routing?.default_department_id){
        sel.value = model.routing.default_department_id;
      }
    }catch{
      const sel = $('#default_department');
      sel.innerHTML = '<option value="">Padrão</option>';
    }
  }

  // ======= Tabs =======
  (function tabs(){
    const tabbar = $('#tabbar'); if(!tabbar) return;
    tabbar.addEventListener('click', (e)=>{
      const b = e.target.closest('button[data-tab]'); if(!b) return;
      $$('#tabbar button').forEach(x=>x.classList.toggle('active', x===b));
      const id = b.dataset.tab;
      $$('section.box[data-panel]').forEach(p=> p.hidden = (p.dataset.panel !== id));
    });
  })();

  // ======= Load/Save =======
  async function loadSettings(){
    try{
      const res = await fetch(API.settings, {credentials:'include'});
      if(!res.ok) throw 0;
      const data = await res.json();
      model = Object.assign(defaults(), sanitizeIncoming(data||{}));
      fillForm(model);
      toast('Configurações carregadas');
    }catch{
      fillForm(model);
      toast('Usando configurações padrão', false);
    }
    loadDepartamentos();
  }

  function sanitizeIncoming(data){
    // Garante compatibilidade com o payload antigo
    const m = defaults();
    const out = Object.assign({}, m, data);

    // Aceita logos antigas por URL se existirem e converte depois se quiser
    if (data.branding){
      out.branding = {
        org_name: data.branding.org_name || '',
        support_email: data.branding.support_email || '',
        logo_data: data.branding.logo_data || ''  // se não tiver, fica vazio
      };
    }
    // Horário
    if (!Array.isArray(out.business_hours) || !out.business_hours.length){
      out.business_hours = m.business_hours;
    } else {
      const b0 = out.business_hours[0];
      out.business_hours = [{
        department_id: b0.department_id || 'default',
        days: Array.isArray(b0.days) && b0.days.length ? b0.days : [1,2,3,4,5],
        start: b0.start || '08:00',
        end: b0.end || '18:00'
      }];
    }
    return out;
  }

  async function saveSettings(){
    const btn = $('#btn-salvar');
    btn.disabled = true; btn.textContent = 'Salvando...';
    const payload = readForm();
    try{
      const res = await fetch(API.settings, {
        method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload), credentials:'include'
      });
      if(!res.ok) throw 0;
      model = payload;
      toast('Configurações salvas com sucesso');
    }catch{
      toast('Falha ao salvar configurações', false);
    }finally{
      btn.disabled = false; btn.textContent = 'Salvar alterações';
    }
  }

  // ======= Eventos =======
  $('#btn-salvar').addEventListener('click', saveSettings);
  $('#btn-delete-data').addEventListener('click', ()=>{
    if(confirm('Confirmar solicitação de limpeza/anonimização de dados?')){
      toast('Solicitação registrada. Um administrador será notificado.');
      // POST /api/settings/privacy/cleanup-request (futuro)
    }
  });

  // Carrega
  loadSettings();
})();

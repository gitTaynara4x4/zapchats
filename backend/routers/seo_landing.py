from __future__ import annotations

import html
import os
from datetime import datetime, timezone
from typing import Dict, List

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, PlainTextResponse, Response

router = APIRouter(tags=["SEO Landing Pages"])

BASE_URL = (os.getenv("PUBLIC_BASE_URL") or "https://www.ZapsChat.com.br").rstrip("/")
WA_NUMBER = os.getenv("ZAPSCHAT_WA_NUMBER", "5512991865418")


PAGES: List[Dict[str, str]] = [
    {
        "slug": "crm-para-whatsapp",
        "keyword": "CRM para WhatsApp",
        "title": "CRM para WhatsApp Business | Organize vendas e atendimento",
        "description": "CRM para WhatsApp Business com multiatendimento, histórico, funil comercial, responsáveis, setores e automação para empresas.",
        "h1": "CRM para WhatsApp Business para organizar vendas e atendimento",
        "intent": "Empresas que querem centralizar conversas, histórico, funil comercial e responsáveis em um painel único.",
    },
    {
        "slug": "multiatendimento-whatsapp",
        "keyword": "multiatendimento WhatsApp",
        "title": "Multiatendimento WhatsApp | Vários atendentes no mesmo número",
        "description": "Sistema de multiatendimento WhatsApp para equipes com responsáveis, filas, setores, histórico e controle de conversas.",
        "h1": "Multiatendimento WhatsApp para vários atendentes no mesmo painel",
        "intent": "Empresas com equipe comercial, suporte ou financeiro que precisam atender pelo WhatsApp sem bagunça.",
    },
    {
        "slug": "software-atendimento-whatsapp",
        "keyword": "software de atendimento WhatsApp",
        "title": "Software de Atendimento WhatsApp para Empresas | ZapsChat",
        "description": "Software de atendimento WhatsApp com filas, CRM, multiatendimento, automação, relatórios e histórico centralizado.",
        "h1": "Software de atendimento WhatsApp para empresas",
        "intent": "Negócios que querem trocar atendimento manual por uma operação com controle, histórico e relatórios.",
    },
    {
        "slug": "sistema-para-whatsapp-business",
        "keyword": "sistema para WhatsApp Business",
        "title": "Sistema para WhatsApp Business com CRM e Multiatendimento",
        "description": "Sistema para WhatsApp Business com CRM, múltiplos usuários, filas, automação e controle por setor.",
        "h1": "Sistema para WhatsApp Business com CRM, filas e automação",
        "intent": "Empresas que usam WhatsApp Business e precisam profissionalizar o atendimento.",
    },
    {
        "slug": "plataforma-atendimento-whatsapp",
        "keyword": "plataforma de atendimento WhatsApp",
        "title": "Plataforma de Atendimento WhatsApp | Controle sua operação",
        "description": "Plataforma de atendimento WhatsApp para centralizar clientes, setores, responsáveis, histórico, automações e relatórios.",
        "h1": "Plataforma de atendimento WhatsApp para controlar sua equipe",
        "intent": "Gestores que querem acompanhar conversas, produtividade e responsáveis em tempo real.",
    },
    {
        "slug": "filas-atendimento-whatsapp",
        "keyword": "filas de atendimento WhatsApp",
        "title": "Filas de Atendimento WhatsApp | Comercial, Suporte e Financeiro",
        "description": "Organize filas de atendimento WhatsApp por setor, responsável e prioridade com histórico centralizado no ZapsChat.",
        "h1": "Filas de atendimento WhatsApp para separar setores e organizar conversas",
        "intent": "Empresas que precisam separar atendimento entre comercial, suporte, financeiro e outros departamentos.",
    },
    {
        "slug": "chatbot-whatsapp-empresas",
        "keyword": "chatbot WhatsApp para empresas",
        "title": "Chatbot WhatsApp para Empresas | Automação e triagem",
        "description": "Chatbot WhatsApp para empresas com triagem por setor, mensagens automáticas, regras de horário e encaminhamento para atendentes.",
        "h1": "Chatbot WhatsApp para empresas com triagem e automação",
        "intent": "Empresas que querem responder rápido, direcionar clientes e reduzir atendimentos repetitivos.",
    },
    {
        "slug": "controle-atendimento-whatsapp",
        "keyword": "controle de atendimento WhatsApp",
        "title": "Controle de Atendimento WhatsApp | Responsável, status e histórico",
        "description": "Tenha controle de atendimento WhatsApp com responsável por conversa, status, setor, histórico e relatórios.",
        "h1": "Controle de atendimento WhatsApp para parar de perder clientes",
        "intent": "Empresas que sofrem com conversas perdidas, demora na resposta e falta de responsável.",
    },
    {
        "slug": "whatsapp-para-equipes",
        "keyword": "WhatsApp para equipes",
        "title": "WhatsApp para Equipes | Atendimento compartilhado com controle",
        "description": "Use WhatsApp para equipes com vários atendentes, histórico centralizado, filas, permissões e automação.",
        "h1": "WhatsApp para equipes com atendimento compartilhado e organizado",
        "intent": "Times que querem atender clientes no mesmo WhatsApp sem perder controle da operação.",
    },
    {
        "slug": "crm-whatsapp-business",
        "keyword": "CRM WhatsApp Business",
        "title": "CRM WhatsApp Business | Histórico, funil e atendimento em equipe",
        "description": "CRM WhatsApp Business para organizar contatos, histórico, funil comercial, setores e atendimento em equipe.",
        "h1": "CRM WhatsApp Business para vender e atender melhor",
        "intent": "Empresas que querem transformar o WhatsApp em uma operação comercial organizada.",
    },
    {
        "slug": "sistema-de-atendimento-online",
        "keyword": "sistema de atendimento online",
        "title": "Sistema de Atendimento Online integrado ao WhatsApp",
        "description": "Sistema de atendimento online com WhatsApp, CRM, filas, histórico, automação e relatórios para empresas.",
        "h1": "Sistema de atendimento online para organizar sua equipe no WhatsApp",
        "intent": "Empresas que buscam atendimento online centralizado, com histórico e gestão de equipe.",
    },
    {
        "slug": "gestao-de-atendimento-whatsapp",
        "keyword": "gestão de atendimento WhatsApp",
        "title": "Gestão de Atendimento WhatsApp | Controle de equipe e conversas",
        "description": "Faça gestão de atendimento WhatsApp com responsáveis, setores, filas, histórico, relatórios e automações.",
        "h1": "Gestão de atendimento WhatsApp com controle, histórico e relatórios",
        "intent": "Donos e gestores que precisam saber quem atende, quem respondeu e quais clientes estão parados.",
    },
]


def _esc(value: str) -> str:
    return html.escape(str(value or ""), quote=True)


def _wa_link(message: str) -> str:
    from urllib.parse import quote

    return f"https://wa.me/{WA_NUMBER}?text={quote(message)}"


def _find_page(slug: str) -> Dict[str, str]:
    for page in PAGES:
        if page["slug"] == slug:
            return page
    raise HTTPException(status_code=404, detail="Página não encontrada")


def _json_ld(page: Dict[str, str]) -> str:
    canonical = f"{BASE_URL}/solucoes/{page['slug']}"

    return f"""
<script type="application/ld+json">
{{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "ZapsChat Connect",
  "applicationCategory": "BusinessApplication",
  "operatingSystem": "Web",
  "url": "{canonical}",
  "image": "{BASE_URL}/frontend/img/sistema-zapchat.png",
  "brand": {{
    "@type": "Brand",
    "name": "ZapsChat Connect"
  }},
  "description": "{_esc(page["description"])}",
  "offers": {{
    "@type": "Offer",
    "priceCurrency": "BRL",
    "price": "97",
    "availability": "https://schema.org/InStock",
    "url": "{BASE_URL}/#planos"
  }}
}}
</script>

<script type="application/ld+json">
{{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {{
      "@type": "Question",
      "name": "O ZapsChat serve para {_esc(page["keyword"])}?",
      "acceptedAnswer": {{
        "@type": "Answer",
        "text": "Sim. O ZapsChat ajuda empresas a organizar atendimento via WhatsApp com CRM, histórico, responsáveis, setores, filas, automação e relatórios."
      }}
    }},
    {{
      "@type": "Question",
      "name": "Dá para usar com vários atendentes?",
      "acceptedAnswer": {{
        "@type": "Answer",
        "text": "Sim. A plataforma permite atendimento em equipe, com controle por usuários, histórico centralizado e organização por setores."
      }}
    }},
    {{
      "@type": "Question",
      "name": "Tem diagnóstico grátis?",
      "acceptedAnswer": {{
        "@type": "Answer",
        "text": "Sim. Você pode chamar no WhatsApp para fazer um diagnóstico gratuito do atendimento atual da sua empresa."
      }}
    }}
  ]
}}
</script>

<script type="application/ld+json">
{{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {{
      "@type": "ListItem",
      "position": 1,
      "name": "Início",
      "item": "{BASE_URL}/"
    }},
    {{
      "@type": "ListItem",
      "position": 2,
      "name": "Soluções",
      "item": "{BASE_URL}/solucoes/{page["slug"]}"
    }},
    {{
      "@type": "ListItem",
      "position": 3,
      "name": "{_esc(page["keyword"])}",
      "item": "{canonical}"
    }}
  ]
}}
</script>
""".strip()


def _render_page(page: Dict[str, str]) -> str:
    keyword = page["keyword"]
    title = page["title"]
    description = page["description"]
    h1 = page["h1"]
    intent = page["intent"]
    canonical = f"{BASE_URL}/solucoes/{page['slug']}"
    wa = _wa_link(f"Olá! Quero fazer um diagnóstico grátis sobre {keyword} para minha empresa.")

    return f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />

  <title>{_esc(title)}</title>
  <meta name="description" content="{_esc(description)}" />
  <meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1" />
  <link rel="canonical" href="{canonical}" />

  <meta property="og:type" content="website" />
  <meta property="og:locale" content="pt_BR" />
  <meta property="og:site_name" content="ZapsChat Connect" />
  <meta property="og:url" content="{canonical}" />
  <meta property="og:title" content="{_esc(title)}" />
  <meta property="og:description" content="{_esc(description)}" />
  <meta property="og:image" content="{BASE_URL}/frontend/img/sistema-zapchat.png" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{_esc(title)}" />
  <meta name="twitter:description" content="{_esc(description)}" />
  <meta name="twitter:image" content="{BASE_URL}/frontend/img/sistema-zapchat.png" />

  <link rel="icon" href="/frontend/img/fav-icon.png" type="image/png" />
  <link rel="preload" as="image" href="/frontend/img/Logo.png" />
  <link rel="preload" as="image" href="/frontend/img/sistema-zapchat.png" />

  <style>
    :root {{
      --bg: #07130d;
      --card: rgba(255,255,255,.075);
      --card2: rgba(255,255,255,.045);
      --text: #f4fff8;
      --muted: rgba(244,255,248,.72);
      --line: rgba(255,255,255,.13);
      --green: #25d366;
      --green2: #0ea85a;
      --white: #ffffff;
      --shadow: 0 24px 90px rgba(0,0,0,.35);
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}

    * {{
      box-sizing: border-box;
    }}

    body {{
      margin: 0;
      background:
        radial-gradient(circle at 20% 0%, rgba(37,211,102,.25), transparent 32%),
        radial-gradient(circle at 80% 10%, rgba(14,168,90,.18), transparent 30%),
        linear-gradient(180deg, #07130d, #0a0f0d 58%, #050706);
      color: var(--text);
      line-height: 1.55;
    }}

    a {{
      color: inherit;
    }}

    .container {{
      width: min(1120px, calc(100% - 36px));
      margin: 0 auto;
    }}

    .top {{
      border-bottom: 1px solid var(--line);
      background: rgba(0,0,0,.18);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 10;
    }}

    .nav {{
      height: 74px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
    }}

    .logo img {{
      display: block;
      height: 42px;
      width: auto;
    }}

    .nav-links {{
      display: flex;
      gap: 18px;
      align-items: center;
      color: var(--muted);
      font-size: 14px;
      font-weight: 700;
    }}

    .nav-links a {{
      text-decoration: none;
    }}

    .btn {{
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 46px;
      border-radius: 999px;
      padding: 0 20px;
      text-decoration: none;
      font-weight: 900;
      border: 1px solid transparent;
    }}

    .btn-primary {{
      color: #041008;
      background: linear-gradient(135deg, var(--green), #7CFFB2);
      box-shadow: 0 18px 44px rgba(37,211,102,.22);
    }}

    .btn-ghost {{
      border-color: var(--line);
      background: rgba(255,255,255,.06);
      color: var(--white);
    }}

    .hero {{
      padding: 82px 0 52px;
    }}

    .hero-grid {{
      display: grid;
      grid-template-columns: 1.03fr .97fr;
      gap: 46px;
      align-items: center;
    }}

    .badge {{
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid rgba(37,211,102,.24);
      background: rgba(37,211,102,.11);
      color: #a8ffd0;
      border-radius: 999px;
      padding: 8px 12px;
      font-weight: 900;
      font-size: 13px;
      margin-bottom: 18px;
    }}

    h1 {{
      font-size: clamp(36px, 5vw, 66px);
      line-height: .98;
      letter-spacing: -.055em;
      margin: 0 0 18px;
    }}

    .lead {{
      color: var(--muted);
      font-size: 19px;
      max-width: 720px;
      margin: 0 0 24px;
    }}

    .actions {{
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin: 28px 0 0;
    }}

    .preview {{
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255,255,255,.11), rgba(255,255,255,.04));
      border-radius: 28px;
      padding: 12px;
      box-shadow: var(--shadow);
    }}

    .preview img {{
      width: 100%;
      height: auto;
      border-radius: 20px;
      display: block;
      background: #111;
    }}

    .section {{
      padding: 68px 0;
    }}

    .section.white {{
      background: #f7faf8;
      color: #0b1b12;
    }}

    .section.white .muted,
    .section.white p {{
      color: rgba(11,27,18,.72);
    }}

    .kicker {{
      color: var(--green2);
      font-weight: 950;
      text-transform: uppercase;
      letter-spacing: .12em;
      font-size: 12px;
    }}

    h2 {{
      font-size: clamp(28px, 4vw, 46px);
      letter-spacing: -.04em;
      line-height: 1.05;
      margin: 10px 0 12px;
    }}

    .cards {{
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 18px;
      margin-top: 26px;
    }}

    .card {{
      border: 1px solid rgba(0,0,0,.08);
      background: #fff;
      border-radius: 24px;
      padding: 24px;
      box-shadow: 0 14px 38px rgba(0,0,0,.06);
    }}

    .dark-card {{
      border-color: var(--line);
      background: var(--card);
    }}

    .dark-card p {{
      color: var(--muted);
    }}

    .card h3 {{
      font-size: 20px;
      margin: 0 0 8px;
      letter-spacing: -.02em;
    }}

    .card p {{
      margin: 0;
    }}

    .list {{
      display: grid;
      gap: 12px;
      padding: 0;
      margin: 24px 0 0;
      list-style: none;
    }}

    .list li {{
      border: 1px solid rgba(37,211,102,.18);
      background: rgba(37,211,102,.08);
      border-radius: 16px;
      padding: 14px 16px;
      font-weight: 800;
    }}

    .cta {{
      text-align: center;
      border: 1px solid rgba(37,211,102,.22);
      background: linear-gradient(135deg, rgba(37,211,102,.18), rgba(255,255,255,.05));
      border-radius: 32px;
      padding: 42px 24px;
    }}

    .footer {{
      border-top: 1px solid var(--line);
      padding: 34px 0;
      color: var(--muted);
      font-size: 14px;
    }}

    .seo-links {{
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 18px;
    }}

    .seo-links a {{
      color: var(--muted);
      text-decoration: none;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 7px 10px;
    }}

    @media (max-width: 880px) {{
      .hero-grid,
      .cards {{
        grid-template-columns: 1fr;
      }}

      .nav-links {{
        display: none;
      }}
    }}
  </style>

  {_json_ld(page)}
</head>

<body>
  <header class="top">
    <div class="container">
      <nav class="nav" aria-label="Principal">
        <a class="logo" href="/" aria-label="ZapsChat Connect">
          <img src="/frontend/img/Logo.png" alt="ZapsChat Connect" width="220" height="42" />
        </a>

        <div class="nav-links">
          <a href="/">Início</a>
          <a href="/#planos">Planos</a>
          <a href="/#faq">FAQ</a>
        </div>

        <a class="btn btn-primary" href="{wa}" target="_blank" rel="noopener noreferrer">
          Diagnóstico grátis
        </a>
      </nav>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="container hero-grid">
        <div>
          <div class="badge">🎯 {_esc(keyword)} para empresas</div>
          <h1>{_esc(h1)}</h1>
          <p class="lead">
            O ZapsChat Connect ajuda empresas que precisam de {_esc(keyword)} com atendimento compartilhado,
            CRM, histórico centralizado, filas, setores, responsáveis, automações e relatórios.
          </p>

          <p class="lead">
            {_esc(intent)} Se hoje sua equipe atende pelo WhatsApp sem controle, é possível que clientes estejam
            esperando resposta, conversas estejam sendo duplicadas e oportunidades estejam ficando sem acompanhamento.
          </p>

          <div class="actions">
            <a class="btn btn-primary" href="{wa}" target="_blank" rel="noopener noreferrer">
              Fazer diagnóstico grátis
            </a>
            <a class="btn btn-ghost" href="/#planos">
              Ver planos
            </a>
          </div>
        </div>

        <div class="preview">
          <img
            src="/frontend/img/sistema-zapchat.png"
            alt="Painel do ZapsChat Connect para {_esc(keyword)}"
            width="1200"
            height="800"
            loading="eager"
            decoding="async"
          />
        </div>
      </div>
    </section>

    <section class="section white">
      <div class="container">
        <span class="kicker">Problema</span>
        <h2>Sem controle no WhatsApp, sua empresa pode perder clientes todos os dias</h2>
        <p class="muted">
          Quando o atendimento fica espalhado em celulares ou conversas sem responsável, fica difícil saber
          quem respondeu, quem esqueceu, qual cliente está parado e qual oportunidade foi perdida.
        </p>

        <div class="cards">
          <article class="card">
            <h3>Cliente sem resposta</h3>
            <p>Mensagens chegam e ficam paradas porque ninguém assumiu a conversa.</p>
          </article>

          <article class="card">
            <h3>Equipe sem organização</h3>
            <p>Dois atendentes podem responder o mesmo cliente enquanto outros clientes ficam esquecidos.</p>
          </article>

          <article class="card">
            <h3>Dono sem visibilidade</h3>
            <p>Sem relatório e histórico, o gestor não sabe onde a operação está falhando.</p>
          </article>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <span class="kicker">Solução</span>
        <h2>Como o ZapsChat ajuda com {_esc(keyword)}</h2>
        <p class="lead">
          A plataforma centraliza o atendimento via WhatsApp e cria um processo para sua equipe trabalhar
          com mais controle, velocidade e histórico.
        </p>

        <div class="cards">
          <article class="card dark-card">
            <h3>Responsável por conversa</h3>
            <p>Cada atendimento pode ter responsável, status, setor e histórico.</p>
          </article>

          <article class="card dark-card">
            <h3>Filas e setores</h3>
            <p>Organize Comercial, Suporte, Financeiro e outros departamentos em filas separadas.</p>
          </article>

          <article class="card dark-card">
            <h3>CRM e histórico</h3>
            <p>Veja contatos, anotações, mensagens antigas, etapas e contexto do cliente.</p>
          </article>
        </div>

        <ul class="list">
          <li>✅ Atendimento compartilhado para vários colaboradores</li>
          <li>✅ Histórico centralizado para não depender do celular de um funcionário</li>
          <li>✅ Automação de mensagens, horários, triagem e respostas rápidas</li>
          <li>✅ Relatórios para acompanhar volume, produtividade e gargalos</li>
        </ul>
      </div>
    </section>

    <section class="section white">
      <div class="container">
        <span class="kicker">Diagnóstico grátis</span>
        <h2>Descubra onde sua empresa está perdendo clientes no WhatsApp</h2>
        <p>
          Você chama no WhatsApp, explica como atende hoje e recebe uma análise simples sobre pontos de perda:
          demora, falta de responsável, ausência de fila, falta de histórico e pouca visão da operação.
        </p>

        <div class="actions">
          <a class="btn btn-primary" href="{wa}" target="_blank" rel="noopener noreferrer">
            Quero meu diagnóstico grátis
          </a>
          <a class="btn btn-ghost" href="/">
            Conhecer o ZapsChat
          </a>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container cta">
        <h2>Quer organizar o WhatsApp da sua empresa?</h2>
        <p class="lead" style="margin-left:auto;margin-right:auto;">
          Faça um diagnóstico grátis e veja como o ZapsChat pode ajudar sua operação a vender mais,
          responder melhor e parar de perder conversas.
        </p>
        <a class="btn btn-primary" href="{wa}" target="_blank" rel="noopener noreferrer">
          Chamar no WhatsApp agora
        </a>
      </div>
    </section>
  </main>

  <footer class="footer">
    <div class="container">
      <strong>ZapsChat Connect</strong>
      <p>CRM para WhatsApp Business, multiatendimento, filas, automação, histórico e relatórios.</p>

      <div class="seo-links" aria-label="Outras soluções">
        {''.join(f'<a href="/solucoes/{_esc(p["slug"])}">{_esc(p["keyword"])}</a>' for p in PAGES if p["slug"] != page["slug"])}
      </div>
    </div>
  </footer>
</body>
</html>
"""


@router.get("/solucoes/{slug}", response_class=HTMLResponse, include_in_schema=False)
def seo_landing_page(slug: str) -> HTMLResponse:
    page = _find_page(slug)
    return HTMLResponse(_render_page(page))


@router.get("/sitemap.xml", include_in_schema=False)
def sitemap_xml() -> Response:
    now = datetime.now(timezone.utc).date().isoformat()

    urls = [
        {
            "loc": f"{BASE_URL}/",
            "priority": "1.0",
            "changefreq": "weekly",
        },
        {
            "loc": f"{BASE_URL}/login.html",
            "priority": "0.2",
            "changefreq": "monthly",
        },
        {
            "loc": f"{BASE_URL}/criar-empresa.html",
            "priority": "0.7",
            "changefreq": "monthly",
        },
    ]

    for page in PAGES:
      urls.append({
          "loc": f"{BASE_URL}/solucoes/{page['slug']}",
          "priority": "0.9",
          "changefreq": "weekly",
      })

    xml_items = []
    for item in urls:
        xml_items.append(
            f"""  <url>
    <loc>{_esc(item["loc"])}</loc>
    <lastmod>{now}</lastmod>
    <changefreq>{item["changefreq"]}</changefreq>
    <priority>{item["priority"]}</priority>
  </url>"""
        )

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{chr(10).join(xml_items)}
</urlset>
"""

    return Response(content=xml, media_type="application/xml")


@router.get("/robots.txt", include_in_schema=False)
def robots_txt() -> PlainTextResponse:
    content = f"""User-agent: *
Allow: /

Sitemap: {BASE_URL}/sitemap.xml
"""
    return PlainTextResponse(content)
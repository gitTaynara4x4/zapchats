# backend/email.py
import os, ssl, smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode

# ── util simples de render {{chave}} ──────────────────────────────
def _render_string(template: str, ctx: dict) -> str:
    out = template
    for k, v in ctx.items():
        out = out.replace("{{" + k + "}}", str(v if v is not None else ""))
    return out

def _load_template(path: Path) -> str | None:
    try:
        if path and path.exists():
            return path.read_text(encoding="utf-8")
    except Exception:
        pass
    return None

# ── carrega SMTP/branding apenas na hora de enviar ───────────────
def _smtp_config():
    host       = os.getenv("SMTP_HOST") or "smtp.gmail.com"
    use_ssl    = (os.getenv("SMTP_USE_SSL", "true").lower() in ("1","true","yes","on"))
    port_env   = os.getenv("SMTP_PORT")
    port       = int(port_env) if port_env else (465 if use_ssl else 587)

    user       = os.getenv("EMAIL_REMETENTE")   # obrigatório para enviar
    password   = os.getenv("EMAIL_SENHA")       # obrigatório para enviar
    from_name  = os.getenv("SMTP_FROM_NAME", "ZapChats")
    from_email = user or "no-reply@localhost"

    app_name   = os.getenv("APP_NAME", "ZapChats")
    support    = os.getenv("SUPPORT_EMAIL", "suporte@seudominio.com")
    logo_url   = os.getenv("EMAIL_LOGO_URL", "")
    address    = os.getenv("COMPANY_ADDRESS", "Brasil")
    expires_in = os.getenv("RESET_TOKEN_EXPIRES", "1 hora")

    return {
        "host": host, "port": port, "use_ssl": use_ssl,
        "user": user, "password": password,
        "from_name": from_name, "from_email": from_email,
        "app_name": app_name, "support": support, "logo_url": logo_url,
        "address": address, "expires_in": expires_in,
    }

# ── templates: HTML em frontend/reset_password_email.html por padrão ──
PROJECT_ROOT = Path(__file__).resolve().parents[1]
TPL_HTML = Path(os.getenv("RESET_EMAIL_HTML", PROJECT_ROOT / "frontend" / "reset_password_email.html"))
TPL_TEXT = Path(os.getenv("RESET_EMAIL_TEXT", PROJECT_ROOT / "backend" / "emails" / "reset_password_email.txt"))

def _default_html(ctx: dict) -> str:
    return f"""
<!doctype html>
<html><body style="font-family:Arial,Helvetica,sans-serif;background:#0b0b0b;padding:24px;color:#e5e7eb">
  <div style="max-width:600px;margin:0 auto;background:#111214;border-radius:12px;padding:24px">
    <h2 style="color:#fff;margin:0 0 8px">Redefinição de senha</h2>
    <p>Olá{ctx.get('firstNameLine','')}!</p>
    <p>Use o token abaixo ou clique no botão:</p>
    <div style="background:#0d1f15;border:1px solid #14532d;color:#a7f3d0;padding:12px 14px;border-radius:10px;font-weight:700;letter-spacing:.3px">{ctx.get('token')}</div>
    <p style="margin:16px 0"><a href="{ctx.get('resetUrl')}" style="display:inline-block;background:#22c55e;color:#052012;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">Redefinir senha</a></p>
    <p style="font-size:13px;color:#a1a6ad">Link: <a href="{ctx.get('resetUrl')}" style="color:#67e8f9">{ctx.get('resetUrl')}</a></p>
    <p style="font-size:12px;color:#8a93a1">Este link expira em {ctx.get('expiresIn')}.</p>
    <p style="font-size:12px;color:#8a93a1">© {ctx.get('year')} {ctx.get('appName')} • {ctx.get('companyAddress')}</p>
  </div>
</body></html>
""".strip()

def _default_text(ctx: dict) -> str:
    return (
f"""{ctx.get('appName')} – Redefinição de senha

Olá{ctx.get('firstNameLine','')}!

Token:
{ctx.get('token')}

Abra o link:
{ctx.get('resetUrl')}

Este link expira em {ctx.get('expiresIn')}.
Se você não solicitou, ignore este e-mail.
Suporte: {ctx.get('supportEmail')}
© {ctx.get('year')} {ctx.get('appName')}
""").strip()

def send_reset_email(
    to_email: str,
    token: str,
    first_name: str | None = None,
    *,
    base_url: str,
    reset_path: str = "/esqueci_senha",
) -> None:
    """
    Monta a URL a partir da origem do request (passada pelo auth).
    - base_url: ex. https://app.cliente.com
    - reset_path: ex. /esqueci_senha   (ou /esqueci_senha.html)
    """
    cfg = _smtp_config()
    if not cfg["user"] or not cfg["password"]:
        # não quebra a app no import; só reclama aqui se for enviar sem credenciais
        raise RuntimeError("Config SMTP ausente: defina EMAIL_REMETENTE e EMAIL_SENHA no ambiente.")

    base = (base_url or "").rstrip("/")
    path = "/" + reset_path.lstrip("/")
    reset_url = f"{base}{path}?{urlencode({'token': token})}"

    first_line = f", {first_name}" if first_name else ""

    ctx = {
        "appName": cfg["app_name"],
        "firstName": first_name,
        "firstNameLine": first_line,  # ← compatível com o HTML salvo no frontend
        "token": token,
        "resetUrl": reset_url,
        "logoUrl": cfg["logo_url"],
        "supportEmail": cfg["support"],
        "expiresIn": cfg["expires_in"],
        "year": datetime.utcnow().year,
        "companyAddress": cfg["address"],
    }

    tpl_html = _load_template(TPL_HTML)
    tpl_txt  = _load_template(TPL_TEXT)
    html_body = _render_string(tpl_html, ctx) if tpl_html else _default_html(ctx)
    text_body = _render_string(tpl_txt,  ctx) if tpl_txt  else _default_text(ctx)

    # corrige o mailto se o template HTML usar {{supportEmail}}
    html_body = html_body.replace('href="mailto{{supportEmail}}"', f'href="mailto:{ctx["supportEmail"]}"')

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"Redefinição de senha – {cfg['app_name']}"
    msg["From"]    = f"{cfg['from_name']} <{cfg['from_email']}>"
    msg["To"]      = to_email
    msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html",  "utf-8"))

    if cfg["use_ssl"] or int(cfg["port"]) == 465:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(cfg["host"], int(cfg["port"]), context=context) as server:
            server.login(cfg["user"], cfg["password"])
            server.sendmail(cfg["from_email"], [to_email], msg.as_string())
    else:
        with smtplib.SMTP(cfg["host"], int(cfg["port"])) as server:
            server.ehlo()
            server.starttls(context=ssl.create_default_context())
            server.login(cfg["user"], cfg["password"])
            server.sendmail(cfg["from_email"], [to_email], msg.as_string())

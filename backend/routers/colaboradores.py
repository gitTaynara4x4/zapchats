# backend/routers/colaboradores.py
from __future__ import annotations

from typing import Optional, List, Any
import os
import re
import json
import secrets
import html
from datetime import datetime, timedelta
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    status,
    Form,
    UploadFile,
    File,
    Body,
    Request,
    Response,
)
from pydantic import BaseModel, EmailStr, ConfigDict, Field
from sqlalchemy import or_, func, and_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload
from starlette.concurrency import run_in_threadpool

from passlib.hash import bcrypt

from backend.database import get_db
from backend import models
from backend.routers.auth import (
    get_current_user,
    gerar_codigo_reset_5d,
    RESET_CODE_TTL_MIN,
    _smtp_send,
    EmailDeliveryError,
)

from backend.utils.entitlements import enforce_quota
from backend.utils.usage import usage_counts
from backend.services.zapschat_presence import (
    get_colaborador_presence,
    list_company_presence,
)

router = APIRouter(prefix="/colaboradores", tags=["Colaboradores"])


FORCE_PASSWORD_CHANGE_MARKER = "FORCE_PASS_CHANGE"

# Conta exclusiva para convites e mensagens de acesso de colaboradores.
# Se as variáveis novas ainda não existirem, usa as antigas como fallback.
EMAIL_CONVITE_REMETENTE = (
    os.getenv("EMAIL_CONVITE_REMETENTE")
    or os.getenv("CONVITE_EMAIL_REMETENTE")
    or os.getenv("EMAIL_REMETENTE")
    or ""
).strip()
EMAIL_CONVITE_SENHA = (
    os.getenv("EMAIL_CONVITE_SENHA")
    or os.getenv("CONVITE_EMAIL_SENHA")
    or os.getenv("EMAIL_SENHA")
    or ""
).strip()
EMAIL_CONVITE_NOME_REMETENTE = (
    os.getenv("EMAIL_CONVITE_NOME_REMETENTE")
    or os.getenv("CONVITE_EMAIL_NOME_REMETENTE")
    or "ZapsChat"
).strip()


def _boolish(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in ("1", "true", "yes", "sim", "on")


def _assert_email_disponivel(
    db: Session,
    email: str,
    *,
    ignorar_colaborador_id: Optional[int] = None,
    ignorar_usuario_id: Optional[int] = None,
) -> str:
    """Valida a unicidade global do e-mail antes de qualquer gravação.

    O banco já possui índices únicos em colaboradores e usuários. Esta validação
    antecipada melhora a mensagem de erro; o IntegrityError continua sendo a
    proteção final contra concorrência.
    """
    email_norm = str(email or "").strip().lower()

    if not email_norm:
        raise HTTPException(status_code=422, detail="E-mail é obrigatório")

    q_colab = db.query(models.Colaborador.id).filter(
        func.lower(models.Colaborador.email) == email_norm
    )
    if ignorar_colaborador_id is not None:
        q_colab = q_colab.filter(models.Colaborador.id != int(ignorar_colaborador_id))

    if q_colab.first():
        raise HTTPException(status_code=409, detail="E-mail já cadastrado")

    q_user = db.query(models.Usuario.id).filter(
        func.lower(models.Usuario.email) == email_norm
    )
    if ignorar_usuario_id is not None:
        q_user = q_user.filter(models.Usuario.id != int(ignorar_usuario_id))

    if q_user.first():
        raise HTTPException(status_code=409, detail="E-mail já cadastrado")

    return email_norm


def _norm_modo_acesso(modo: Optional[str], *, senha: Optional[str] = None) -> str:
    s = str(modo or "").strip().lower()

    if s in ("manual", "senha", "senha_manual", "definir_senha"):
        return "manual"

    if s in ("convite", "email", "e-mail", "email_convite", "enviar_convite"):
        return "convite"

    # Compatibilidade com front antigo: se veio senha, presume senha manual.
    if str(senha or "").strip():
        return "manual"

    return "convite"


def _new_reset_token(db: Session) -> str:
    """Gera um token forte para links de convite de colaboradores.

    A recuperação normal de senha continua usando o código curto de 5 dígitos.
    Convites enviados por URL precisam de um token longo e imprevisível, pois o
    usuário não vai digitá-lo manualmente.
    """
    for _ in range(10):
        token = secrets.token_urlsafe(32)
        exists = db.query(models.Usuario).filter_by(reset_token=token).first()
        if not exists:
            return token

    raise HTTPException(status_code=500, detail="Erro ao gerar convite de acesso. Tente novamente.")


def _reset_token_expira() -> datetime:
    return datetime.utcnow() + timedelta(minutes=RESET_CODE_TTL_MIN)


def _public_base_from_request(request: Optional[Request]) -> str:
    if request is None:
        return ""

    forwarded_proto = str(request.headers.get("x-forwarded-proto") or "").split(",", 1)[0].strip()
    forwarded_host = str(request.headers.get("x-forwarded-host") or "").split(",", 1)[0].strip()
    forwarded_prefix = str(request.headers.get("x-forwarded-prefix") or "").strip().rstrip("/")

    scheme = forwarded_proto or request.url.scheme
    host = forwarded_host or request.headers.get("host") or request.url.netloc

    if not scheme or not host:
        return ""

    return f"{scheme}://{host}{forwarded_prefix}".rstrip("/")


def _public_url(path: str, *, request: Optional[Request] = None) -> str:
    base = (
        os.getenv("APP_PUBLIC_URL")
        or os.getenv("FRONTEND_URL")
        or os.getenv("PUBLIC_URL")
        or os.getenv("ZAPSCHAT_BASE_URL")
        or _public_base_from_request(request)
        or ""
    ).strip().rstrip("/")

    if not base:
        return path

    return f"{base}{path if path.startswith('/') else '/' + path}"


def _enviar_email_acesso_colaborador(
    *,
    email_destino: str,
    token: str,
    nome_colaborador: str,
    nome_empresa: Optional[str] = None,
    modo: str = "convite",
    request: Optional[Request] = None,
) -> None:
    link = _public_url(
        "/esqueci_senha"
        f"?convite=1&email={quote(email_destino, safe='')}"
        f"&token={quote(token, safe='')}",
        request=request,
    )

    nome_colaborador_limpo = str(nome_colaborador or "Colaborador").strip() or "Colaborador"
    nome_empresa_limpo = str(nome_empresa or "ZapsChat").strip() or "ZapsChat"

    if modo == "manual":
        assunto = f"[{nome_empresa_limpo}] Crie sua nova senha"
        titulo = "Crie sua nova senha"
        descricao = (
            f"Seu acesso à empresa {nome_empresa_limpo} foi criado com uma senha temporária. "
            "Defina agora uma senha pessoal para continuar."
        )
        botao = "Criar nova senha"
    elif modo == "redefinicao":
        assunto = f"[{nome_empresa_limpo}] Redefina sua senha"
        titulo = "Redefina sua senha"
        descricao = (
            f"Recebemos uma solicitação para redefinir sua senha de acesso à empresa "
            f"{nome_empresa_limpo}."
        )
        botao = "Redefinir minha senha"
    else:
        assunto = f"[{nome_empresa_limpo}] Convite para acessar o ZapsChat"
        titulo = "Você foi convidado para o ZapsChat"
        descricao = (
            f"Você recebeu um convite de {nome_empresa_limpo} para acessar a plataforma "
            "ZapsChat. Crie sua senha para concluir o cadastro e começar a utilizar o sistema."
        )
        botao = "Criar minha senha"

    corpo = f"""
Olá, {nome_colaborador_limpo}!

{descricao}

Acesse o link abaixo para criar sua senha:
{link}

Este link é pessoal e expira em {RESET_CODE_TTL_MIN} minutos.
Se você não esperava esta mensagem, pode ignorá-la.

Equipe ZapsChat
""".strip()

    nome_html = html.escape(nome_colaborador_limpo)
    empresa_html = html.escape(nome_empresa_limpo)
    titulo_html = html.escape(titulo)
    descricao_html = html.escape(descricao)
    botao_html = html.escape(botao)
    link_html = html.escape(link, quote=True)

    corpo_html = f"""<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{titulo_html}</title>
</head>
<body style="margin:0;padding:0;background:#f4f7f6;font-family:Inter,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#17212b;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    Convite de {empresa_html} para criar sua senha no ZapsChat.
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f7f6;">
    <tr>
      <td align="center" style="padding:32px 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;background:#ffffff;border:1px solid #e2e8e6;border-radius:18px;overflow:hidden;box-shadow:0 8px 28px rgba(15,40,30,.06);">
          <tr>
            <td align="center" style="padding:34px 28px 8px;">
              <div style="font-size:26px;line-height:32px;font-weight:800;letter-spacing:-1px;color:#111827;">
                <span style="color:#19c875;">Zap</span>Chats
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:18px 28px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" width="88" height="88" style="width:88px;height:88px;border-radius:44px;background:#eafbf3;font-size:40px;line-height:88px;">✉️</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 34px 0;">
              <div style="font-size:28px;line-height:36px;font-weight:800;color:#142033;">{titulo_html}</div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:14px 34px 0;">
              <div style="font-size:18px;line-height:26px;font-weight:700;color:#243244;">
                Olá, <span style="color:#0da968;">{nome_html}!</span>
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 44px 0;">
              <div style="font-size:16px;line-height:26px;color:#617184;">{descricao_html}</div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:28px 34px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="#0aaa68" style="border-radius:11px;">
                    <a href="{link_html}" target="_blank" style="display:inline-block;min-width:280px;padding:17px 28px;font-size:17px;line-height:22px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:11px;">🔒&nbsp;&nbsp;{botao_html}</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:22px 34px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#f1fcf7;border:1px solid #c9f0dd;border-radius:11px;">
                <tr>
                  <td align="center" style="padding:13px 16px;font-size:14px;line-height:21px;color:#526173;">
                    ⏱️ Este link é pessoal e expira em <strong style="color:#0b9c61;">{RESET_CODE_TTL_MIN} minutos</strong>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:30px 40px 0;"><div style="height:1px;background:#e8eeec;"></div></td>
          </tr>
          <tr>
            <td style="padding:26px 42px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="52" valign="top" style="font-size:29px;line-height:38px;">🛡️</td>
                  <td valign="top">
                    <div style="font-size:15px;line-height:22px;font-weight:800;color:#213044;">Segurança em primeiro lugar</div>
                    <div style="padding-top:5px;font-size:14px;line-height:22px;color:#687789;">
                      Se você não esperava esta mensagem, pode ignorá-la. Sua conta somente será ativada depois que você definir sua senha.
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:32px 28px 34px;">
              <div style="font-size:14px;line-height:22px;color:#84919f;">Obrigado por confiar no ZapsChat.</div>
              <div style="padding-top:4px;font-size:15px;line-height:22px;font-weight:800;color:#0da968;">Equipe ZapsChat</div>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;">
          <tr>
            <td align="center" style="padding:16px 18px 0;font-size:11px;line-height:17px;color:#93a09d;">
              Se o botão não funcionar, copie e cole este endereço no navegador:<br>
              <a href="{link_html}" style="color:#0b9c61;text-decoration:none;word-break:break-all;">{link_html}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""

    _smtp_send(
        email_destino,
        assunto,
        corpo,
        remetente=EMAIL_CONVITE_REMETENTE,
        senha=EMAIL_CONVITE_SENHA,
        nome_remetente=EMAIL_CONVITE_NOME_REMETENTE,
        corpo_html=corpo_html,
    )


# =========================================================
# Helpers gerais
# =========================================================
def _get_attr(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _user_empresa_id(user: Any) -> int:
    raw = _get_attr(user, "empresa_id")
    try:
        emp = int(raw)
    except Exception:
        emp = 0

    if not emp:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Empresa ausente na sessão",
        )

    return emp


def _assert_mesma_empresa(a: int, b: int) -> None:
    try:
        aa = int(a)
        bb = int(b)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Empresa inválida para este recurso",
        )

    if aa != bb:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Empresa inválida para este recurso",
        )



def _assert_pode_redefinir_senha(db: Session, user: Any) -> None:
    if _usuario_is_admin_real(user):
        return

    usuario_id = _get_attr(user, "id")
    empresa_id = _user_empresa_id(user)

    try:
        usuario_id_int = int(usuario_id)
    except Exception:
        usuario_id_int = 0

    if not usuario_id_int:
        raise HTTPException(status_code=403, detail="Sem permissão para redefinir senha")

    ator = (
        db.query(models.Colaborador)
        .options(joinedload(models.Colaborador.permissoes))
        .filter(
            models.Colaborador.empresa_id == int(empresa_id),
            models.Colaborador.usuario_id == usuario_id_int,
        )
        .first()
    )

    permissoes = {
        str(getattr(perm, "id", "") or "").strip()
        for perm in (getattr(ator, "permissoes", None) or [])
    }

    if not ({"colaboradores.redefinir_senha", "colaboradores.gerenciar"} & permissoes):
        raise HTTPException(status_code=403, detail="Sem permissão para redefinir senha")



def _usuario_is_admin_real(usuario: Any) -> bool:
    try:
        return bool(getattr(usuario, "is_admin", False))
    except Exception:
        return False


def _admin_usuario_vinculado_ou_mesmo_email(db: Session, colab: models.Colaborador):
    """Retorna usuário admin ligado ao colaborador, se existir.

    Usado para impedir que o colaborador operacional do dono/admin seja apagado.
    Colaboradores comuns podem ter usuario_id para login, mas is_admin=False.
    """
    usuario = None

    uid = getattr(colab, "usuario_id", None)
    if uid:
        try:
            usuario = db.query(models.Usuario).get(uid)
        except Exception:
            usuario = None

    if usuario and _usuario_is_admin_real(usuario):
        return usuario

    email = (getattr(colab, "email", None) or "").strip().lower()
    empresa_id = getattr(colab, "empresa_id", None)
    if email and empresa_id:
        try:
            return (
                db.query(models.Usuario)
                .filter(
                    models.Usuario.empresa_id == int(empresa_id),
                    func.lower(models.Usuario.email) == email,
                    models.Usuario.is_admin == True,  # noqa: E712
                )
                .first()
            )
        except Exception:
            return None

    return None

def _ensure_usuario_login_colaborador(
    db: Session,
    colab: models.Colaborador,
    *,
    senha_hash: Optional[str] = None,
) -> models.Usuario:
    """Obtém ou cria o usuário de login vinculado ao colaborador.

    Não reaproveita usuário de outra empresa, administrador ou usuário já
    vinculado a outro colaborador.
    """
    usuario = None

    if getattr(colab, "usuario_id", None):
        usuario = db.query(models.Usuario).get(int(colab.usuario_id))

    email_norm = str(getattr(colab, "email", "") or "").lower().strip()

    if not email_norm:
        raise HTTPException(status_code=422, detail="O colaborador precisa ter um e-mail válido")

    if usuario is None:
        existente = (
            db.query(models.Usuario)
            .filter(func.lower(models.Usuario.email) == email_norm)
            .first()
        )

        if existente is not None:
            if int(getattr(existente, "empresa_id", 0) or 0) != int(colab.empresa_id):
                raise HTTPException(status_code=409, detail="E-mail já cadastrado em outra empresa")

            outro_colaborador = (
                db.query(models.Colaborador)
                .filter(
                    models.Colaborador.id != int(colab.id),
                    models.Colaborador.usuario_id == int(existente.id),
                )
                .first()
            )

            if _usuario_is_admin_real(existente) or outro_colaborador is not None:
                raise HTTPException(status_code=409, detail="E-mail já vinculado a outro usuário")

            usuario = existente
        else:
            usuario = models.Usuario(
                empresa_id=int(colab.empresa_id),
                nome=str(colab.nome or "").strip(),
                email=email_norm,
                senha_hash=senha_hash or bcrypt.hash(secrets.token_urlsafe(32)),
                cargo=colab.cargo or None,
                is_admin=False,
            )
            db.add(usuario)
            db.flush()

        colab.usuario_id = int(usuario.id)

    usuario.nome = str(colab.nome or "").strip()
    usuario.email = email_norm
    usuario.cargo = colab.cargo or None

    if senha_hash:
        usuario.senha_hash = senha_hash

    if getattr(colab, "avatar_data", None):
        usuario.avatar_data = colab.avatar_data
        usuario.avatar_mime = colab.avatar_mime

    db.add(usuario)
    db.add(colab)
    return usuario


def normalize_phone_e164_br(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None

    d = re.sub(r"\D+", "", str(raw))

    if not d:
        return None

    if d.startswith("55"):
        return "+" + d

    if len(d) in (10, 11):
        return "+55" + d

    return "+" + d


HORA_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _norm_hora(h: Optional[str]) -> Optional[str]:
    if h is None:
        return None

    h = str(h).strip()

    if not h:
        return None

    if len(h) >= 5 and h[2] == ":":
        h = h[:5]

    if not HORA_RE.match(h):
        return None

    return h


HORARIO_MODO_VALUES = ("departamento", "personalizado", "livre")


def _norm_horario_modo(v: Optional[str], *, default: Optional[str] = None) -> Optional[str]:
    if v is None:
        return default

    s = str(v).strip().lower()

    if not s:
        return default

    if s in (
        "dept",
        "depto",
        "padrao",
        "padrão",
        "departamento_padrao",
        "departamento-padrao",
    ):
        return "departamento"

    if s in ("custom", "personalizado", "pessoal", "individual"):
        return "personalizado"

    if s in (
        "livre",
        "sem restricao",
        "sem_restricao",
        "semrestricao",
        "none",
        "off",
    ):
        return "livre"

    if s in HORARIO_MODO_VALUES:
        return s

    return default


def build_avatar_url(nome: Optional[str], email: Optional[str]) -> str:
    seed = (nome or email or "Colaborador").strip() or "Colaborador"

    return (
        "https://api.dicebear.com/7.x/initials/svg"
        f"?seed={quote(seed)}&radius=12&scale=100"
    )


def _safe_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _usage_pick(counts: dict, *keys: str, default: int = 0) -> int:
    for key in keys:
        if key in counts:
            return _safe_int(counts.get(key), default)

    return default


def _normalize_int_list(raw: Any) -> list[int]:
    if raw is None:
        return []

    if isinstance(raw, str):
        s = raw.strip()

        if not s:
            return []

        try:
            parsed = json.loads(s)
            raw = parsed
        except Exception:
            raw = [p for p in re.split(r"[\s,;]+", s) if p]

    if not isinstance(raw, list):
        raw = [raw]

    out: list[int] = []
    seen: set[int] = set()

    for item in raw:
        if item is None:
            continue

        if isinstance(item, dict):
            item = (
                item.get("id")
                or item.get("departamento_id")
                or item.get("instancia_id")
                or item.get("value")
            )

        try:
            n = int(item)
        except (TypeError, ValueError):
            continue

        if n <= 0:
            continue

        if n not in seen:
            seen.add(n)
            out.append(n)

    return out


def _parse_perms(value: Optional[str | list]) -> list[str]:
    if not value:
        return []

    if isinstance(value, list):
        return [str(x) for x in value if str(x).strip()]

    s = str(value).strip()

    if not s:
        return []

    try:
        data = json.loads(s)
        if isinstance(data, list):
            return [str(x) for x in data if str(x).strip()]
    except Exception:
        pass

    return [p for p in re.split(r"[\s,;]+", s) if p]


# =========================================================
# Setor / Departamento
# =========================================================
def _find_departamento_by_nome(
    db: Session,
    *,
    empresa_id: int,
    nome: Optional[str],
) -> Optional[models.Departamento]:
    nome = str(nome or "").strip()

    if not nome:
        return None

    return (
        db.query(models.Departamento)
        .filter(
            models.Departamento.empresa_id == int(empresa_id),
            func.lower(func.trim(models.Departamento.nome)) == func.lower(func.trim(nome)),
        )
        .first()
    )


def _resolve_setor_or_departamento(
    db: Session,
    empresa_id: int,
    maybe_id: Optional[int],
) -> Optional[models.Setor]:
    """
    Compatibilidade:
    - O colaborador ainda tem campo setor_id.
    - A tela pode mandar ID de setor antigo OU ID de departamento novo.
    - Se for departamento, criamos/achamos um Setor com mesmo nome para manter compat.
    """
    if not maybe_id:
        return None

    maybe_id = int(maybe_id)

    s = (
        db.query(models.Setor)
        .filter_by(id=maybe_id, empresa_id=int(empresa_id))
        .first()
    )

    if s:
        return s

    dep = (
        db.query(models.Departamento)
        .filter(
            models.Departamento.id == maybe_id,
            models.Departamento.empresa_id == int(empresa_id),
        )
        .first()
    )

    if not dep:
        return None

    s = (
        db.query(models.Setor)
        .filter(
            models.Setor.empresa_id == int(empresa_id),
            func.lower(func.trim(models.Setor.nome)) == func.lower(func.trim(dep.nome)),
        )
        .first()
    )

    if s:
        return s

    s = models.Setor(
        empresa_id=int(empresa_id),
        nome=str(dep.nome).strip(),
    )
    db.add(s)
    db.flush()

    return s


def _find_or_create_departamento_from_setor(
    db: Session,
    *,
    empresa_id: int,
    setor_id: Optional[int],
) -> Optional[models.Departamento]:
    """
    Fallback para dados antigos:
    se o front não mandar departamentos_ids, usa o setor_id para encontrar/criar
    um departamento equivalente.
    """
    if not setor_id:
        return None

    setor = (
        db.query(models.Setor)
        .filter(
            models.Setor.id == int(setor_id),
            models.Setor.empresa_id == int(empresa_id),
        )
        .first()
    )

    if not setor:
        dep_direct = (
            db.query(models.Departamento)
            .filter(
                models.Departamento.id == int(setor_id),
                models.Departamento.empresa_id == int(empresa_id),
            )
            .first()
        )
        return dep_direct

    dep = _find_departamento_by_nome(
        db,
        empresa_id=int(empresa_id),
        nome=setor.nome,
    )

    if dep:
        return dep

    dep = models.Departamento(
        empresa_id=int(empresa_id),
        nome=str(setor.nome).strip(),
        ativo=True,
    )
    db.add(dep)
    db.flush()

    return dep


def _departamentos_from_setor_fallback(
    db: Session,
    *,
    empresa_id: int,
    setor_id: Optional[int],
) -> list[int]:
    dep = _find_or_create_departamento_from_setor(
        db,
        empresa_id=int(empresa_id),
        setor_id=setor_id,
    )

    return [int(dep.id)] if dep else []


# =========================================================
# Validações de instância / departamento
# =========================================================
def _validate_instancias_ids_empresa(
    db: Session,
    *,
    empresa_id: int,
    instancias_ids: list[int],
) -> list[int]:
    ids = _normalize_int_list(instancias_ids)

    if not ids:
        return []

    rows = (
        db.query(models.EmpresaInstancia.id)
        .filter(
            models.EmpresaInstancia.empresa_id == int(empresa_id),
            models.EmpresaInstancia.id.in_(ids),
        )
        .all()
    )

    valid_ids = {int(r[0]) for r in rows if r and r[0] is not None}
    invalid = [x for x in ids if x not in valid_ids]

    if invalid:
        raise HTTPException(
            status_code=404,
            detail=f"Instância(s) inválida(s) para a empresa: {invalid}",
        )

    return [x for x in ids if x in valid_ids]


def _validate_departamentos_ids_empresa(
    db: Session,
    *,
    empresa_id: int,
    departamentos_ids: list[int],
) -> list[int]:
    ids = _normalize_int_list(departamentos_ids)

    if not ids:
        return []

    rows = (
        db.query(models.Departamento.id)
        .filter(
            models.Departamento.empresa_id == int(empresa_id),
            models.Departamento.id.in_(ids),
        )
        .all()
    )

    valid_ids = {int(r[0]) for r in rows if r and r[0] is not None}
    invalid = [x for x in ids if x not in valid_ids]

    if invalid:
        raise HTTPException(
            status_code=404,
            detail=f"Departamento(s) inválido(s) para a empresa: {invalid}",
        )

    return [x for x in ids if x in valid_ids]


def _get_departamentos_ids_colaborador(
    db: Session,
    *,
    empresa_id: int,
    colaborador_id: int,
) -> list[int]:
    rows = (
        db.query(models.DepartamentoMembro.departamento_id)
        .filter(
            models.DepartamentoMembro.empresa_id == int(empresa_id),
            models.DepartamentoMembro.colaborador_id == int(colaborador_id),
        )
        .order_by(
            models.DepartamentoMembro.is_primary.desc(),
            models.DepartamentoMembro.departamento_id.asc(),
        )
        .all()
    )

    return [int(r[0]) for r in rows if r and r[0] is not None]


def _sync_departamentos_membros(
    db: Session,
    *,
    empresa_id: int,
    colaborador_id: int,
    departamentos_ids: list[int] | None,
    primary_departamento_id: int | None = None,
) -> list[int]:
    """
    Modelo 2:
    - Colaborador recebe quais departamentos atende.
    - Isso grava em departamentos_membros.
    - Não depende de departamentos_instancias.
    """
    ids = _validate_departamentos_ids_empresa(
        db,
        empresa_id=int(empresa_id),
        departamentos_ids=_normalize_int_list(departamentos_ids),
    )

    (
        db.query(models.DepartamentoMembro)
        .filter(
            models.DepartamentoMembro.empresa_id == int(empresa_id),
            models.DepartamentoMembro.colaborador_id == int(colaborador_id),
        )
        .delete(synchronize_session=False)
    )

    if not ids:
        return []

    primary_id = None

    if primary_departamento_id is not None:
        try:
            candidate = int(primary_departamento_id)
            if candidate in ids:
                primary_id = candidate
        except Exception:
            primary_id = None

    if primary_id is None:
        primary_id = ids[0]

    for dep_id in ids:
        db.add(
            models.DepartamentoMembro(
                empresa_id=int(empresa_id),
                departamento_id=int(dep_id),
                colaborador_id=int(colaborador_id),
                role="member",
                is_primary=(int(dep_id) == int(primary_id)),
            )
        )

    db.flush()
    return ids


# =========================================================
# Schemas
# =========================================================
class ColaboradorOut(BaseModel):
    id: int
    empresa_id: int
    setor_id: Optional[int]
    usuario_id: Optional[int]
    nome: str
    email: EmailStr
    telefone: Optional[str]
    cargo: Optional[str]

    hora_login_inicio: Optional[str] = None
    hora_login_fim: Optional[str] = None
    horario_modo: Optional[str] = None
    last_access_at: Optional[datetime] = None
    presence_status: str = "offline"
    presence_updated_at: Optional[str] = None
    presence_expires_at: Optional[str] = None
    presence_activity_at: Optional[str] = None
    presence_session_count: int = 0

    instancias_ids: list[int] = Field(default_factory=list)
    departamentos_ids: list[int] = Field(default_factory=list)

    setor_nome: Optional[str] = None
    tem_usuario: bool = False
    convite_pendente: bool = False
    troca_senha_pendente: bool = False
    avatar_url: Optional[str] = None
    is_admin: bool = False

    # Preenchidos na resposta de criação. Nas listagens/leitura ficam nos
    # valores padrão para manter compatibilidade com o restante da tela.
    convite_email_solicitado: bool = False
    convite_email_enviado: Optional[bool] = None
    convite_email_erro: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class ColaboradorUpdate(BaseModel):
    nome: Optional[str] = None
    email: Optional[EmailStr] = None
    setor_id: Optional[int] = None
    telefone: Optional[str] = None
    cargo: Optional[str] = None

    hora_login_inicio: Optional[str] = None
    hora_login_fim: Optional[str] = None
    horario_modo: Optional[str] = None

    senha: Optional[str] = None
    atualizar_usuario: Optional[bool] = False
    forcar_troca_senha: Optional[bool] = False
    permissoes: Optional[List[str]] = None
    instancias_ids: Optional[List[int]] = None
    departamentos_ids: Optional[List[int]] = None


class ColaboradorInstanciasUpdate(BaseModel):
    instancias_ids: List[int] = Field(default_factory=list)


class ColaboradorDepartamentosUpdate(BaseModel):
    departamentos_ids: List[int] = Field(default_factory=list)


# =========================================================
# Serialização
# =========================================================
def _to_out(
    db: Session,
    c: models.Colaborador,
    presence: Optional[dict[str, Any]] = None,
) -> ColaboradorOut:
    setor_nome: Optional[str] = None

    if getattr(c, "setor", None) is not None:
        setor_nome = c.setor.nome
    elif c.setor_id:
        s = (
            db.query(models.Setor)
            .filter_by(id=c.setor_id, empresa_id=c.empresa_id)
            .first()
        )

        if s:
            setor_nome = s.nome
        else:
            dep = (
                db.query(models.Departamento)
                .filter_by(id=c.setor_id, empresa_id=c.empresa_id)
                .first()
            )
            if dep:
                setor_nome = dep.nome

    u = None
    uid = getattr(c, "usuario_id", None)

    # Carrega o usuário vinculado sempre que existir.
    # Além de completar dados faltantes, isso evita usar cargo textual
    # para decidir se alguém é admin. Admin real vem de usuarios.is_admin.
    if uid:
        try:
            u = db.query(models.Usuario).get(uid)
        except Exception:
            u = None

    nome_plano = c.nome or getattr(u, "nome", None)
    email_plano = c.email or getattr(u, "email", None)

    telefone_plano = (
        c.telefone
        or getattr(u, "telefone", None)
        or getattr(u, "whatsapp", None)
        or getattr(u, "celular", None)
        or getattr(u, "phone", None)
    )

    cargo_plano = c.cargo or getattr(u, "cargo", None)

    # A foto pode existir no perfil operacional (Colaborador) ou no usuário de login.
    # A lista precisa usar a mesma fonte que o modal para não cair nas iniciais
    # quando a imagem foi gravada apenas em usuarios.avatar_data.
    if getattr(c, "avatar_data", None):
        avatar_url = f"/api/colaboradores/{int(c.id)}/avatar"
    elif u is not None and getattr(u, "avatar_data", None):
        avatar_url = f"/api/usuarios/{int(u.id)}/avatar"
    else:
        avatar_url = build_avatar_url(nome_plano, email_plano)
    is_admin_flag = _usuario_is_admin_real(u)
    force_change = str(getattr(c, "login_token", "") or "") == FORCE_PASSWORD_CHANGE_MARKER
    reset_pendente = bool(getattr(u, "reset_token", None)) if u else False

    modo_raw = getattr(c, "horario_modo", None)
    horario_modo_out = _norm_horario_modo(modo_raw, default=None)

    if not horario_modo_out:
        if c.hora_login_inicio and c.hora_login_fim:
            horario_modo_out = "personalizado"
        else:
            horario_modo_out = "livre"

    return ColaboradorOut(
        id=int(c.id),
        empresa_id=int(c.empresa_id),
        setor_id=c.setor_id,
        usuario_id=uid,
        nome=nome_plano or "",
        email=email_plano or "no-reply@local.invalid",
        telefone=telefone_plano,
        cargo=cargo_plano,
        instancias_ids=list(c.instancias_ver or []),
        departamentos_ids=_get_departamentos_ids_colaborador(
            db,
            empresa_id=int(c.empresa_id),
            colaborador_id=int(c.id),
        ),
        setor_nome=setor_nome,
        tem_usuario=bool(uid),
        convite_pendente=bool(reset_pendente and not force_change),
        troca_senha_pendente=bool(force_change),
        avatar_url=avatar_url,
        is_admin=is_admin_flag,
        hora_login_inicio=c.hora_login_inicio,
        hora_login_fim=c.hora_login_fim,
        horario_modo=horario_modo_out,
        last_access_at=getattr(c, "last_access_at", None),
        presence_status=str((presence or {}).get("presence_status") or "offline"),
        presence_updated_at=(presence or {}).get("presence_updated_at"),
        presence_expires_at=(presence or {}).get("presence_expires_at"),
        presence_activity_at=(presence or {}).get("presence_activity_at"),
        presence_session_count=int((presence or {}).get("presence_session_count") or 0),
    )




def _listar_departamentos_por_colaborador(
    db: Session,
    *,
    empresa_id: int,
    colaborador_ids: list[int],
) -> dict[int, list[int]]:
    """Busca todos os vínculos de departamentos da lista em uma única consulta."""
    ids = [int(cid) for cid in colaborador_ids if cid is not None]
    if not ids:
        return {}

    rows = (
        db.query(
            models.DepartamentoMembro.colaborador_id,
            models.DepartamentoMembro.departamento_id,
        )
        .filter(
            models.DepartamentoMembro.empresa_id == int(empresa_id),
            models.DepartamentoMembro.colaborador_id.in_(ids),
        )
        .order_by(
            models.DepartamentoMembro.colaborador_id.asc(),
            models.DepartamentoMembro.is_primary.desc(),
            models.DepartamentoMembro.departamento_id.asc(),
        )
        .all()
    )

    out: dict[int, list[int]] = {}
    for colaborador_id, departamento_id in rows:
        if colaborador_id is None or departamento_id is None:
            continue
        out.setdefault(int(colaborador_id), []).append(int(departamento_id))
    return out


def _listar_nomes_departamentos_fallback(
    db: Session,
    *,
    empresa_id: int,
    departamento_ids: list[int],
) -> dict[int, str]:
    """Resolve IDs antigos gravados em setor_id que apontam para departamentos."""
    ids = sorted({int(dep_id) for dep_id in departamento_ids if dep_id is not None})
    if not ids:
        return {}

    rows = (
        db.query(models.Departamento.id, models.Departamento.nome)
        .filter(
            models.Departamento.empresa_id == int(empresa_id),
            models.Departamento.id.in_(ids),
        )
        .all()
    )
    return {
        int(dep_id): str(nome or '').strip()
        for dep_id, nome in rows
        if dep_id is not None and str(nome or '').strip()
    }


def _to_out_list_row(
    row: Any,
    *,
    departamentos_ids: list[int],
    departamento_nome_fallback: Optional[str],
    presence: Optional[dict[str, Any]] = None,
) -> ColaboradorOut:
    """Serializa a listagem sem disparar consultas adicionais por colaborador."""
    values = row._mapping if hasattr(row, '_mapping') else row

    colaborador_id = int(values['id'])
    usuario_id = values['usuario_id']
    nome = values['colaborador_nome'] or values['usuario_nome'] or ''
    email = values['colaborador_email'] or values['usuario_email'] or 'no-reply@local.invalid'
    telefone = values['colaborador_telefone']
    cargo = values['colaborador_cargo'] or values['usuario_cargo']

    setor_nome = values['setor_nome'] or departamento_nome_fallback

    if bool(values['colaborador_tem_avatar']):
        avatar_url = f"/api/colaboradores/{colaborador_id}/avatar"
    elif usuario_id and bool(values['usuario_tem_avatar']):
        avatar_url = f"/api/usuarios/{int(usuario_id)}/avatar"
    else:
        avatar_url = build_avatar_url(nome, email)

    force_change = str(values['login_token'] or '') == FORCE_PASSWORD_CHANGE_MARKER
    reset_pendente = bool(values['usuario_reset_token'])

    horario_modo_out = _norm_horario_modo(values['horario_modo'], default=None)
    if not horario_modo_out:
        if values['hora_login_inicio'] and values['hora_login_fim']:
            horario_modo_out = 'personalizado'
        else:
            horario_modo_out = 'livre'

    presence_value = presence or {}

    return ColaboradorOut(
        id=colaborador_id,
        empresa_id=int(values['empresa_id']),
        setor_id=values['setor_id'],
        usuario_id=usuario_id,
        nome=str(nome or ''),
        email=str(email or 'no-reply@local.invalid'),
        telefone=telefone,
        cargo=cargo,
        instancias_ids=list(values['instancias_ver'] or []),
        departamentos_ids=list(departamentos_ids or []),
        setor_nome=setor_nome,
        tem_usuario=bool(usuario_id),
        convite_pendente=bool(reset_pendente and not force_change),
        troca_senha_pendente=bool(force_change),
        avatar_url=avatar_url,
        is_admin=bool(values['usuario_is_admin']),
        hora_login_inicio=values['hora_login_inicio'],
        hora_login_fim=values['hora_login_fim'],
        horario_modo=horario_modo_out,
        last_access_at=values['last_access_at'],
        presence_status=str(presence_value.get('presence_status') or 'offline'),
        presence_updated_at=presence_value.get('presence_updated_at'),
        presence_expires_at=presence_value.get('presence_expires_at'),
        presence_activity_at=presence_value.get('presence_activity_at'),
        presence_session_count=int(presence_value.get('presence_session_count') or 0),
    )


def _query_lista_colaboradores(
    db: Session,
    *,
    empresa_id: int,
    q: Optional[str] = None,
):
    """Consulta enxuta para a tabela de equipe.

    Não carrega avatar binário, permissões ou relacionamentos joined. Isso evita
    multiplicação de linhas e reduz bastante o tráfego entre PostgreSQL e API.
    """
    C = models.Colaborador
    U = models.Usuario
    S = models.Setor

    base = (
        db.query(
            C.id.label('id'),
            C.empresa_id.label('empresa_id'),
            C.setor_id.label('setor_id'),
            C.usuario_id.label('usuario_id'),
            C.nome.label('colaborador_nome'),
            C.email.label('colaborador_email'),
            C.telefone.label('colaborador_telefone'),
            C.cargo.label('colaborador_cargo'),
            C.instancias_ver.label('instancias_ver'),
            C.hora_login_inicio.label('hora_login_inicio'),
            C.hora_login_fim.label('hora_login_fim'),
            C.horario_modo.label('horario_modo'),
            C.login_token.label('login_token'),
            C.last_access_at.label('last_access_at'),
            C.avatar_data.isnot(None).label('colaborador_tem_avatar'),
            U.nome.label('usuario_nome'),
            U.email.label('usuario_email'),
            U.cargo.label('usuario_cargo'),
            U.is_admin.label('usuario_is_admin'),
            U.reset_token.label('usuario_reset_token'),
            U.avatar_data.isnot(None).label('usuario_tem_avatar'),
            S.nome.label('setor_nome'),
        )
        .outerjoin(U, U.id == C.usuario_id)
        .outerjoin(
            S,
            and_(
                S.id == C.setor_id,
                S.empresa_id == C.empresa_id,
            ),
        )
        .filter(C.empresa_id == int(empresa_id))
    )

    term = str(q or '').strip()
    if term:
        like = f"%{term}%"
        base = base.filter(
            or_(
                C.nome.ilike(like),
                C.email.ilike(like),
                C.telefone.ilike(like),
                C.cargo.ilike(like),
                U.nome.ilike(like),
                U.email.ilike(like),
                U.cargo.ilike(like),
            )
        )

    return base.order_by(func.lower(C.nome)).all()

# =========================================================
# Rotas
# =========================================================
@router.get("", response_model=List[ColaboradorOut])
@router.get("/", response_model=List[ColaboradorOut])
def listar_colaboradores(
    response: Response,
    q: Optional[str] = None,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    empresa_id = _user_empresa_id(user)

    started_at = datetime.now()
    rows = _query_lista_colaboradores(
        db,
        empresa_id=int(empresa_id),
        q=q,
    )
    after_main_query = datetime.now()

    colaborador_ids = [int(row._mapping['id']) for row in rows]
    departamentos_map = _listar_departamentos_por_colaborador(
        db,
        empresa_id=int(empresa_id),
        colaborador_ids=colaborador_ids,
    )

    fallback_ids = [
        int(row._mapping['setor_id'])
        for row in rows
        if row._mapping['setor_id'] is not None and not row._mapping['setor_nome']
    ]
    departamento_nomes = _listar_nomes_departamentos_fallback(
        db,
        empresa_id=int(empresa_id),
        departamento_ids=fallback_ids,
    )
    after_db = datetime.now()

    # Uma única leitura em lote no Redis. A rota nunca faz SCAN nem uma
    # consulta de presença por colaborador.
    presence_map = list_company_presence(
        int(empresa_id),
        colaborador_ids,
        include_offline=True,
    )
    after_presence = datetime.now()

    output = [
        _to_out_list_row(
            row,
            departamentos_ids=departamentos_map.get(int(row._mapping['id']), []),
            departamento_nome_fallback=departamento_nomes.get(
                int(row._mapping['setor_id'])
            ) if row._mapping['setor_id'] is not None else None,
            presence=presence_map.get(int(row._mapping['id'])),
        )
        for row in rows
    ]

    # Ajuda a diagnosticar proxy, banco e Redis pelo DevTools sem poluir a tela.
    db_main_ms = (after_main_query - started_at).total_seconds() * 1000
    db_batch_ms = (after_db - after_main_query).total_seconds() * 1000
    presence_ms = (after_presence - after_db).total_seconds() * 1000
    serialize_ms = (datetime.now() - after_presence).total_seconds() * 1000
    response.headers['Server-Timing'] = (
        f"colab_main;dur={db_main_ms:.1f}, "
        f"colab_batch;dur={db_batch_ms:.1f}, "
        f"presence;dur={presence_ms:.1f}, "
        f"serialize;dur={serialize_ms:.1f}"
    )
    response.headers['X-ZapsChat-Colaboradores-Count'] = str(len(output))

    return output


@router.get("/{colab_id}", response_model=ColaboradorOut)
def obter_colaborador(
    colab_id: int,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    empresa_id = _user_empresa_id(user)

    c = (
        db.query(models.Colaborador)
        .options(joinedload(models.Colaborador.setor))
        .get(colab_id)
    )

    if not c:
        raise HTTPException(status_code=404, detail="Colaborador não encontrado")

    _assert_mesma_empresa(c.empresa_id, empresa_id)

    return _to_out(
        db,
        c,
        get_colaborador_presence(int(empresa_id), int(c.id)),
    )


@router.post("", response_model=ColaboradorOut, status_code=status.HTTP_201_CREATED)
@router.post("/", response_model=ColaboradorOut, status_code=status.HTTP_201_CREATED)
async def criar_colaborador(
    request: Request,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
    nome: Optional[str] = Form(None),
    email: Optional[EmailStr] = Form(None),
    setor_id: Optional[int] = Form(None),
    telefone: Optional[str] = Form(None),
    cargo: Optional[str] = Form(None),
    hora_login_inicio: Optional[str] = Form(None),
    hora_login_fim: Optional[str] = Form(None),
    horario_modo: Optional[str] = Form(None),
    criar_usuario: Optional[bool] = Form(False),
    senha: Optional[str] = Form(None),
    modo_acesso: Optional[str] = Form(None),
    forcar_troca_senha: Optional[bool] = Form(False),
    permissoes: Optional[str] = Form(None),
    avatar: Optional[UploadFile] = File(None),
):
    empresa_id = _user_empresa_id(user)

    raw_permissoes: Any = permissoes
    raw_instancias_ids: Any = None
    raw_departamentos_ids: Any = None

    content_type = request.headers.get("content-type", "")

    if content_type.startswith("application/json"):
        payload = await request.json()

        if isinstance(payload, dict):
            nome = payload.get("nome", nome)
            email = payload.get("email", email)
            setor_id = payload.get("setor_id", setor_id)
            telefone = payload.get("telefone", telefone)
            cargo = payload.get("cargo", cargo)
            criar_usuario = payload.get("criar_usuario", criar_usuario)
            senha = payload.get("senha", senha)
            modo_acesso = payload.get("modo_acesso", payload.get("acesso_modo", modo_acesso))
            forcar_troca_senha = payload.get(
                "forcar_troca_senha",
                payload.get("obrigar_trocar_senha", forcar_troca_senha),
            )
            hora_login_inicio = payload.get("hora_login_inicio", hora_login_inicio)
            hora_login_fim = payload.get("hora_login_fim", hora_login_fim)
            horario_modo = payload.get("horario_modo", horario_modo)

            raw_permissoes = (
                payload.get("permissoes", raw_permissoes)
                if "permissoes" in payload
                else raw_permissoes
            )

            raw_instancias_ids = (
                payload.get("instancias_ids")
                if "instancias_ids" in payload
                else payload.get("instancias_ids[]")
            )

            raw_departamentos_ids = (
                payload.get("departamentos_ids")
                if "departamentos_ids" in payload
                else payload.get("departamentos_ids[]")
            )
    else:
        try:
            form = await request.form()
        except Exception:
            form = None

        if form is not None:
            form_perms = form.getlist("permissoes[]") or form.getlist("permissoes")
            form_insts = form.getlist("instancias_ids[]") or form.getlist("instancias_ids")
            form_deptos = form.getlist("departamentos_ids[]") or form.getlist("departamentos_ids")

            if form_perms:
                raw_permissoes = form_perms

            if form_insts:
                raw_instancias_ids = form_insts

            if form_deptos:
                raw_departamentos_ids = form_deptos

    if not nome or not str(nome).strip():
        raise HTTPException(status_code=422, detail="Nome é obrigatório")

    if not email:
        raise HTTPException(status_code=422, detail="E-mail é obrigatório")

    emp = db.query(models.Empresa).get(empresa_id)

    if emp:
        counts = usage_counts(db, emp.id) or {}
        current_users = _usage_pick(
            counts,
            "users_max",
            "users",
            "usuarios",
            "colaboradores",
            default=0,
        )

        enforce_quota(
            emp,
            "users_max",
            current_users,
            delta=1,
            message="Seu plano está vencido ou atingiu o limite de colaboradores.",
        )

    setor = (
        _resolve_setor_or_departamento(db, empresa_id, setor_id)
        if setor_id
        else None
    )

    if setor_id is not None and not setor:
        raise HTTPException(
            status_code=404,
            detail="Setor não encontrado para sua empresa",
        )

    telefone_norm = normalize_phone_e164_br(telefone)

    email_norm = _assert_email_disponivel(db, str(email))

    avatar_bytes = None
    avatar_mime = None

    if avatar is not None:
        avatar_bytes = await avatar.read()

        if avatar_bytes:
            avatar_mime = avatar.content_type or "application/octet-stream"

    hi_norm = _norm_hora(hora_login_inicio)
    hf_norm = _norm_hora(hora_login_fim)

    horario_modo_norm = _norm_horario_modo(horario_modo, default=None)

    if not horario_modo_norm:
        if hi_norm or hf_norm:
            horario_modo_norm = "personalizado"
        elif setor is not None:
            horario_modo_norm = "departamento"
        else:
            horario_modo_norm = "livre"

    # Valida os acessos antes de criar usuário/colaborador. WhatsApp vazio é
    # válido e significa apenas que o colaborador não verá conversas.
    instancias_ids_norm = _validate_instancias_ids_empresa(
        db,
        empresa_id=int(empresa_id),
        instancias_ids=_normalize_int_list(raw_instancias_ids),
    )

    departamentos_ids_norm = _normalize_int_list(raw_departamentos_ids)

    if not departamentos_ids_norm and setor is not None:
        departamentos_ids_norm = _departamentos_from_setor_fallback(
            db,
            empresa_id=int(empresa_id),
            setor_id=setor.id,
        )

    usuario_id = None
    convite_email_payload: Optional[dict[str, Any]] = None

    senha_limpa = str(senha or "").strip()

    if modo_acesso is None and not _boolish(criar_usuario) and not senha_limpa:
        modo_acesso_norm = "sem_login"
    else:
        modo_acesso_norm = _norm_modo_acesso(modo_acesso, senha=senha)

    deve_criar_usuario = (
        _boolish(criar_usuario)
        or modo_acesso_norm in ("convite", "manual")
        or bool(senha_limpa)
    )
    forcar_troca = _boolish(forcar_troca_senha) or modo_acesso_norm == "manual"

    senha_colab_hash: str

    if deve_criar_usuario:
        if modo_acesso_norm == "manual":
            if not senha_limpa:
                raise HTTPException(
                    status_code=422,
                    detail="Informe uma senha temporária para criar o acesso manual",
                )

            senha_colab_hash = bcrypt.hash(senha_limpa)
        else:
            # Convite por e-mail: não existe senha padrão conhecida por ninguém.
            # A senha real será criada pelo colaborador no fluxo de redefinição.
            senha_colab_hash = bcrypt.hash(secrets.token_urlsafe(32))

        u = models.Usuario(
            empresa_id=int(empresa_id),
            nome=str(nome).strip(),
            email=email_norm,
            senha_hash=senha_colab_hash,
            cargo=cargo or None,
            is_admin=False,
        )

        if modo_acesso_norm == "convite" or forcar_troca:
            token = _new_reset_token(db)
            u.reset_token = token
            u.reset_token_expira = _reset_token_expira()
            convite_email_payload = {
                "email_destino": email_norm,
                "token": token,
                "nome_colaborador": str(nome).strip(),
                "nome_empresa": getattr(emp, "nome", None),
                "modo": modo_acesso_norm,
                "request": request,
            }

        if avatar_bytes:
            u.avatar_data = avatar_bytes
            u.avatar_mime = avatar_mime

        try:
            db.add(u)
            db.flush()
            usuario_id = u.id
        except IntegrityError:
            db.rollback()
            raise HTTPException(
                status_code=409,
                detail="E-mail já cadastrado em usuários",
            )
    else:
        # Colaborador sem login: hash aleatório impossível de saber.
        senha_colab_hash = bcrypt.hash(secrets.token_urlsafe(32))

    colab = models.Colaborador(
        empresa_id=int(empresa_id),
        setor_id=(setor.id if setor else None),
        usuario_id=usuario_id,
        nome=str(nome).strip(),
        email=email_norm,
        senha=senha_colab_hash,
        telefone=telefone_norm,
        cargo=(cargo or None),
        hora_login_inicio=hi_norm,
        hora_login_fim=hf_norm,
        avatar_data=avatar_bytes if avatar_bytes else None,
        avatar_mime=avatar_mime if avatar_bytes else None,
        instancias_ver=instancias_ids_norm,
    )

    if modo_acesso_norm == "manual" and forcar_troca:
        colab.login_token = FORCE_PASSWORD_CHANGE_MARKER
        colab.login_token_expires_at = None

    if hasattr(colab, "horario_modo"):
        setattr(colab, "horario_modo", horario_modo_norm)

    perm_ids = _parse_perms(raw_permissoes)

    if perm_ids:
        perms = (
            db.query(models.Permissao)
            .filter(models.Permissao.id.in_(perm_ids))
            .all()
        )
        colab.permissoes = perms

    try:
        db.add(colab)
        db.flush()

        _sync_departamentos_membros(
            db,
            empresa_id=int(empresa_id),
            colaborador_id=int(colab.id),
            departamentos_ids=departamentos_ids_norm,
            primary_departamento_id=colab.setor_id,
        )
        db.flush()

        # O convite faz parte da criação. Ele é enviado antes do commit para que
        # uma falha de SMTP cancele toda a transação e não deixe colaborador ou
        # usuário gravado sem o e-mail de acesso ter sido entregue.
        if convite_email_payload:
            try:
                # O envio SMTP é bloqueante. Executá-lo diretamente dentro desta
                # rota async trava o event loop do Uvicorn e pode fazer o proxy do
                # EasyPanel considerar todo o serviço indisponível. A thread mantém
                # a API responsiva enquanto a transação permanece sem commit.
                await run_in_threadpool(
                    _enviar_email_acesso_colaborador,
                    **convite_email_payload,
                )
            except EmailDeliveryError as exc:
                print(
                    "[COLAB CONVITE EMAIL] erro ao enviar convite; cadastro cancelado:",
                    exc.code,
                    repr(exc),
                )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=exc.public_message,
                ) from exc
            except Exception as exc:
                print(
                    "[COLAB CONVITE EMAIL] erro inesperado; cadastro cancelado:",
                    repr(exc),
                )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=(
                        "Não foi possível enviar o convite por e-mail. "
                        "O colaborador não foi criado. Tente novamente."
                    ),
                ) from exc

        # Materializa a resposta ainda dentro da transação. Assim, qualquer erro
        # de serialização/consulta provoca rollback. O commit só ocorre depois de
        # todas as etapas obrigatórias terem sido concluídas com sucesso.
        result = _to_out(db, colab)

        if convite_email_payload:
            result = result.model_copy(
                update={
                    "convite_email_solicitado": True,
                    "convite_email_enviado": True,
                    "convite_email_erro": None,
                }
            )

        db.commit()

    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="E-mail já cadastrado")
    except Exception:
        db.rollback()
        raise

    return result


@router.post("/{colab_id}/enviar-acesso-email")
def enviar_acesso_colaborador_por_email(
    colab_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    empresa_id = _user_empresa_id(user)
    _assert_pode_redefinir_senha(db, user)

    colab = db.query(models.Colaborador).get(colab_id)

    if not colab:
        raise HTTPException(status_code=404, detail="Colaborador não encontrado")

    _assert_mesma_empresa(colab.empresa_id, empresa_id)

    tinha_usuario = bool(getattr(colab, "usuario_id", None))
    usuario_anterior = (
        db.query(models.Usuario).get(int(colab.usuario_id))
        if getattr(colab, "usuario_id", None)
        else None
    )
    convite_ja_pendente = bool(
        usuario_anterior
        and getattr(usuario_anterior, "reset_token", None)
        and str(getattr(colab, "login_token", "") or "") != FORCE_PASSWORD_CHANGE_MARKER
    )

    try:
        usuario = _ensure_usuario_login_colaborador(db, colab)
        token = _new_reset_token(db)
        usuario.reset_token = token
        usuario.reset_token_expira = _reset_token_expira()
        db.add(usuario)
        db.add(colab)
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="E-mail já cadastrado em outro usuário")
    except Exception:
        db.rollback()
        raise

    empresa = db.query(models.Empresa).get(int(empresa_id))
    modo_email = "convite" if (not tinha_usuario or convite_ja_pendente) else "redefinicao"

    try:
        _enviar_email_acesso_colaborador(
            email_destino=str(usuario.email).lower().strip(),
            token=token,
            nome_colaborador=str(colab.nome or "").strip(),
            nome_empresa=getattr(empresa, "nome", None),
            modo=modo_email,
            request=request,
        )
    except EmailDeliveryError as exc:
        print("[COLAB ACESSO EMAIL] erro ao enviar:", exc.code, repr(exc))
        raise HTTPException(
            status_code=502,
            detail=exc.public_message,
        ) from exc
    except Exception as exc:
        print("[COLAB ACESSO EMAIL] erro ao enviar:", repr(exc))
        raise HTTPException(
            status_code=502,
            detail="O acesso foi preparado, mas o e-mail não pôde ser enviado",
        )

    return {
        "ok": True,
        "tipo": modo_email,
        "detail": "Convite enviado por e-mail" if modo_email == "convite" else "Link de redefinição enviado por e-mail",
    }


@router.put("/{colab_id}", response_model=ColaboradorOut)
def atualizar_colaborador(
    colab_id: int,
    payload: ColaboradorUpdate = Body(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    empresa_id = _user_empresa_id(user)

    colab = (
        db.query(models.Colaborador)
        .options(joinedload(models.Colaborador.setor))
        .get(colab_id)
    )

    if not colab:
        raise HTTPException(status_code=404, detail="Colaborador não encontrado")

    _assert_mesma_empresa(colab.empresa_id, empresa_id)

    data = payload.model_dump(exclude_unset=True)

    if "email" in data and data["email"] is not None:
        data["email"] = _assert_email_disponivel(
            db,
            str(data["email"]),
            ignorar_colaborador_id=int(colab.id),
            ignorar_usuario_id=(int(colab.usuario_id) if colab.usuario_id else None),
        )

    if "senha" in data and data.get("senha"):
        _assert_pode_redefinir_senha(db, user)

    if "nome" in data and data["nome"] is not None:
        colab.nome = data["nome"].strip()

    if "email" in data and data["email"] is not None:
        colab.email = str(data["email"]).lower().strip()

    if "telefone" in data:
        colab.telefone = normalize_phone_e164_br(data["telefone"])

    if "cargo" in data:
        colab.cargo = data["cargo"] or None

    if "setor_id" in data:
        setor_id = data["setor_id"]

        if setor_id is not None:
            setor = _resolve_setor_or_departamento(db, empresa_id, setor_id)

            if not setor:
                raise HTTPException(
                    status_code=404,
                    detail="Setor não encontrado para sua empresa",
                )

            colab.setor_id = setor.id
        else:
            colab.setor_id = None

    if "hora_login_inicio" in data:
        colab.hora_login_inicio = _norm_hora(data["hora_login_inicio"])

    if "hora_login_fim" in data:
        colab.hora_login_fim = _norm_hora(data["hora_login_fim"])

    if "horario_modo" in data and hasattr(colab, "horario_modo"):
        colab.horario_modo = (
            _norm_horario_modo(data.get("horario_modo"), default=None)
            or "livre"
        )

    atualizar_usuario_flag = bool(
        data.get("atualizar_usuario") or payload.atualizar_usuario
    )

    if "senha" in data and data["senha"]:
        nova_senha = str(data["senha"]).strip()

        if len(nova_senha) < 6 or len(nova_senha) > 72:
            raise HTTPException(
                status_code=422,
                detail="A senha temporária deve ter entre 6 e 72 caracteres",
            )

        nova_senha_hash = bcrypt.hash(nova_senha)
        colab.senha = nova_senha_hash

        if atualizar_usuario_flag:
            u = _ensure_usuario_login_colaborador(
                db,
                colab,
                senha_hash=nova_senha_hash,
            )
            u.reset_token = None
            u.reset_token_expira = None
            db.add(u)

        if _boolish(data.get("forcar_troca_senha")):
            colab.login_token = FORCE_PASSWORD_CHANGE_MARKER
            colab.login_token_expires_at = None

    if atualizar_usuario_flag and colab.usuario_id:
        u = db.query(models.Usuario).get(colab.usuario_id)

        if u:
            if "nome" in data and data["nome"] is not None:
                u.nome = data["nome"].strip()

            if "email" in data and data["email"] is not None:
                u.email = str(data["email"]).lower().strip()

            if "cargo" in data:
                u.cargo = data["cargo"] or None

            db.add(u)

    if "permissoes" in data:
        perm_ids = [str(x) for x in (data["permissoes"] or [])]

        if perm_ids:
            perms = (
                db.query(models.Permissao)
                .filter(models.Permissao.id.in_(perm_ids))
                .all()
            )
        else:
            perms = []

        colab.permissoes = perms

    if "instancias_ids" in data:
        colab.instancias_ver = _validate_instancias_ids_empresa(
            db,
            empresa_id=int(empresa_id),
            instancias_ids=_normalize_int_list(data["instancias_ids"]),
        )

    should_sync_departamentos = "departamentos_ids" in data
    departamentos_ids_for_sync = None

    if should_sync_departamentos:
        departamentos_ids_for_sync = _normalize_int_list(data.get("departamentos_ids"))

    try:
        db.add(colab)
        db.flush()

        if should_sync_departamentos:
            _sync_departamentos_membros(
                db,
                empresa_id=int(empresa_id),
                colaborador_id=int(colab.id),
                departamentos_ids=departamentos_ids_for_sync,
                primary_departamento_id=colab.setor_id,
            )

        db.flush()
        result = _to_out(db, colab)
        db.commit()

    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="E-mail já cadastrado")
    except Exception:
        db.rollback()
        raise

    return result


@router.put("/{colab_id}/instancias", response_model=ColaboradorOut)
def atualizar_instancias_colaborador(
    colab_id: int,
    payload: ColaboradorInstanciasUpdate = Body(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    empresa_id = _user_empresa_id(user)

    colab = (
        db.query(models.Colaborador)
        .options(joinedload(models.Colaborador.setor))
        .get(colab_id)
    )

    if not colab:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Colaborador não encontrado")

    _assert_mesma_empresa(colab.empresa_id, empresa_id)

    colab.instancias_ver = _validate_instancias_ids_empresa(
        db,
        empresa_id=int(empresa_id),
        instancias_ids=_normalize_int_list(payload.instancias_ids),
    )

    try:
        db.add(colab)
        db.commit()
    except Exception:
        db.rollback()
        raise

    c = (
        db.query(models.Colaborador)
        .options(joinedload(models.Colaborador.setor))
        .get(colab.id)
    )

    return _to_out(db, c)


@router.put("/{colab_id}/departamentos", response_model=ColaboradorOut)
def atualizar_departamentos_colaborador(
    colab_id: int,
    payload: ColaboradorDepartamentosUpdate = Body(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    empresa_id = _user_empresa_id(user)

    colab = (
        db.query(models.Colaborador)
        .options(joinedload(models.Colaborador.setor))
        .get(colab_id)
    )

    if not colab:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Colaborador não encontrado")

    _assert_mesma_empresa(colab.empresa_id, empresa_id)

    try:
        _sync_departamentos_membros(
            db,
            empresa_id=int(empresa_id),
            colaborador_id=int(colab.id),
            departamentos_ids=_normalize_int_list(payload.departamentos_ids),
            primary_departamento_id=colab.setor_id,
        )

        db.commit()

    except Exception:
        db.rollback()
        raise

    c = (
        db.query(models.Colaborador)
        .options(joinedload(models.Colaborador.setor))
        .get(colab.id)
    )

    return _to_out(db, c)


@router.delete("/{colab_id}", status_code=status.HTTP_204_NO_CONTENT)
def excluir_colaborador(
    colab_id: int,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    empresa_id = _user_empresa_id(user)

    colab = db.query(models.Colaborador).get(colab_id)

    if not colab:
        return

    _assert_mesma_empresa(colab.empresa_id, empresa_id)

    admin_usuario = _admin_usuario_vinculado_ou_mesmo_email(db, colab)
    if admin_usuario:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Este colaborador é o acesso administrativo da empresa. "
                "Ele não pode ser removido pela tela de colaboradores."
            ),
        )

    usuario_vinculado = None
    if getattr(colab, "usuario_id", None):
        try:
            usuario_vinculado = db.query(models.Usuario).get(colab.usuario_id)
        except Exception:
            usuario_vinculado = None

    try:
        colab_id_int = int(colab.id)
        empresa_id_int = int(colab.empresa_id)

        # Antes de apagar o colaborador, solta/deleta vínculos conhecidos.
        # Isso evita erro 500 por FK em instalações onde o banco não aplicou
        # ON DELETE SET NULL / CASCADE nas tabelas antigas.
        if hasattr(models, "Cliente"):
            (
                db.query(models.Cliente)
                .filter(
                    models.Cliente.empresa_id == empresa_id_int,
                    models.Cliente.colaborador_id == colab_id_int,
                )
                .update({models.Cliente.colaborador_id: None}, synchronize_session=False)
            )

        if hasattr(models, "Mensagem"):
            (
                db.query(models.Mensagem)
                .filter(
                    models.Mensagem.empresa_id == empresa_id_int,
                    models.Mensagem.colaborador_id == colab_id_int,
                )
                .update({models.Mensagem.colaborador_id: None}, synchronize_session=False)
            )

        if hasattr(models, "Atendimento"):
            (
                db.query(models.Atendimento)
                .filter(
                    models.Atendimento.empresa_id == empresa_id_int,
                    models.Atendimento.operador_id == colab_id_int,
                )
                .update({models.Atendimento.operador_id: None}, synchronize_session=False)
            )

        if hasattr(models, "AtendimentoParticipante"):
            (
                db.query(models.AtendimentoParticipante)
                .filter(
                    models.AtendimentoParticipante.empresa_id == empresa_id_int,
                    models.AtendimentoParticipante.colaborador_id == colab_id_int,
                )
                .delete(synchronize_session=False)
            )

        if hasattr(models, "DepartamentoMembro"):
            (
                db.query(models.DepartamentoMembro)
                .filter(
                    models.DepartamentoMembro.empresa_id == empresa_id_int,
                    models.DepartamentoMembro.colaborador_id == colab_id_int,
                )
                .delete(synchronize_session=False)
            )

        # Permissões: NÃO apagar manualmente a tabela colaboradores_permissoes aqui.
        # A relação Colaborador.permissoes é carregada pelo SQLAlchemy (lazy="joined").
        # Se apagarmos via query.delete() e depois dermos db.delete(colab), o ORM tenta
        # apagar a mesma relação de novo e gera StaleDataError.
        try:
            colab.permissoes = []
            db.flush()
        except Exception:
            db.rollback()
            colab = db.query(models.Colaborador).get(colab_id_int)
            if not colab:
                return
            _assert_mesma_empresa(colab.empresa_id, empresa_id)
            colab.permissoes = []
            db.flush()

        if hasattr(models, "Disparo"):
            (
                db.query(models.Disparo)
                .filter(
                    models.Disparo.empresa_id == empresa_id_int,
                    models.Disparo.colaborador_id == colab_id_int,
                )
                .update({models.Disparo.colaborador_id: None}, synchronize_session=False)
            )

        if hasattr(models, "ChatEvento"):
            (
                db.query(models.ChatEvento)
                .filter(
                    models.ChatEvento.empresa_id == empresa_id_int,
                    models.ChatEvento.autor_id == colab_id_int,
                )
                .update({models.ChatEvento.autor_id: None}, synchronize_session=False)
            )

        if hasattr(models, "ChatReadState"):
            (
                db.query(models.ChatReadState)
                .filter(
                    models.ChatReadState.empresa_id == empresa_id_int,
                    models.ChatReadState.user_id == colab_id_int,
                )
                .delete(synchronize_session=False)
            )

        if hasattr(models, "EmailAccount"):
            (
                db.query(models.EmailAccount)
                .filter(
                    models.EmailAccount.empresa_id == empresa_id_int,
                    models.EmailAccount.colaborador_id == colab_id_int,
                )
                .update({models.EmailAccount.colaborador_id: None}, synchronize_session=False)
            )

        # Se o colaborador tinha usuário de login comum, NÃO damos db.delete(usuario),
        # porque esse usuário pode ter FK em histórico/conversas. Em vez disso,
        # desativamos o acesso e liberamos o e-mail original para cadastro futuro.
        if usuario_vinculado and not _usuario_is_admin_real(usuario_vinculado):
            usuario_vinculado.email = (
                f"deleted-colaborador-{colab_id_int}-usuario-{int(usuario_vinculado.id)}@deleted.local.invalid"
            )
            usuario_vinculado.senha_hash = bcrypt.hash(
                f"deleted:{colab_id_int}:{int(usuario_vinculado.id)}"
            )
            usuario_vinculado.is_admin = False
            usuario_vinculado.cargo = None
            usuario_vinculado.departamento_id = None

        colab.usuario_id = None
        db.flush()

        db.delete(colab)
        db.commit()

    except Exception as exc:
        db.rollback()
        print(f"[colaboradores] erro ao excluir colaborador {colab_id}: {exc!r}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Não foi possível remover este colaborador. Verifique vínculos antigos no banco.",
        )

    return


@router.put(
    "/{colab_id}/avatar",
    summary="Atualiza avatar do colaborador",
    responses={200: {"description": "Avatar atualizado"}},
)
async def put_colaborador_avatar(
    colab_id: int,
    avatar: UploadFile = File(...),
    db: Session = Depends(get_db),
    me=Depends(get_current_user),
):
    empresa_id = _user_empresa_id(me)

    c = db.query(models.Colaborador).get(colab_id)

    if not c:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Colaborador não encontrado")

    _assert_mesma_empresa(c.empresa_id, empresa_id)

    data = await avatar.read()

    if not data:
        raise HTTPException(status_code=400, detail="Arquivo de avatar vazio")

    c.avatar_data = data
    c.avatar_mime = avatar.content_type or "application/octet-stream"

    if c.usuario_id:
        u = db.query(models.Usuario).get(c.usuario_id)

        if u:
            u.avatar_data = data
            u.avatar_mime = c.avatar_mime

    db.add(c)
    db.commit()

    return {"ok": True}


@router.get(
    "/{colab_id}/avatar",
    summary="Obtém avatar do colaborador",
)
def get_colaborador_avatar(
    colab_id: int,
    db: Session = Depends(get_db),
    me=Depends(get_current_user),
):
    empresa_id = _user_empresa_id(me)

    c = db.query(models.Colaborador).get(colab_id)

    if not c:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Colaborador não encontrado")

    _assert_mesma_empresa(c.empresa_id, empresa_id)

    avatar_data = getattr(c, "avatar_data", None)
    avatar_mime = getattr(c, "avatar_mime", None)

    # Compatibilidade com cadastros antigos: algumas fotos foram salvas apenas
    # no usuário vinculado. O endpoint do colaborador passa a enxergar as duas
    # fontes, mantendo modal e lista sempre iguais.
    if not avatar_data and c.usuario_id:
        u = db.query(models.Usuario).get(c.usuario_id)
        if u:
            avatar_data = getattr(u, "avatar_data", None)
            avatar_mime = getattr(u, "avatar_mime", None)

    if not avatar_data:
        raise HTTPException(status_code=404, detail="Colaborador sem avatar")

    return Response(
        content=bytes(avatar_data),
        media_type=avatar_mime or "application/octet-stream",
        headers={
            "Cache-Control": "private, no-store, max-age=0",
            "Pragma": "no-cache",
        },
    )
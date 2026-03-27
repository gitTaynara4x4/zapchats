from __future__ import annotations

import os
import asyncio
from datetime import datetime, timezone
from typing import List, Optional, Tuple, Dict, Set

import httpx
from fastapi import APIRouter, Depends, HTTPException, Body, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import text

from backend.database import get_db, SessionLocal
from backend.routers.auth import get_current_identity
from backend import models

# ===== Plano/Entitlements =====
from backend.utils.entitlements import (
    enforce_quota,
    has_feature,
    enforce_billing_active,
)

# ===== Privacidade por instâncias (colaborador) =====
from backend.security.instancias import instancias_visiveis

router = APIRouter(prefix="/api/disparos", tags=["Disparos"])

# =====================================================
# Config Evolution API (env)
# =====================================================

EVOLUTION_URL = (os.getenv("EVOLUTION_URL") or "").rstrip("/")
EVOLUTION_APIKEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_API_KEY")

# n8n – fluxo de IA para melhorar mensagem de disparo
N8N_IA_MELHORAR_DISPARO_URL = (os.getenv("N8N_IA_MELHORAR_DISPARO_URL") or "").strip()

print("[IA-DISPARO] URL n8n =", N8N_IA_MELHORAR_DISPARO_URL)


# =====================================================
# Helpers de permissão / identidade
# =====================================================

def _to_int(v) -> Optional[int]:
    try:
        if v is None:
            return None
        s = str(v).strip()
        if not s:
            return None
        return int(s)
    except Exception:
        return None


def _infer_kind(identity: dict) -> str:
    """
    Tenta inferir se é "colaborador" ou "usuario" mesmo quando `kind` não vem no token.
    """
    k = (identity.get("kind") or identity.get("tipo") or "").lower().strip()
    if k in ("colaborador", "usuario", "admin"):
        return "colaborador" if k == "colaborador" else "usuario"

    sub = str(identity.get("sub") or "").strip().lower()
    role = str(identity.get("role") or "").strip().lower()

    if sub.startswith("colab-") or "colab" in role or "colaborador" in role:
        return "colaborador"

    for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
        if _to_int(identity.get(key)):
            return "colaborador"

    return "usuario"


def _get_empresa_e_colab(identity: dict | None) -> Tuple[int, Optional[int]]:
    if identity is None:
        raise HTTPException(status_code=401, detail="Não autenticado")

    empresa_id = _to_int(identity.get("empresa_id"))
    if not empresa_id:
        raise HTTPException(status_code=400, detail="Empresa não encontrada no token")

    kind = _infer_kind(identity)
    colab_id: Optional[int] = None

    if kind == "colaborador":
        for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
            colab_id = _to_int(identity.get(key))
            if colab_id:
                break

        if not colab_id:
            sub = str(identity.get("sub") or "").strip().lower()
            if sub.startswith("colab-"):
                colab_id = _to_int(sub.split("-", 1)[1])

        if not colab_id:
            colab_id = _to_int(identity.get("id"))

    return empresa_id, colab_id


def _get_ids(identity: dict | None) -> Tuple[int, Optional[int], Optional[int]]:
    """
    Retorna (empresa_id, colaborador_id, usuario_id).
    """
    if identity is None:
        raise HTTPException(status_code=401, detail="Não autenticado")

    empresa_id, colab_id = _get_empresa_e_colab(identity)
    kind = _infer_kind(identity)

    usuario_id: Optional[int] = None
    if kind != "colaborador":
        for key in ("usuario_id", "user_id", "id_usuario", "id_user", "uid"):
            usuario_id = _to_int(identity.get(key))
            if usuario_id:
                break

        if not usuario_id:
            usuario_id = _to_int(identity.get("id"))

        if not usuario_id:
            sub = str(identity.get("sub") or "").strip().lower()
            if sub.isdigit():
                usuario_id = int(sub)
            elif sub.startswith("user-"):
                usuario_id = _to_int(sub.split("-", 1)[1])

    return empresa_id, colab_id, usuario_id


def _ensure_perm(identity: dict, db: Session, perm_id: str) -> None:
    """
    Verifica se o colaborador logado possui a permissão `perm_id`.
    Se o usuário logado NÃO for colaborador (ex.: usuário/admin do painel),
    libera.
    """
    empresa_id = _to_int(identity.get("empresa_id"))
    if not empresa_id:
        raise HTTPException(status_code=400, detail="Empresa não encontrada no token")

    kind = _infer_kind(identity)
    if kind != "colaborador":
        return

    _, colab_id = _get_empresa_e_colab(identity)
    if not colab_id:
        raise HTTPException(status_code=403, detail="Sem colaborador vinculado.")

    row = db.execute(
        text(
            """
            SELECT 1
            FROM colaboradores_permissoes
            WHERE colaborador_id = :cid
              AND permissao_id   = :pid
            LIMIT 1
            """
        ),
        {"cid": colab_id, "pid": perm_id},
    ).first()

    if not row:
        raise HTTPException(status_code=403, detail=f"Você não tem permissão: {perm_id}")


def _resolve_colab_by_usuario(db: Session, empresa_id: int, usuario_id: Optional[int]) -> Optional[int]:
    """
    Se o admin/usuário tiver um Colaborador vinculado, preenche colaborador_id também.
    """
    if not usuario_id:
        return None

    try:
        cid = (
            db.query(models.Colaborador.id)
            .filter(
                models.Colaborador.empresa_id == empresa_id,
                models.Colaborador.usuario_id == usuario_id,
            )
            .scalar()
        )
        return int(cid) if cid else None
    except Exception:
        return None


def _get_nome_autor(db: Session, colab_id: Optional[int], usuario_id: Optional[int]) -> Tuple[Optional[str], Optional[str]]:
    if colab_id:
        nome = (
            db.query(models.Colaborador.nome)
            .filter(models.Colaborador.id == colab_id)
            .scalar()
        )
        return (str(nome) if nome else None, "colaborador")

    if usuario_id:
        nome = (
            db.query(models.Usuario.nome)
            .filter(models.Usuario.id == usuario_id)
            .scalar()
        )
        return (str(nome) if nome else None, "usuario")

    return (None, None)


def _assert_instancia_acl(identity: dict, db: Session, instancia_id: Optional[int]) -> None:
    """
    Se colaborador tiver restrição de instâncias, garante ACL.
    """
    vis = instancias_visiveis(identity, db)
    if vis is None:
        return
    if instancia_id is None:
        return
    try:
        iid = int(instancia_id)
    except Exception:
        raise HTTPException(status_code=400, detail="instancia_id inválido")
    if iid not in vis:
        raise HTTPException(status_code=403, detail="Sem acesso a esta instância")


def _apply_instancias_filter(identity: dict, db: Session, query):
    vis = instancias_visiveis(identity, db)
    if vis is None:
        return query
    if not vis:
        return query.filter(models.Disparo.id == -1)
    return query.filter(models.Disparo.instancia_id.in_(vis))


def _get_empresa_or_404(db: Session, empresa_id: int) -> models.Empresa:
    empresa = db.query(models.Empresa).filter(models.Empresa.id == empresa_id).first()
    if not empresa:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")
    return empresa


def _current_month_broadcasts_count(db: Session, empresa_id: int) -> int:
    """
    Conta quantos disparos foram criados no mês atual (UTC).
    """
    now = datetime.now(timezone.utc)
    month_start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)

    return (
        db.query(models.Disparo)
        .filter(
            models.Disparo.empresa_id == empresa_id,
            models.Disparo.criado_em >= month_start,
        )
        .count()
    )


# =====================================================
# Schemas
# =====================================================

class DisparoCreate(BaseModel):
    instancia_id: int = Field(..., description="ID da instância (empresas_instancias.id)")
    delay_segundos: int = Field(
        20,
        ge=5,
        le=3600,
        description="Intervalo entre envios em segundos (mín. 5s)",
    )
    tipo_conteudo: str = Field(
        "text",
        description="text | image | audio (no momento só text está implementado)",
    )
    mensagem: Optional[str] = Field(
        None,
        description="Texto da mensagem (pode ser vazio se for só mídia)",
    )
    midia_id: Optional[int] = Field(
        None,
        description="ID da mídia (tabela midias) se for imagem/áudio",
    )
    numeros: List[str] = Field(
        default_factory=list,
        description="Lista de números, um por destinatário",
    )


class DisparoOut(BaseModel):
    id: int
    mensagem: Optional[str]
    qtd_numeros: int
    instancia_id: Optional[int]
    instancia_nome: Optional[str]
    status: str
    criado_em: datetime
    delay_segundos: int

    colaborador_id: Optional[int] = None
    usuario_id: Optional[int] = None
    criado_por: Optional[str] = None
    criado_por_tipo: Optional[str] = None  # "colaborador" | "usuario"

    class Config:
        from_attributes = True


class IAMelhorarDisparoResp(BaseModel):
    original: str
    melhorada: str


# =====================================================
# Utilitários de normalização
# =====================================================

def _normalizar_numeros(raw_numeros: List[str]) -> list[tuple[str, str]]:
    """
    Recebe lista de strings digitadas pelo usuário e retorna
    [(numero_raw, numero_normalizado)] já sem duplicados.
    """
    vistos: set[str] = set()
    out: list[tuple[str, str]] = []

    for raw in raw_numeros:
        if not raw:
            continue
        s = raw.strip()
        if not s:
            continue
        digits = "".join(ch for ch in s if ch.isdigit())
        if not digits:
            continue
        if digits in vistos:
            continue
        vistos.add(digits)
        out.append((s, digits))

    return out


# =====================================================
# Evolution – envio de texto
# =====================================================

async def _evolution_send_text(
    *,
    empresa_id: int,
    instancia_db: models.EmpresaInstancia,
    numero: str,
    texto: str,
) -> None:
    """
    Envia um texto simples via Evolution.
    """
    if not EVOLUTION_URL:
        raise RuntimeError("EVOLUTION_URL não configurada (EVOLUTION_URL).")
    if not EVOLUTION_APIKEY:
        raise RuntimeError("EVOLUTION_APIKEY/EVOLUTION_API_KEY não configurada.")

    inst_name = (
        getattr(instancia_db, "instance_name", None)
        or getattr(instancia_db, "instance", None)
        or getattr(instancia_db, "apelido", None)
        or str(instancia_db.id)
    )

    numero_e164 = "".join(ch for ch in numero if ch.isdigit())
    if not numero_e164.startswith("55"):
        numero_e164 = "55" + numero_e164

    url = f"{EVOLUTION_URL}/message/sendText/{inst_name}"
    payload = {"number": numero_e164, "text": texto}
    headers = {"Content-Type": "application/json", "apikey": EVOLUTION_APIKEY}

    print(
        "[DISPARO] Enviando via Evolution:",
        f"emp={empresa_id}",
        f"inst_id={instancia_db.id}",
        f"inst={inst_name}",
        f"num={numero_e164}",
        f"msg={texto[:60]!r}",
    )

    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(url, headers=headers, json=payload)

    try:
        data = resp.json()
    except Exception:
        data = resp.text

    if resp.status_code >= 400:
        raise RuntimeError(f"Evolution sendText HTTP {resp.status_code}: {data}")


# =====================================================
# IA – chamada ao n8n
# =====================================================

async def _ia_melhorar_via_n8n(texto: str):
    """
    Chama o webhook do n8n para melhorar a mensagem de disparo.
    """
    if not N8N_IA_MELHORAR_DISPARO_URL:
        print("[IA-DISPARO] ERRO: N8N_IA_MELHORAR_DISPARO_URL não configurada.")
        raise HTTPException(
            status_code=500,
            detail="Motor de IA não configurado. Contate o administrador.",
        )

    payload = {"draft": texto}
    print("[IA-DISPARO] Chamando n8n em", N8N_IA_MELHORAR_DISPARO_URL)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                N8N_IA_MELHORAR_DISPARO_URL,
                headers={"Content-Type": "application/json"},
                json=payload,
            )
    except httpx.RequestError as e:
        print("[IA-DISPARO] Erro ao chamar n8n:", repr(e))
        raise HTTPException(status_code=502, detail="Erro ao chamar motor de IA (n8n).")

    raw_text = resp.text
    try:
        data = resp.json()
    except Exception:
        data = raw_text

    if resp.status_code >= 400:
        print("[IA-DISPARO] n8n retornou HTTP", resp.status_code, "body:", data)
        raise HTTPException(status_code=502, detail=f"n8n retornou erro HTTP {resp.status_code}.")

    print("[IA-DISPARO] Resposta n8n OK:", data)
    return data


# =====================================================
# Worker de processamento de disparo
# =====================================================

async def _enviar_destinatario(
    db: Session,
    disparo: models.Disparo,
    dest: models.DisparoDestinatario,
) -> None:
    """
    Envia UM destinatário de um disparo.
    """
    instancia = disparo.instancia
    if instancia is None:
        instancia = (
            db.query(models.EmpresaInstancia)
            .filter(models.EmpresaInstancia.id == disparo.instancia_id)
            .first()
        )
        if instancia is None:
            raise RuntimeError("Instância não encontrada para esse disparo.")

    tipo = (disparo.tipo_conteudo or "text").lower()
    if tipo != "text":
        raise RuntimeError(f"Tipo de conteúdo ainda não suportado em disparo: {tipo!r}")

    texto = (disparo.mensagem or "").strip()
    if not texto:
        raise RuntimeError("Mensagem vazia para disparo de texto.")

    await _evolution_send_text(
        empresa_id=disparo.empresa_id,
        instancia_db=instancia,
        numero=dest.numero_normalizado,
        texto=texto,
    )


async def _processar_disparo(disparo_id: int) -> None:
    """
    Processa um disparo: envia 1 por 1 respeitando o delay.
    """
    if SessionLocal is None:
        print("[DISPARO] SessionLocal indisponível; worker abortado.")
        return

    db: Session = SessionLocal()
    try:
        disparo = db.query(models.Disparo).filter(models.Disparo.id == disparo_id).first()
        if not disparo:
            print(f"[DISPARO] {disparo_id} não encontrado ao processar")
            return

        if disparo.status in ("cancelado", "concluido"):
            print(f"[DISPARO] {disparo_id} já está {disparo.status}, não processa.")
            return

        disparo.status = "processando"
        disparo.iniciado_em = datetime.now(timezone.utc)
        db.commit()
        db.refresh(disparo)

        delay = max(5, int(disparo.delay_segundos or 0))
        print(f"[DISPARO] Iniciando processamento do disparo #{disparo.id} (delay={delay}s)")

        while True:
            db.refresh(disparo)

            if disparo.status == "cancelado":
                print(f"[DISPARO] {disparo.id} cancelado durante o processamento.")
                break

            empresa = db.query(models.Empresa).filter(models.Empresa.id == disparo.empresa_id).first()
            if not empresa:
                disparo.status = "erro"
                disparo.finalizado_em = datetime.now(timezone.utc)
                db.commit()
                print(f"[DISPARO] {disparo.id} sem empresa vinculada.")
                break

            # se venceu no meio do processo, para os próximos envios
            try:
                enforce_billing_active(
                    empresa,
                    message="Plano vencido durante o processamento do disparo.",
                )
            except HTTPException:
                disparo.status = "cancelado"
                disparo.finalizado_em = datetime.now(timezone.utc)
                db.commit()
                print(f"[DISPARO] {disparo.id} interrompido por vencimento do plano.")
                break

            dest = (
                db.query(models.DisparoDestinatario)
                .filter(
                    models.DisparoDestinatario.disparo_id == disparo.id,
                    models.DisparoDestinatario.status == "pendente",
                )
                .order_by(models.DisparoDestinatario.id.asc())
                .first()
            )

            if not dest:
                disparo.status = "concluido"
                disparo.finalizado_em = datetime.now(timezone.utc)
                db.commit()
                print(f"[DISPARO] {disparo.id} concluído.")
                break

            print(f"[DISPARO] Enviando destinatário #{dest.id} -> {dest.numero_normalizado}")

            dest.status = "enviando"
            dest.tentativas = (dest.tentativas or 0) + 1
            dest.ultima_tentativa_em = datetime.now(timezone.utc)
            db.commit()

            try:
                await _enviar_destinatario(db, disparo, dest)
            except Exception as e:  # noqa: BLE001
                print(f"[DISPARO] Erro ao enviar destinatário #{dest.id}: {e!r}")
                dest.status = "erro"
                dest.erro_msg = str(e)[:4000]
                disparo.enviados_erro = (disparo.enviados_erro or 0) + 1
                db.commit()
            else:
                dest.status = "enviado"
                dest.enviado_em = datetime.now(timezone.utc)
                disparo.enviados_sucesso = (disparo.enviados_sucesso or 0) + 1
                db.commit()

            await asyncio.sleep(delay)

    finally:
        db.close()


# =====================================================
# Endpoints
# =====================================================

@router.post(
    "/ia-melhorar",
    response_model=IAMelhorarDisparoResp,
    summary="Usa IA (n8n) para sugerir uma versão melhorada da mensagem de disparo",
)
async def ia_melhorar_disparo(
    body: dict = Body(...),
    db: Session = Depends(get_db),
    identity: dict = Depends(get_current_identity),
):
    if identity is None:
        raise HTTPException(status_code=401, detail="Não autenticado")

    empresa_id, _, _ = _get_ids(identity)
    empresa = _get_empresa_or_404(db, empresa_id)

    enforce_billing_active(
        empresa,
        message="Seu plano está vencido. Renove para usar a IA de disparos.",
    )

    if not has_feature(empresa, "feature_broadcasts"):
        raise HTTPException(
            status_code=403,
            detail="Seu plano não permite recursos de disparo.",
        )

    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Corpo inválido. Envie JSON.")

    raw = body.get("mensagem") or body.get("draft") or ""
    if raw is None:
        raw = ""
    if not isinstance(raw, str):
        raw = str(raw)

    texto = raw.strip()
    if not texto:
        raise HTTPException(status_code=400, detail="Mensagem vazia.")

    data = await _ia_melhorar_via_n8n(texto)

    melhorada = None
    if isinstance(data, dict):
        melhorada = (
            data.get("melhorada")
            or data.get("mensagem")
            or data.get("text")
            or data.get("draft")
            or data.get("resultado")
        )
    elif isinstance(data, str):
        melhorada = data

    if not isinstance(melhorada, str) or not melhorada.strip():
        melhorada = texto

    return IAMelhorarDisparoResp(original=texto, melhorada=melhorada)


@router.post(
    "/simples",
    response_model=DisparoOut,
    summary="Cria um disparo simples (uma mensagem para vários números)",
)
async def criar_disparo_simples(
    payload: DisparoCreate = Body(...),
    db: Session = Depends(get_db),
    identity: dict = Depends(get_current_identity),
):
    _ensure_perm(identity, db, "disparos.enviar")

    empresa_id, colab_id, usuario_id = _get_ids(identity)
    empresa = _get_empresa_or_404(db, empresa_id)

    # 🔒 vencimento
    enforce_billing_active(
        empresa,
        message="Seu plano está vencido. Renove para criar disparos.",
    )

    # 🔒 Plano: feature_broadcasts
    if not has_feature(empresa, "feature_broadcasts"):
        raise HTTPException(
            status_code=403,
            detail="Seu plano não permite disparos (feature_broadcasts).",
        )

    # 🔒 ACL por instância
    _assert_instancia_acl(identity, db, payload.instancia_id)

    # Se for admin e existir colaborador vinculado ao usuario_id, preenche também
    if usuario_id and not colab_id:
        colab_id = _resolve_colab_by_usuario(db, empresa_id, usuario_id)

    instancia = (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.id == payload.instancia_id,
            models.EmpresaInstancia.empresa_id == empresa_id,
        )
        .first()
    )
    if not instancia:
        raise HTTPException(status_code=404, detail="Instância não encontrada para esta empresa.")

    nums_norm = _normalizar_numeros(payload.numeros)
    if not nums_norm:
        raise HTTPException(status_code=400, detail="Nenhum número válido informado.")

    # 🔒 Quota mensal de disparos
    current_broadcasts_month = _current_month_broadcasts_count(db, empresa_id)
    enforce_quota(
        empresa,
        "broadcasts_per_month_max",
        current_broadcasts_month,
        delta=1,
        message="Limite mensal de disparos do plano atingido.",
    )

    disparo = models.Disparo(
        empresa_id=empresa_id,
        instancia_id=payload.instancia_id,
        colaborador_id=colab_id,
        usuario_id=usuario_id,
        tipo_conteudo=(payload.tipo_conteudo or "text"),
        mensagem=payload.mensagem,
        midia_id=payload.midia_id,
        delay_segundos=payload.delay_segundos,
        total_destinatarios=len(nums_norm),
        status="pendente",
    )
    db.add(disparo)
    db.flush()

    for raw, norm in nums_norm:
        dest = models.DisparoDestinatario(
            disparo_id=disparo.id,
            numero_raw=raw,
            numero_normalizado=norm,
            nome=None,
            status="pendente",
        )
        db.add(dest)

    db.commit()
    db.refresh(disparo)

    asyncio.create_task(_processar_disparo(disparo.id))

    instancia_nome = None
    if disparo.instancia:
        instancia_nome = disparo.instancia.apelido or disparo.instancia.instance_name

    criado_por, criado_por_tipo = _get_nome_autor(db, disparo.colaborador_id, disparo.usuario_id)

    return DisparoOut(
        id=disparo.id,
        mensagem=disparo.mensagem,
        qtd_numeros=disparo.total_destinatarios or 0,
        instancia_id=disparo.instancia_id,
        instancia_nome=instancia_nome,
        status=disparo.status,
        criado_em=disparo.criado_em,
        delay_segundos=disparo.delay_segundos,
        colaborador_id=disparo.colaborador_id,
        usuario_id=disparo.usuario_id,
        criado_por=criado_por,
        criado_por_tipo=criado_por_tipo,
    )


@router.get(
    "",
    response_model=List[DisparoOut],
    summary="Lista disparos da empresa (opcionalmente filtrando por instância)",
)
def listar_disparos(
    empresa_id: int = Query(..., description="ID da empresa"),
    instancia_id: Optional[int] = Query(None, description="Filtrar por instância"),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    identity: dict = Depends(get_current_identity),
):
    _ensure_perm(identity, db, "disparos.ver")

    ident_empresa_id = _to_int(identity.get("empresa_id"))
    if ident_empresa_id and int(ident_empresa_id) != int(empresa_id):
        raise HTTPException(status_code=403, detail="Empresa inválida para o usuário logado.")

    if instancia_id is not None:
        _assert_instancia_acl(identity, db, instancia_id)

    q = (
        db.query(models.Disparo)
        .filter(models.Disparo.empresa_id == empresa_id)
        .order_by(models.Disparo.id.desc())
    )

    q = _apply_instancias_filter(identity, db, q)

    if instancia_id:
        q = q.filter(models.Disparo.instancia_id == instancia_id)

    itens = q.limit(limit).all()

    colab_ids: Set[int] = {int(d.colaborador_id) for d in itens if d.colaborador_id}
    user_ids: Set[int] = {int(d.usuario_id) for d in itens if d.usuario_id}

    colab_map: Dict[int, str] = {}
    user_map: Dict[int, str] = {}

    if colab_ids:
        for cid, nome in (
            db.query(models.Colaborador.id, models.Colaborador.nome)
            .filter(models.Colaborador.id.in_(colab_ids))
            .all()
        ):
            if cid:
                colab_map[int(cid)] = str(nome or "")

    if user_ids:
        for uid, nome in (
            db.query(models.Usuario.id, models.Usuario.nome)
            .filter(models.Usuario.id.in_(user_ids))
            .all()
        ):
            if uid:
                user_map[int(uid)] = str(nome or "")

    out: list[DisparoOut] = []
    for d in itens:
        instancia_nome = None
        if d.instancia:
            instancia_nome = d.instancia.apelido or d.instancia.instance_name

        criado_por = None
        criado_por_tipo = None
        if d.colaborador_id:
            criado_por = colab_map.get(int(d.colaborador_id)) or None
            criado_por_tipo = "colaborador"
        elif d.usuario_id:
            criado_por = user_map.get(int(d.usuario_id)) or None
            criado_por_tipo = "usuario"

        out.append(
            DisparoOut(
                id=d.id,
                mensagem=d.mensagem,
                qtd_numeros=d.total_destinatarios or 0,
                instancia_id=d.instancia_id,
                instancia_nome=instancia_nome,
                status=d.status,
                criado_em=d.criado_em,
                delay_segundos=d.delay_segundos,
                colaborador_id=d.colaborador_id,
                usuario_id=d.usuario_id,
                criado_por=criado_por,
                criado_por_tipo=criado_por_tipo,
            )
        )
    return out


@router.post(
    "/{disparo_id}/cancelar",
    summary="Cancela o processamento de um disparo (não interrompe o envio atual, mas impede os próximos)",
)
def cancelar_disparo(
    disparo_id: int,
    db: Session = Depends(get_db),
    identity: dict = Depends(get_current_identity),
):
    _ensure_perm(identity, db, "disparos.configurar")

    empresa_id, _ = _get_empresa_e_colab(identity)

    disparo = (
        db.query(models.Disparo)
        .filter(
            models.Disparo.id == disparo_id,
            models.Disparo.empresa_id == empresa_id,
        )
        .first()
    )
    if not disparo:
        raise HTTPException(status_code=404, detail="Disparo não encontrado.")

    _assert_instancia_acl(identity, db, getattr(disparo, "instancia_id", None))

    if disparo.status in ("concluido", "cancelado"):
        return {"ok": True, "status": disparo.status}

    disparo.status = "cancelado"
    disparo.finalizado_em = datetime.now(timezone.utc)
    db.commit()

    return {"ok": True, "status": disparo.status}
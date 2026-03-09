from __future__ import annotations

from datetime import date, datetime, time, timezone, timedelta
from typing import Optional, List, Any, Dict, Set

from fastapi import APIRouter, Depends, HTTPException, Header, Query, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import desc, or_, and_
from sqlalchemy.orm import Session, aliased
from sqlalchemy.exc import IntegrityError

import io, csv, json, hashlib
from openpyxl import Workbook, load_workbook
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None  # type: ignore


def tz_sao_paulo():
    if ZoneInfo:
        try:
            return ZoneInfo("America/Sao_Paulo")
        except Exception:
            pass
    return timezone(timedelta(hours=-3))


from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_identity
from backend.utils.entitlements import enforce_quota, has_feature
from backend.security.instancias import instancias_visiveis
from backend.cache.redis_client import (
    get_json as cache_get_json,
    set_json as cache_set_json,
    delete_prefix as cache_delete_prefix,
    k as cache_k,
)

router = APIRouter(prefix="/clientes", tags=["Clientes"])


class PatchClienteProfile(BaseModel):
    departamento: Optional[str] = None
    sobre_cliente: Optional[str] = None
    nome: Optional[str] = None
    telefone: Optional[str] = None
    cpf_cnpj: Optional[str] = None
    rg: Optional[str] = None
    email: Optional[str] = None
    data_nascimento: Optional[datetime] = None
    genero: Optional[str] = None
    cep: Optional[str] = None
    endereco: Optional[str] = None
    numero: Optional[str] = None
    complemento: Optional[str] = None
    bairro: Optional[str] = None
    cidade: Optional[str] = None
    estado: Optional[str] = None
    nome_completo: Optional[str] = None
    website: Optional[str] = None
    descricao: Optional[str] = None


class PostNovoCliente(BaseModel):
    nome: Optional[str] = None
    telefone: str
    departamento: Optional[str] = None
    sobre_cliente: Optional[str] = None
    colaborador_id: Optional[int] = None


class BulkColaboradorIn(BaseModel):
    ids: List[int]
    colaborador_id: Optional[int]


class BulkDepartamentoIn(BaseModel):
    ids: List[int]
    departamento_id: Optional[int]


def _id_get(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def resolve_empresa_id(
    x_empresa_id: Optional[int] = Header(default=None, alias="X-Empresa-Id"),
    empresa_id_qs: Optional[int] = Query(default=None, alias="empresa_id"),
) -> int:
    emp = x_empresa_id or empresa_id_qs
    if not emp:
        raise HTTPException(
            status_code=400,
            detail="empresa_id é obrigatório (X-Empresa-Id ou ?empresa_id=)",
        )
    return int(emp)


def _digits(s: str) -> str:
    return "".join(ch for ch in (s or "") if ch.isdigit())


def _iso(dt):
    if not dt:
        return None
    if isinstance(dt, (datetime, date)):
        if isinstance(dt, datetime) and dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat(timespec="seconds")
    return str(dt)


def _get_perms(identity) -> set[str]:
    return set(_id_get(identity, "permissoes", []) or [])


def _assert_instancia_acl(identity: Any, db: Session, instancia_id: Optional[int]) -> None:
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


def _apply_instancias_filter(identity: Any, db: Session, query):
    vis = instancias_visiveis(identity, db)
    if vis is None:
        return query
    if not vis:
        return query.filter(models.Cliente.id == -1)
    return query.filter(models.Cliente.instancia_id.in_(vis))


def get_empresa_autorizada(
    empresa_id: int = Depends(resolve_empresa_id),
    identity=Depends(get_current_identity),
) -> int:
    emp = _id_get(identity, "empresa_id")
    if emp is not None and int(emp) != int(empresa_id):
        raise HTTPException(
            status_code=403,
            detail="Empresa inválida para este usuário",
        )
    return int(empresa_id)


COLUMNS = ["nome", "telefone", "departamento", "sobre_cliente"]


def _clean_text(x: str | None) -> str:
    return (x or "").replace("\r", "").strip()


def _auto_sep(sample: str) -> str:
    return ";" if sample.count(";") >= sample.count(",") else ","


def _xlsx_rows_to_dicts(ws):
    rows = list(ws.rows)
    if not rows:
        return []
    head = [str((c.value or "")).strip().lower() for c in rows[0]]
    start = 1 if all(h in COLUMNS for h in head[:4]) else 0
    out = []
    for r in rows[start:]:
        vals = [str(c.value or "").strip() for c in r[:4]] + ["", "", "", ""]
        out.append(
            {
                "nome": vals[0],
                "telefone": vals[1],
                "departamento": vals[2],
                "sobre_cliente": vals[3],
            }
        )
    return out


@router.get("")
def listar_clientes(
    empresa_id: int = Depends(get_empresa_autorizada),
    q: Optional[str] = Query(None),
    departamento: Optional[str] = Query(None),
    data_inicio: Optional[date] = Query(None),
    data_fim: Optional[date] = Query(None),
    instancia_id: Optional[int] = Query(None),
    colaborador_id: Optional[int] = Query(None),
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    perms = _get_perms(identity)
    if "clientes.ver" not in perms:
        raise HTTPException(
            status_code=403,
            detail="Sem permissão para ver clientes (clientes.ver).",
        )

    if instancia_id is not None:
        _assert_instancia_acl(identity, db, instancia_id)

    key_src = json.dumps(
        {
            "emp": empresa_id,
            "q": (q or "").strip(),
            "departamento": (departamento or "").strip(),
            "di": str(data_inicio) if data_inicio else "",
            "df": str(data_fim) if data_fim else "",
            "inst": instancia_id,
            "colab": colaborador_id,
            "limit": limit,
            "offset": offset,
            "acl": instancias_visiveis(identity, db),
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    hashed = hashlib.sha256(key_src.encode("utf-8")).hexdigest()
    cache_key = cache_k("clientes", "list", str(empresa_id), hashed)

    cached = cache_get_json(cache_key)
    if cached:
        return cached

    Colab = aliased(models.Colaborador)

    base = (
        db.query(
            models.Cliente.id,
            models.Cliente.nome,
            models.Cliente.nome_whatsapp,
            models.Cliente.telefone,
            models.Cliente.avatar_url,
            models.Cliente.departamento,
            models.Cliente.departamento_id,
            models.Cliente.sobre_cliente.label("sobre"),
            models.Cliente.timestamp.label("data_cadastro"),
            models.Cliente.timestamp.label("timestamp"),
            models.Cliente.colaborador_id,
            Colab.nome.label("colaborador_nome"),
            models.Cliente.instancia_id,
        )
        .outerjoin(
            Colab,
            and_(
                Colab.id == models.Cliente.colaborador_id,
                Colab.empresa_id == models.Cliente.empresa_id,
            ),
        )
        .filter(models.Cliente.empresa_id == empresa_id)
    )

    base = _apply_instancias_filter(identity, db, base)

    if instancia_id is not None:
        base = base.filter(models.Cliente.instancia_id == instancia_id)

    if q:
        like = f"%{q.strip()}%"
        dq = _digits(q)
        conds = [
            models.Cliente.nome.ilike(like),
            models.Cliente.nome_whatsapp.ilike(like),
            models.Cliente.telefone.ilike(like),
        ]
        if dq:
            conds.append(models.Cliente.telefone_norm.ilike(f"%{dq}%"))
        base = base.filter(or_(*conds))

    if departamento:
        base = base.filter(models.Cliente.departamento == departamento)

    if colaborador_id is not None:
        if colaborador_id == 0:
            base = base.filter(models.Cliente.colaborador_id.is_(None))
        else:
            base = base.filter(models.Cliente.colaborador_id == colaborador_id)

    tz_sp = tz_sao_paulo()
    if data_inicio:
        ini_local = datetime.combine(data_inicio, time(0, 0, 0, tzinfo=tz_sp))
        ini_utc = ini_local.astimezone(timezone.utc)
        base = base.filter(models.Cliente.timestamp >= ini_utc)
    if data_fim:
        fim_local = datetime.combine(data_fim, time(23, 59, 59, 999_999, tzinfo=tz_sp))
        fim_utc = fim_local.astimezone(timezone.utc)
        base = base.filter(models.Cliente.timestamp <= fim_utc)

    base = base.order_by(desc(models.Cliente.timestamp), desc(models.Cliente.id)).offset(offset).limit(limit)
    rows = base.all()

    items = [
        {
            "id": rrow.id,
            "nome": rrow.nome,
            "nome_whatsapp": rrow.nome_whatsapp,
            "telefone": rrow.telefone,
            "avatar_url": rrow.avatar_url,
            "departamento": rrow.departamento,
            "departamento_id": rrow.departamento_id,
            "sobre": (rrow.sobre or None),
            "data_cadastro": _iso(getattr(rrow, "data_cadastro", None)),
            "timestamp": _iso(getattr(rrow, "timestamp", None)),
            "colaborador_id": rrow.colaborador_id,
            "colaborador_nome": rrow.colaborador_nome,
            "instancia_id": rrow.instancia_id,
        }
        for rrow in rows
    ]

    has_more = len(items) == limit
    out = {
        "items": items,
        "has_more": has_more,
        "next_offset": (offset + len(items)) if has_more else None,
        "limit": limit,
        "offset": offset,
    }

    cache_set_json(cache_key, out)
    return out


@router.get("/search")
def buscar_clientes_leve(
    empresa_id: int = Depends(get_empresa_autorizada),
    q: str = Query(..., min_length=1),
    limit: int = Query(8, ge=1, le=20),
    instancia_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    perms = _get_perms(identity)
    if "clientes.ver" not in perms:
        raise HTTPException(
            status_code=403,
            detail="Sem permissão para buscar clientes.",
        )

    termo = (q or "").strip()
    if not termo:
        return {"items": []}

    if instancia_id is not None:
        _assert_instancia_acl(identity, db, instancia_id)

    like = f"%{termo}%"
    dq = _digits(termo)

    query = (
        db.query(
            models.Cliente.id,
            models.Cliente.nome,
            models.Cliente.nome_whatsapp,
            models.Cliente.telefone,
            models.Cliente.avatar_url,
            models.Cliente.instancia_id,
        )
        .filter(models.Cliente.empresa_id == empresa_id)
    )

    query = _apply_instancias_filter(identity, db, query)

    if instancia_id is not None:
        query = query.filter(models.Cliente.instancia_id == instancia_id)

    conds = [
        models.Cliente.nome.ilike(like),
        models.Cliente.nome_whatsapp.ilike(like),
        models.Cliente.telefone.ilike(like),
    ]
    if dq:
        conds.append(models.Cliente.telefone_norm.ilike(f"%{dq}%"))

    rows = (
        query
        .filter(or_(*conds))
        .order_by(desc(models.Cliente.timestamp), desc(models.Cliente.id))
        .limit(limit)
        .all()
    )

    items = []
    for r in rows:
        nome = (r.nome_whatsapp or r.nome or "Cliente").strip()
        items.append({
            "id": r.id,
            "nome": nome,
            "telefone": r.telefone,
            "avatar_url": r.avatar_url,
            "instancia_id": r.instancia_id,
        })

    return {"items": items}


@router.get("/colaboradores")
def listar_colaboradores(
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    perms = _get_perms(identity)
    if "clientes.ver" not in perms and "clientes.editar" not in perms:
        raise HTTPException(
            status_code=403,
            detail="Sem permissão para listar colaboradores para clientes.",
        )

    q = (
        db.query(models.Colaborador.id, models.Colaborador.nome, models.Colaborador.email)
        .filter(models.Colaborador.empresa_id == empresa_id)
        .order_by(models.Colaborador.nome.asc())
    )
    items = [{"id": r.id, "nome": r.nome, "email": r.email} for r in q.all()]
    return {"items": items}


@router.get("/{cliente_id}")
def obter_cliente(
    cliente_id: int,
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    perms = _get_perms(identity)
    if "clientes.ver" not in perms:
        raise HTTPException(
            status_code=403,
            detail="Sem permissão para ver detalhes de clientes.",
        )

    Colab = aliased(models.Colaborador)
    r = (
        db.query(
            models.Cliente.id,
            models.Cliente.nome,
            models.Cliente.nome_whatsapp,
            models.Cliente.telefone,
            models.Cliente.avatar_url,
            models.Cliente.departamento,
            models.Cliente.departamento_id,
            models.Cliente.sobre_cliente.label("sobre"),
            models.Cliente.timestamp.label("data_cadastro"),
            models.Cliente.timestamp.label("timestamp"),
            models.Cliente.colaborador_id,
            Colab.nome.label("colaborador_nome"),
            models.Cliente.instancia_id,
            models.Cliente.cpf_cnpj,
            models.Cliente.rg,
            models.Cliente.email,
            models.Cliente.data_nascimento,
            models.Cliente.genero,
            models.Cliente.cep,
            models.Cliente.endereco,
            models.Cliente.numero,
            models.Cliente.complemento,
            models.Cliente.bairro,
            models.Cliente.cidade,
            models.Cliente.estado,
            models.Cliente.nome_completo,
            models.Cliente.website,
            models.Cliente.descricao,
            models.Cliente.is_business,
            models.Cliente.status_whatsapp,
        )
        .outerjoin(
            Colab,
            and_(
                Colab.id == models.Cliente.colaborador_id,
                Colab.empresa_id == models.Cliente.empresa_id,
            ),
        )
        .filter(models.Cliente.id == cliente_id, models.Cliente.empresa_id == empresa_id)
        .first()
    )
    if not r:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    _assert_instancia_acl(identity, db, r.instancia_id)

    return {
        "id": r.id,
        "nome": r.nome,
        "nome_whatsapp": r.nome_whatsapp,
        "telefone": r.telefone,
        "avatar_url": r.avatar_url,
        "departamento": r.departamento,
        "departamento_id": r.departamento_id,
        "sobre": r.sobre or None,
        "data_cadastro": _iso(getattr(r, "data_cadastro", None)),
        "timestamp": _iso(getattr(r, "timestamp", None)),
        "colaborador_id": r.colaborador_id,
        "colaborador_nome": r.colaborador_nome,
        "instancia_id": r.instancia_id,
        "cpf_cnpj": r.cpf_cnpj,
        "rg": r.rg,
        "email": r.email,
        "data_nascimento": _iso(r.data_nascimento),
        "genero": r.genero,
        "cep": r.cep,
        "endereco": r.endereco,
        "numero": r.numero,
        "complemento": r.complemento,
        "bairro": r.bairro,
        "cidade": r.cidade,
        "estado": r.estado,
        "nome_completo": r.nome_completo,
        "website": r.website,
        "descricao": r.descricao,
        "is_business": r.is_business,
        "status_whatsapp": r.status_whatsapp,
    }


@router.patch("/{cliente_id}/profile")
def patch_cliente_profile(
    cliente_id: int,
    payload: PatchClienteProfile,
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    perms = _get_perms(identity)
    if "clientes.editar" not in perms:
        raise HTTPException(
            status_code=403,
            detail="Sem permissão para editar clientes (clientes.editar).",
        )

    c = (
        db.query(models.Cliente)
        .filter(models.Cliente.id == cliente_id, models.Cliente.empresa_id == empresa_id)
        .first()
    )
    if not c:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    _assert_instancia_acl(identity, db, getattr(c, "instancia_id", None))

    if payload.departamento is not None:
        c.departamento = payload.departamento or None
    if payload.sobre_cliente is not None:
        c.sobre_cliente = payload.sobre_cliente or None

    if payload.nome is not None:
        c.nome = payload.nome or "Cliente"

    if payload.telefone is not None:
        tel = _digits(payload.telefone)
        if not tel:
            raise HTTPException(status_code=400, detail="Telefone inválido")
        dup = (
            db.query(models.Cliente)
            .filter(
                models.Cliente.empresa_id == empresa_id,
                models.Cliente.telefone_norm == tel,
                models.Cliente.id != cliente_id,
            )
            .first()
        )
        if dup:
            raise HTTPException(status_code=400, detail="Já existe um cliente com esse telefone.")
        c.telefone = tel

    if payload.cpf_cnpj is not None:
        c.cpf_cnpj = payload.cpf_cnpj or None
    if payload.rg is not None:
        c.rg = payload.rg or None
    if payload.email is not None:
        c.email = payload.email or None
    if payload.data_nascimento is not None:
        c.data_nascimento = payload.data_nascimento
    if payload.genero is not None:
        c.genero = payload.genero or None

    if payload.cep is not None:
        c.cep = payload.cep or None
    if payload.endereco is not None:
        c.endereco = payload.endereco or None
    if payload.numero is not None:
        c.numero = payload.numero or None
    if payload.complemento is not None:
        c.complemento = payload.complemento or None
    if payload.bairro is not None:
        c.bairro = payload.bairro or None
    if payload.cidade is not None:
        c.cidade = payload.cidade or None
    if payload.estado is not None:
        c.estado = payload.estado or None

    if payload.nome_completo is not None:
        c.nome_completo = payload.nome_completo or None
    if payload.website is not None:
        c.website = payload.website or None
    if payload.descricao is not None:
        c.descricao = payload.descricao or None

    db.add(c)
    db.commit()

    cache_delete_prefix(cache_k("clientes", "list", str(empresa_id)))
    return {"ok": True}


@router.post("/novo")
def criar_cliente(
    body: PostNovoCliente,
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    perms = _get_perms(identity)
    if "clientes.criar" not in perms:
        raise HTTPException(
            status_code=403,
            detail="Sem permissão para criar clientes (clientes.criar).",
        )

    tel = _digits(body.telefone)
    if not tel:
        raise HTTPException(status_code=400, detail="Telefone inválido")

    dup = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.empresa_id == empresa_id,
            models.Cliente.telefone_norm == tel,
        )
        .first()
    )
    if dup:
        return {"id": dup.id, "exists": True}

    enforce_quota(db, empresa_id, "contacts_max", delta=1)

    colab_id = body.colaborador_id
    if colab_id is not None:
        exists = (
            db.query(models.Colaborador)
            .filter(models.Colaborador.id == colab_id, models.Colaborador.empresa_id == empresa_id)
            .first()
        )
        if not exists:
            raise HTTPException(status_code=400, detail="colaborador_id inválido para esta empresa")

    c = models.Cliente(
        empresa_id=empresa_id,
        nome=(body.nome or "Cliente"),
        telefone=tel,
        departamento=(body.departamento or None),
        colaborador_id=colab_id,
        timestamp=datetime.now(timezone.utc),
    )
    if body.sobre_cliente is not None:
        c.sobre_cliente = body.sobre_cliente

    db.add(c)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        dup2 = (
            db.query(models.Cliente)
            .filter(
                models.Cliente.empresa_id == empresa_id,
                models.Cliente.telefone_norm == tel,
            )
            .first()
        )
        if dup2:
            return {"id": dup2.id, "exists": True}
        raise HTTPException(status_code=400, detail="Erro de integridade ao criar cliente")

    db.refresh(c)
    cache_delete_prefix(cache_k("clientes", "list", str(empresa_id)))
    return {"id": c.id, "created": True}


@router.get("/export")
def exportar_clientes(
    fmt: str = Query("csv", pattern="^(csv|xlsx|pdf)$"),
    ids: Optional[str] = Query(None, description="IDs separados por vírgula (ex: 1,2,3)"),
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    perms = _get_perms(identity)
    if "clientes.importar_exportar" not in perms:
        raise HTTPException(
            status_code=403,
            detail="Sem permissão para exportar clientes (clientes.importar_exportar).",
        )

    if not has_feature(db, empresa_id, "feature_export"):
        raise HTTPException(
            status_code=403,
            detail="Seu plano não permite exportação de clientes (feature_export).",
        )

    q = db.query(models.Cliente).filter(models.Cliente.empresa_id == empresa_id)
    q = _apply_instancias_filter(identity, db, q)

    ids_set: set[int] = set()
    if ids:
        for x in ids.split(","):
            x = (x or "").strip()
            if x.isdigit():
                ids_set.add(int(x))
    if ids_set:
        q = q.filter(models.Cliente.id.in_(list(ids_set)))

    rows: list[models.Cliente] = q.order_by(models.Cliente.nome.asc()).all()

    if fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=";")
        w.writerow(["nome", "telefone", "departamento", "sobre_cliente"])
        for r in rows:
            w.writerow(
                [
                    _clean_text(r.nome),
                    _clean_text(r.telefone),
                    _clean_text(r.departamento),
                    _clean_text(r.sobre_cliente),
                ]
            )
        data = buf.getvalue().encode("utf-8-sig")
        return StreamingResponse(
            io.BytesIO(data),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="clientes.csv"'},
        )

    if fmt == "xlsx":
        wb = Workbook()
        ws = wb.active
        ws.title = "Clientes"
        ws.append(["nome", "telefone", "departamento", "sobre_cliente"])
        for r in rows:
            ws.append([r.nome or "", r.telefone or "", r.departamento or "", r.sobre_cliente or ""])
        out = io.BytesIO()
        wb.save(out)
        out.seek(0)
        return StreamingResponse(
            out,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": 'attachment; filename="clientes.xlsx"'},
        )

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    width, height = A4
    left, top = 40, height - 50
    c.setFont("Helvetica-Bold", 12)
    c.drawString(left, top, "Relatório de Clientes")
    c.setFont("Helvetica", 9)
    y = top - 24
    c.drawString(left, y, "Nome")
    c.drawString(left + 220, y, "Telefone")
    c.drawString(left + 360, y, "Departamento")
    y -= 16
    c.line(left, y + 12, width - 40, y + 12)

    for r in rows:
        if y < 50:
            c.showPage()
            y = height - 60
            c.setFont("Helvetica", 9)
        c.drawString(left, y, (r.nome or "")[:32])
        c.drawString(left + 220, y, (r.telefone or "")[:20])
        c.drawString(left + 360, y, (r.departamento or "")[:18])
        y -= 14

    c.showPage()
    c.save()
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="clientes.pdf"'},
    )


@router.post("/import")
def importar_clientes(
    arquivo: UploadFile = File(...),
    sobrescrever: bool = Query(False, description="Atualiza dados se telefone já existir"),
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    perms = _get_perms(identity)
    if "clientes.importar_exportar" not in perms:
        raise HTTPException(
            status_code=403,
            detail="Sem permissão para importar clientes (clientes.importar_exportar).",
        )

    if not has_feature(db, empresa_id, "feature_import"):
        raise HTTPException(
            status_code=403,
            detail="Seu plano não permite importação de clientes (feature_import).",
        )

    name = (arquivo.filename or "").lower()
    content = arquivo.file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Arquivo vazio.")

    parsed_rows: List[Dict[str, str]] = []
    if name.endswith(".xlsx"):
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        ws = wb.active
        parsed_rows = _xlsx_rows_to_dicts(ws)
    elif name.endswith(".csv") or name.endswith(".txt"):
        data = content.decode("utf-8-sig", errors="ignore")
        sep = _auto_sep(data)
        reader = csv.reader(io.StringIO(data), delimiter=sep)
        rows = list(reader)
        if not rows:
            raise HTTPException(status_code=400, detail="Arquivo sem linhas.")

        head = [(_clean_text(x)).lower() for x in rows[0]]
        start = 1 if all(h in COLUMNS for h in head[:4]) else 0

        for r in rows[start:]:
            if not r:
                continue
            if len(r) == 1:
                parsed_rows.append({"nome": "", "telefone": r[0], "departamento": "", "sobre_cliente": ""})
            else:
                v = [(r[i] if i < len(r) else "").strip() for i in range(4)]
                parsed_rows.append({"nome": v[0], "telefone": v[1], "departamento": v[2], "sobre_cliente": v[3]})
    else:
        raise HTTPException(status_code=400, detail="Formato não suportado. Use CSV, XLSX ou TXT.")

    phones: List[str] = []
    seen: Set[str] = set()
    for row in parsed_rows:
        tel = _digits(row.get("telefone") or "")
        if not tel:
            continue
        if tel not in seen:
            seen.add(tel)
            phones.append(tel)

    existing: Set[str] = set()
    if phones:
        rows_exist = (
            db.query(models.Cliente.telefone_norm)
            .filter(models.Cliente.empresa_id == empresa_id, models.Cliente.telefone_norm.in_(phones))
            .all()
        )
        existing = {str(r[0]) for r in rows_exist if r and r[0]}

    to_insert = len([p for p in phones if p not in existing])

    if to_insert > 0:
        enforce_quota(db, empresa_id, "contacts_max", delta=to_insert)

    inseridos = atualizados = ignorados = 0

    def upsert(nome, telefone, departamento, sobre):
        nonlocal inseridos, atualizados, ignorados
        tel = _digits(telefone or "")
        if not tel:
            ignorados += 1
            return
        cli = (
            db.query(models.Cliente)
            .filter(models.Cliente.empresa_id == empresa_id, models.Cliente.telefone_norm == tel)
            .first()
        )
        if cli:
            _assert_instancia_acl(identity, db, getattr(cli, "instancia_id", None))
            if sobrescrever:
                if nome:
                    cli.nome = nome
                cli.departamento = (departamento or None)
                cli.sobre_cliente = (sobre or None)
                db.add(cli)
                atualizados += 1
        else:
            novo = models.Cliente(
                empresa_id=empresa_id,
                nome=(nome or "Cliente"),
                telefone=tel,
                departamento=(departamento or None),
                sobre_cliente=(sobre or None),
                timestamp=datetime.now(timezone.utc),
            )
            db.add(novo)
            inseridos += 1

    for row in parsed_rows:
        upsert(row.get("nome"), row.get("telefone"), row.get("departamento"), row.get("sobre_cliente"))

    db.commit()
    cache_delete_prefix(cache_k("clientes", "list", str(empresa_id)))

    return {
        "ok": True,
        "inseridos": inseridos,
        "atualizados": atualizados,
        "ignorados": ignorados,
    }


@router.post("/bulk/colaborador")
def trocar_colaborador_em_massa(
    payload: BulkColaboradorIn,
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    perms = _get_perms(identity)
    if "clientes.editar" not in perms:
        raise HTTPException(
            status_code=403,
            detail="Sem permissão para editar responsáveis dos clientes.",
        )

    if not payload.ids:
        raise HTTPException(status_code=400, detail="Lista de IDs vazia.")

    if payload.colaborador_id is not None:
        ok = (
            db.query(models.Colaborador)
            .filter(models.Colaborador.id == payload.colaborador_id, models.Colaborador.empresa_id == empresa_id)
            .first()
        )
        if not ok:
            raise HTTPException(status_code=400, detail="colaborador_id inválido para esta empresa")

    q = db.query(models.Cliente).filter(
        models.Cliente.empresa_id == empresa_id,
        models.Cliente.id.in_(payload.ids),
    )
    q = _apply_instancias_filter(identity, db, q)

    updated = 0
    for c in q:
        _assert_instancia_acl(identity, db, getattr(c, "instancia_id", None))
        c.colaborador_id = payload.colaborador_id
        db.add(c)
        updated += 1

    db.commit()
    cache_delete_prefix(cache_k("clientes", "list", str(empresa_id)))

    return {"ok": True, "updated": updated}


@router.patch("/{cliente_id}/colaborador")
def trocar_colaborador_unitario(
    cliente_id: int,
    novo_colaborador_id: Optional[int] = Query(None, description="ID do colaborador; null remove"),
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    perms = _get_perms(identity)
    if "clientes.editar" not in perms:
        raise HTTPException(
            status_code=403,
            detail="Sem permissão para editar responsáveis dos clientes.",
        )

    cli = (
        db.query(models.Cliente)
        .filter(models.Cliente.id == cliente_id, models.Cliente.empresa_id == empresa_id)
        .first()
    )
    if not cli:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    _assert_instancia_acl(identity, db, getattr(cli, "instancia_id", None))

    if novo_colaborador_id is not None:
        ok = (
            db.query(models.Colaborador)
            .filter(models.Colaborador.id == novo_colaborador_id, models.Colaborador.empresa_id == empresa_id)
            .first()
        )
        if not ok:
            raise HTTPException(status_code=400, detail="colaborador_id inválido para esta empresa")

    cli.colaborador_id = novo_colaborador_id
    db.add(cli)
    db.commit()
    cache_delete_prefix(cache_k("clientes", "list", str(empresa_id)))
    return {"ok": True}


@router.post("/bulk/departamento")
def trocar_departamento_em_massa(
    payload: BulkDepartamentoIn,
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    perms = _get_perms(identity)
    if "clientes.editar" not in perms:
        raise HTTPException(
            status_code=403,
            detail="Sem permissão para alterar departamentos dos clientes.",
        )

    if not payload.ids:
        raise HTTPException(status_code=400, detail="Lista de IDs vazia.")

    dep_nome: Optional[str] = None
    dep_id = payload.departamento_id

    if dep_id is not None:
        dep_row = (
            db.query(models.Departamento)
            .filter(models.Departamento.id == dep_id, models.Departamento.empresa_id == empresa_id)
            .first()
        )
        if not dep_row:
            raise HTTPException(status_code=400, detail="departamento_id inválido para esta empresa")
        dep_nome = (dep_row.nome or "").strip() or None

    q = db.query(models.Cliente).filter(
        models.Cliente.empresa_id == empresa_id,
        models.Cliente.id.in_(payload.ids),
    )
    q = _apply_instancias_filter(identity, db, q)

    updated = 0
    for c in q:
        _assert_instancia_acl(identity, db, getattr(c, "instancia_id", None))
        c.departamento_id = dep_id
        c.departamento = dep_nome if dep_id is not None else None
        db.add(c)
        updated += 1

    db.commit()
    cache_delete_prefix(cache_k("clientes", "list", str(empresa_id)))

    return {"ok": True, "updated": updated, "departamento_nome": dep_nome}
from __future__ import annotations

from datetime import date, datetime, time, timezone, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Header, Query, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import desc, or_, and_
from sqlalchemy.orm import Session, aliased
from sqlalchemy.exc import IntegrityError  # <-- para tratar unicidade

import io, csv, json, hashlib
from openpyxl import Workbook, load_workbook
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

# ===== Zona/Timezone (SP com fallback UTC-3) =====
try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore


def tz_sao_paulo():
    if ZoneInfo:
        try:
            return ZoneInfo("America/Sao_Paulo")
        except Exception:
            pass
    return timezone(timedelta(hours=-3))


# ===== Infra =====
from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_user  # 🔒 para validar empresa do usuário

# ===== Redis cache util =====
from backend.cache.redis_client import (
    get_json as cache_get_json,
    set_json as cache_set_json,
    delete_prefix as cache_delete_prefix,
    k as cache_k,
)

router = APIRouter(prefix="/clientes", tags=["Clientes"])

# ---------- Schemas ----------
class PatchClienteProfile(BaseModel):
    departamento: Optional[str] = None
    sobre_cliente: Optional[str] = None


class PostNovoCliente(BaseModel):
    nome: Optional[str] = None
    telefone: str
    departamento: Optional[str] = None
    sobre_cliente: Optional[str] = None
    colaborador_id: Optional[int] = None  # opcional no create


class BulkColaboradorIn(BaseModel):
    ids: List[int]
    colaborador_id: Optional[int]  # null → remover colaborador


class BulkDepartamentoIn(BaseModel):
    ids: List[int]
    departamento_id: Optional[int]  # null → remover departamento


# ---------- helpers ----------
def resolve_empresa_id(
    x_empresa_id: Optional[int] = Header(default=None, alias="X-Empresa-Id"),
    empresa_id_qs: Optional[int] = Query(default=None, alias="empresa_id"),
) -> int:
    emp = x_empresa_id or empresa_id_qs
    if not emp:
        raise HTTPException(status_code=400, detail="empresa_id é obrigatório (X-Empresa-Id ou ?empresa_id=)")
    return int(emp)


def _digits(s: str) -> str:
    return "".join(ch for ch in (s or "") if ch.isdigit())


def _iso(dt):
    """ISO-8601 com seconds; se vier naive, assume UTC."""
    if not dt:
        return None
    if isinstance(dt, (datetime, date)):
        if isinstance(dt, datetime) and dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat(timespec="seconds")
    return str(dt)


# 🔒 helpers de segurança: empresa do usuário precisa bater com empresa_id
def _empresa_do_user(user) -> Optional[int]:
    return getattr(user, "empresa_id", None) or getattr(user, "empresa", None)


def get_empresa_autorizada(
    empresa_id: int = Depends(resolve_empresa_id),
    user=Depends(get_current_user),
) -> int:
    """
    Garante que o empresa_id pedido na rota é o mesmo da empresa do usuário logado.
    Evita que alguém, logado na empresa X, force X-Empresa-Id/Y=de outra empresa.
    """
    emp = _empresa_do_user(user)
    if emp is not None and int(emp) != int(empresa_id):
        raise HTTPException(status_code=403, detail="Empresa inválida para este usuário")
    return int(empresa_id)


# ======== helpers de IO (Export/Import) ========
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


# ============================================================
# =============== LISTAR (pagina por 20 + cache) ============
# ============================================================
@router.get("")  # sem response_model
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
):
    """
    Lista de clientes com paginação + cache.
    Inclui `colaborador_nome` e `departamento_id` no payload.
    """

    # ====== Cache key ======
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
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    hashed = hashlib.sha256(key_src.encode("utf-8")).hexdigest()
    cache_key = cache_k("clientes", "list", str(empresa_id), hashed)

    cached = cache_get_json(cache_key)
    if cached:
        return cached

    # ====== Query base ======
    Colab = aliased(models.Colaborador)

    base = (
        db.query(
            models.Cliente.id,
            models.Cliente.nome,
            models.Cliente.nome_whatsapp,
            models.Cliente.telefone,
            models.Cliente.avatar_url,
            models.Cliente.departamento,
            models.Cliente.departamento_id,  # <- incluído
            models.Cliente.sobre_cliente.label("sobre"),
            models.Cliente.timestamp.label("data_cadastro"),
            models.Cliente.timestamp.label("timestamp"),
            models.Cliente.colaborador_id,
            Colab.nome.label("colaborador_nome"),
        )
        .outerjoin(
            Colab,
            and_(
                Colab.id == models.Cliente.colaborador_id,
                Colab.empresa_id == models.Cliente.empresa_id,  # garante empresa
            ),
        )
        .filter(models.Cliente.empresa_id == empresa_id)
    )

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

    # Período em America/Sao_Paulo → UTC
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


# ============================================================
# ============= COLABORADORES (listar p/ select) ============
# ============================================================
@router.get("/colaboradores")
def listar_colaboradores(
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
):
    """
    Retorna a lista de colaboradores da empresa (id, nome, email) para popular o select.
    """
    q = (
        db.query(models.Colaborador.id, models.Colaborador.nome, models.Colaborador.email)
        .filter(models.Colaborador.empresa_id == empresa_id)
        .order_by(models.Colaborador.nome.asc())
    )
    items = [{"id": r.id, "nome": r.nome, "email": r.email} for r in q.all()]
    return {"items": items}


# ============================================================
# ===================== DETALHE /{id} =======================
# ============================================================
@router.get("/{cliente_id}")
def obter_cliente(
    cliente_id: int,
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
):
    """
    Retorna o detalhe do cliente, já incluindo `colaborador_nome` via join.
    """
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
        )
        .outerjoin(
            Colab,
            and_(
                Colab.id == models.Cliente.colaborador_id,
                Colab.empresa_id == models.Cliente.empresa_id,  # garante empresa
            ),
        )
        .filter(models.Cliente.id == cliente_id, models.Cliente.empresa_id == empresa_id)
        .first()
    )
    if not r:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

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
    }


# ============================================================
# ===================== PATCH /{id}/profile =================
# ============================================================
@router.patch("/{cliente_id}/profile")
def patch_cliente_profile(
    cliente_id: int,
    payload: PatchClienteProfile,
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
):
    c = (
        db.query(models.Cliente)
        .filter(models.Cliente.id == cliente_id, models.Cliente.empresa_id == empresa_id)
        .first()
    )
    if not c:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    if payload.departamento is not None:
        c.departamento = payload.departamento or None
    if payload.sobre_cliente is not None:
        c.sobre_cliente = payload.sobre_cliente or None

    db.add(c)
    db.commit()

    cache_delete_prefix(cache_k("clientes", "list", str(empresa_id)))
    return {"ok": True}


# ============================================================
# ========================= POST /novo =======================
# ============================================================
@router.post("/novo")
def criar_cliente(
    body: PostNovoCliente,
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
):
    tel = _digits(body.telefone)
    if not tel:
        raise HTTPException(status_code=400, detail="Telefone inválido")

    # Checa duplicidade pelo telefone_norm (coluna gerada = apenas dígitos)
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

    # valida colaborador (se enviado)
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
        # NÃO enviar telefone_norm (coluna gerada no banco)
    )
    if body.sobre_cliente is not None:
        c.sobre_cliente = body.sobre_cliente

    db.add(c)
    try:
        db.commit()
    except IntegrityError:
        # Pode ter corrida e bater no unique de telefone_norm
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


# ============================================================
# ============== EXPORTAR / IMPORTAR CLIENTES ===============
# ============================================================
@router.get("/export")
def exportar_clientes(
    fmt: str = Query("csv", pattern="^(csv|xlsx|pdf)$"),
    ids: Optional[str] = Query(None, description="IDs separados por vírgula (ex: 1,2,3)"),
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
):
    q = db.query(models.Cliente).filter(models.Cliente.empresa_id == empresa_id)

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
):
    name = (arquivo.filename or "").lower()
    content = arquivo.file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Arquivo vazio.")

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

    if name.endswith(".xlsx"):
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        ws = wb.active
        for row in _xlsx_rows_to_dicts(ws):
            upsert(row["nome"], row["telefone"], row["departamento"], row["sobre_cliente"])

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
                upsert("", r[0], "", "")
            else:
                v = [(r[i] if i < len(r) else "").strip() for i in range(4)]
                upsert(v[0], v[1], v[2], v[3])
    else:
        raise HTTPException(status_code=400, detail="Formato não suportado. Use CSV, XLSX ou TXT.")

    db.commit()
    cache_delete_prefix(cache_k("clientes", "list", str(empresa_id)))

    return {
        "ok": True,
        "inseridos": inseridos,
        "atualizados": atualizados,
        "ignorados": ignorados,
    }


# ============================================================
# ============= Atribuição de Colaborador ====================
# ============================================================
@router.post("/bulk/colaborador")
def trocar_colaborador_em_massa(
    payload: BulkColaboradorIn,
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
):
    """
    Atribui (ou remove) o colaborador de vários clientes.
    - colaborador_id = null → remove colaborador
    """
    if not payload.ids:
        raise HTTPException(status_code=400, detail="Lista de IDs vazia.")

    # valida colaborador se informado
    if payload.colaborador_id is not None:
        ok = (
            db.query(models.Colaborador)
            .filter(models.Colaborador.id == payload.colaborador_id, models.Colaborador.empresa_id == empresa_id)
            .first()
        )
        if not ok:
            raise HTTPException(status_code=400, detail="colaborador_id inválido para esta empresa")

    # atualiza somente clientes da empresa
    q = db.query(models.Cliente).filter(
        models.Cliente.empresa_id == empresa_id,
        models.Cliente.id.in_(payload.ids),
    )

    updated = 0
    for c in q:
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
):
    """
    Troca o colaborador de um único cliente (útil para ações individuais).
    """
    cli = (
        db.query(models.Cliente)
        .filter(models.Cliente.id == cliente_id, models.Cliente.empresa_id == empresa_id)
        .first()
    )
    if not cli:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

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


# ============================================================
# ============ Atribuição de Departamento (BULK) ============
# ============================================================
@router.post("/bulk/departamento")
def trocar_departamento_em_massa(
    payload: BulkDepartamentoIn,
    empresa_id: int = Depends(get_empresa_autorizada),
    db: Session = Depends(get_db),
):
    """
    Define (ou remove) o departamento de vários clientes.
    - departamento_id = null → remove departamento (limpa `departamento_id` e `departamento` texto)
    - Se o departamento existir na empresa, também atualiza o nome em `clientes.departamento`.
    """
    if not payload.ids:
        raise HTTPException(status_code=400, detail="Lista de IDs vazia.")

    dep_nome: Optional[str] = None
    dep_id = payload.departamento_id

    if dep_id is not None:
        # valida/obtém o nome do departamento (se houver tabela de departamentos)
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

    updated = 0
    for c in q:
        c.departamento_id = dep_id
        # também mantém a coluna textual coerente (se houver nome)
        c.departamento = dep_nome if dep_id is not None else None
        db.add(c)
        updated += 1

    db.commit()
    cache_delete_prefix(cache_k("clientes", "list", str(empresa_id)))

    return {"ok": True, "updated": updated, "departamento_nome": dep_nome}

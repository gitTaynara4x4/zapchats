from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from backend import models


# =========================================================
# Helpers base
# =========================================================
def _to_int(v: Any) -> Optional[int]:
    try:
        if v is None:
            return None
        return int(v)
    except Exception:
        return None


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _safe_rollback(db: Session) -> None:
    try:
        db.rollback()
    except Exception:
        pass


def _table_exists(db: Session, table_name: str) -> bool:
    try:
        reg = db.execute(text(f"SELECT to_regclass('public.{table_name}')")).scalar()
        return reg is not None
    except Exception:
        return False


def _get_atendimento_model():
    return getattr(models, "Atendimento", None)


def _get_participante_model():
    return getattr(models, "AtendimentoParticipante", None)


def has_atendimento_participante_model() -> bool:
    return _get_participante_model() is not None


def participacao_feature_enabled(db: Session) -> bool:
    return has_atendimento_participante_model() and _table_exists(db, "atendimento_participantes")


def _status_value_open() -> Any:
    enum_cls = getattr(models, "StatusAtendimento", None)
    if enum_cls is not None and hasattr(enum_cls, "EM_ATENDIMENTO"):
        try:
            return enum_cls.EM_ATENDIMENTO
        except Exception:
            pass
    return "em_atendimento"


def _status_value_waiting(has_departamento: bool) -> Any:
    enum_cls = getattr(models, "StatusAtendimento", None)

    if has_departamento:
        if enum_cls is not None and hasattr(enum_cls, "AGUARDANDO"):
            try:
                return enum_cls.AGUARDANDO
            except Exception:
                pass
        return "aguardando"

    if enum_cls is not None and hasattr(enum_cls, "NOVO"):
        try:
            return enum_cls.NOVO
        except Exception:
            pass
    return "novo"


def _status_to_str(v: Any) -> Optional[str]:
    if v is None:
        return None
    if hasattr(v, "value"):
        return str(v.value)
    return str(v)


def _touch_atendimento(atendimento: Any, ts_dt: Optional[datetime] = None) -> None:
    ts = ts_dt or _now_utc()

    if hasattr(atendimento, "atualizado_em"):
        try:
            atendimento.atualizado_em = ts
        except Exception:
            pass

    if hasattr(atendimento, "updated_at"):
        try:
            atendimento.updated_at = ts
        except Exception:
            pass


def _set_atendimento_status(atendimento: Any, value: Any) -> None:
    if hasattr(atendimento, "status"):
        try:
            atendimento.status = value
        except Exception:
            pass


def _set_atendimento_operador(atendimento: Any, colaborador_id: Optional[int]) -> None:
    if hasattr(atendimento, "operador_id"):
        try:
            atendimento.operador_id = int(colaborador_id) if colaborador_id is not None else None
        except Exception:
            atendimento.operador_id = None


# =========================================================
# Query helpers
# =========================================================
def _query_participantes_base(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
):
    AP = _get_participante_model()
    if AP is None:
        return None

    return db.query(AP).filter(
        AP.empresa_id == int(empresa_id),
        AP.atendimento_id == int(atendimento_id),
    )


def listar_participantes_ativos(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
):
    AP = _get_participante_model()
    if AP is None or not participacao_feature_enabled(db):
        return []

    q = _query_participantes_base(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )
    if q is None:
        return []

    if hasattr(AP, "is_ativo"):
        q = q.filter(AP.is_ativo.is_(True))
    elif hasattr(AP, "saiu_em"):
        q = q.filter(AP.saiu_em.is_(None))

    try:
        if hasattr(AP, "is_responsavel"):
            q = q.order_by(AP.is_responsavel.desc())
        if hasattr(AP, "entrou_em"):
            q = q.order_by(AP.entrou_em.asc())
        if hasattr(AP, "id"):
            q = q.order_by(AP.id.asc())
        return q.all()
    except Exception:
        _safe_rollback(db)
        return []


def listar_participantes_ativos_ids(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
) -> List[int]:
    rows = listar_participantes_ativos(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )
    out: List[int] = []
    for row in rows:
        cid = _to_int(getattr(row, "colaborador_id", None))
        if cid is not None and cid not in out:
            out.append(cid)
    return out


def obter_participante_ativo(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
    colaborador_id: int,
):
    AP = _get_participante_model()
    if AP is None or not participacao_feature_enabled(db):
        return None

    q = _query_participantes_base(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )
    if q is None:
        return None

    q = q.filter(AP.colaborador_id == int(colaborador_id))

    if hasattr(AP, "is_ativo"):
        q = q.filter(AP.is_ativo.is_(True))
    elif hasattr(AP, "saiu_em"):
        q = q.filter(AP.saiu_em.is_(None))

    try:
        if hasattr(AP, "id"):
            return q.order_by(AP.id.desc()).first()
        return q.first()
    except Exception:
        _safe_rollback(db)
        return None


def obter_responsavel_ativo(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
):
    AP = _get_participante_model()
    if AP is None or not participacao_feature_enabled(db):
        return None

    q = _query_participantes_base(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )
    if q is None:
        return None

    if hasattr(AP, "is_ativo"):
        q = q.filter(AP.is_ativo.is_(True))
    elif hasattr(AP, "saiu_em"):
        q = q.filter(AP.saiu_em.is_(None))

    if hasattr(AP, "is_responsavel"):
        q = q.filter(AP.is_responsavel.is_(True))

    try:
        if hasattr(AP, "id"):
            return q.order_by(AP.id.desc()).first()
        return q.first()
    except Exception:
        _safe_rollback(db)
        return None


def _find_participante_any_state(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
    colaborador_id: int,
):
    AP = _get_participante_model()
    if AP is None or not participacao_feature_enabled(db):
        return None

    q = _query_participantes_base(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )
    if q is None:
        return None

    q = q.filter(AP.colaborador_id == int(colaborador_id))

    try:
        if hasattr(AP, "id"):
            return q.order_by(AP.id.desc()).first()
        return q.first()
    except Exception:
        _safe_rollback(db)
        return None


# =========================================================
# Bootstrap legado
# =========================================================
def bootstrap_operador_legado_como_participante(
    db: Session,
    *,
    atendimento: Any,
):
    """
    Se existe operador_id no atendimento legado e ainda não existe
    participante ativo, cria/reativa ele como participante responsável.
    """
    if atendimento is None or not participacao_feature_enabled(db):
        return None

    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
    operador_id = _to_int(getattr(atendimento, "operador_id", None))

    if atendimento_id is None or empresa_id is None or operador_id is None:
        return None

    ativos = listar_participantes_ativos_ids(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )
    if ativos:
        return None

    return adicionar_ou_reativar_participante(
        db,
        atendimento=atendimento,
        colaborador_id=int(operador_id),
        tornar_responsavel=True,
    )


# =========================================================
# Escrita / manutenção
# =========================================================
def adicionar_ou_reativar_participante(
    db: Session,
    *,
    atendimento: Any,
    colaborador_id: int,
    tornar_responsavel: bool = False,
    aceito_em: Optional[datetime] = None,
):
    AP = _get_participante_model()

    if atendimento is None:
        return None

    colaborador_id_i = _to_int(colaborador_id)
    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))

    if colaborador_id_i is None or atendimento_id is None or empresa_id is None:
        return None

    if not participacao_feature_enabled(db) or AP is None:
        # fallback legado
        if tornar_responsavel:
            _set_atendimento_operador(atendimento, int(colaborador_id_i))
        elif getattr(atendimento, "operador_id", None) is None:
            _set_atendimento_operador(atendimento, int(colaborador_id_i))
        _touch_atendimento(atendimento, aceito_em)
        db.add(atendimento)
        db.flush()
        return None

    ts = aceito_em or _now_utc()

    if tornar_responsavel and hasattr(AP, "is_responsavel"):
        outros = listar_participantes_ativos(
            db,
            empresa_id=int(empresa_id),
            atendimento_id=int(atendimento_id),
        )
        for other in outros:
            if _to_int(getattr(other, "colaborador_id", None)) != int(colaborador_id_i):
                other.is_responsavel = False
                db.add(other)

    row = _find_participante_any_state(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
        colaborador_id=int(colaborador_id_i),
    )

    if row is None:
        data = {
            "empresa_id": int(empresa_id),
            "atendimento_id": int(atendimento_id),
            "colaborador_id": int(colaborador_id_i),
        }

        if hasattr(AP, "aceito_em"):
            data["aceito_em"] = ts
        if hasattr(AP, "entrou_em"):
            data["entrou_em"] = ts
        if hasattr(AP, "is_ativo"):
            data["is_ativo"] = True
        if hasattr(AP, "saiu_em"):
            data["saiu_em"] = None
        if hasattr(AP, "is_responsavel"):
            data["is_responsavel"] = bool(tornar_responsavel)

        row = AP(**data)
        db.add(row)
        db.flush()
    else:
        if hasattr(row, "is_ativo"):
            row.is_ativo = True
        if hasattr(row, "saiu_em"):
            row.saiu_em = None
        if hasattr(row, "aceito_em") and getattr(row, "aceito_em", None) is None:
            row.aceito_em = ts
        if hasattr(row, "entrou_em") and getattr(row, "entrou_em", None) is None:
            row.entrou_em = ts
        if hasattr(row, "is_responsavel"):
            if tornar_responsavel:
                row.is_responsavel = True
            elif getattr(row, "is_responsavel", None) is None:
                row.is_responsavel = False
        db.add(row)
        db.flush()

    if tornar_responsavel:
        _set_atendimento_operador(atendimento, int(colaborador_id_i))
    elif getattr(atendimento, "operador_id", None) is None:
        _set_atendimento_operador(atendimento, int(colaborador_id_i))

    _touch_atendimento(atendimento, ts)
    db.add(atendimento)
    db.flush()
    return row


def promover_responsavel(
    db: Session,
    *,
    atendimento: Any,
    colaborador_id: int,
):
    AP = _get_participante_model()

    if atendimento is None:
        return None

    colaborador_id_i = _to_int(colaborador_id)
    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))

    if colaborador_id_i is None or atendimento_id is None or empresa_id is None:
        return None

    if not participacao_feature_enabled(db) or AP is None:
        _set_atendimento_operador(atendimento, int(colaborador_id_i))
        _touch_atendimento(atendimento)
        db.add(atendimento)
        db.flush()
        return None

    ativos = listar_participantes_ativos(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )

    found = None
    for row in ativos:
        cid = _to_int(getattr(row, "colaborador_id", None))
        if hasattr(row, "is_responsavel"):
            row.is_responsavel = (cid == int(colaborador_id_i))
        if cid == int(colaborador_id_i):
            found = row
        db.add(row)

    if found is None:
        found = adicionar_ou_reativar_participante(
            db,
            atendimento=atendimento,
            colaborador_id=int(colaborador_id_i),
            tornar_responsavel=True,
        )
    else:
        _set_atendimento_operador(atendimento, int(colaborador_id_i))
        _touch_atendimento(atendimento)
        db.add(atendimento)
        db.flush()

    return found


def sincronizar_operador_legado_com_responsavel(
    db: Session,
    *,
    atendimento: Any,
):
    """
    Mantém operador_id coerente com o responsável atual.
    Se não houver responsável, usa o primeiro participante ativo.
    """
    if atendimento is None:
        return

    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
    if atendimento_id is None or empresa_id is None:
        return

    if not participacao_feature_enabled(db):
        return

    bootstrap_operador_legado_como_participante(db, atendimento=atendimento)

    responsavel = obter_responsavel_ativo(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )
    if responsavel is not None:
        _set_atendimento_operador(atendimento, _to_int(getattr(responsavel, "colaborador_id", None)))
        db.add(atendimento)
        db.flush()
        return

    ativos = listar_participantes_ativos(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )
    if ativos:
        primeiro = ativos[0]
        if hasattr(primeiro, "is_responsavel"):
            primeiro.is_responsavel = True
            db.add(primeiro)
        _set_atendimento_operador(atendimento, _to_int(getattr(primeiro, "colaborador_id", None)))
    else:
        _set_atendimento_operador(atendimento, None)

    db.add(atendimento)
    db.flush()


# =========================================================
# Fluxos principais
# =========================================================
def aceitar_atendimento(
    db: Session,
    *,
    atendimento: Any,
    colaborador_id: int,
    ts_dt: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Regra nova:
    - mais de um colaborador pode aceitar a mesma conversa
    - continua existindo 1 responsável principal
    - operador_id fica espelhando o responsável, por compatibilidade
    """
    if atendimento is None:
        raise ValueError("Atendimento inválido")

    colaborador_id_i = _to_int(colaborador_id)
    if colaborador_id_i is None:
        raise ValueError("colaborador_id inválido")

    ts = ts_dt or _now_utc()
    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
    departamento_id = _to_int(getattr(atendimento, "departamento_id", None))

    if atendimento_id is None or empresa_id is None:
        raise ValueError("Atendimento sem id/empresa_id")

    already_active = False
    became_responsavel = False

    if not participacao_feature_enabled(db):
        current = _to_int(getattr(atendimento, "operador_id", None))
        already_active = current == int(colaborador_id_i)

        if current is None:
            _set_atendimento_operador(atendimento, int(colaborador_id_i))
            became_responsavel = True

        _set_atendimento_status(atendimento, _status_value_open())
        _touch_atendimento(atendimento, ts)
        db.add(atendimento)
        db.flush()

        return {
            "atendimento_id": int(atendimento_id),
            "already_active": already_active,
            "became_responsavel": became_responsavel,
            "responsavel_id": _to_int(getattr(atendimento, "operador_id", None)),
            "participantes_ids": [_to_int(getattr(atendimento, "operador_id", None))] if getattr(atendimento, "operador_id", None) is not None else [],
            "status": _status_to_str(getattr(atendimento, "status", None)),
            "departamento_id": departamento_id,
        }

    bootstrap_operador_legado_como_participante(db, atendimento=atendimento)

    row = obter_participante_ativo(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
        colaborador_id=int(colaborador_id_i),
    )
    already_active = row is not None

    responsavel = obter_responsavel_ativo(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )

    if row is None:
        row = adicionar_ou_reativar_participante(
            db,
            atendimento=atendimento,
            colaborador_id=int(colaborador_id_i),
            tornar_responsavel=(responsavel is None),
            aceito_em=ts,
        )
        became_responsavel = responsavel is None
    elif responsavel is None:
        promover_responsavel(
            db,
            atendimento=atendimento,
            colaborador_id=int(colaborador_id_i),
        )
        became_responsavel = True

    sincronizar_operador_legado_com_responsavel(db, atendimento=atendimento)
    _set_atendimento_status(atendimento, _status_value_open())
    _touch_atendimento(atendimento, ts)
    db.add(atendimento)
    db.flush()

    responsavel = obter_responsavel_ativo(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )

    return {
        "atendimento_id": int(atendimento_id),
        "already_active": already_active,
        "became_responsavel": became_responsavel,
        "responsavel_id": _to_int(getattr(responsavel, "colaborador_id", None)) if responsavel is not None else _to_int(getattr(atendimento, "operador_id", None)),
        "participantes_ids": listar_participantes_ativos_ids(
            db,
            empresa_id=int(empresa_id),
            atendimento_id=int(atendimento_id),
        ),
        "status": _status_to_str(getattr(atendimento, "status", None)),
        "departamento_id": departamento_id,
    }


def liberar_participacao(
    db: Session,
    *,
    atendimento: Any,
    colaborador_id: int,
    ts_dt: Optional[datetime] = None,
    force: bool = False,
) -> Dict[str, Any]:
    """
    Sai da conversa, mas mantém o log.
    Se quem sair for o responsável, o sistema promove outro ativo.
    """
    if atendimento is None:
        raise ValueError("Atendimento inválido")

    colaborador_id_i = _to_int(colaborador_id)
    if colaborador_id_i is None:
        raise ValueError("colaborador_id inválido")

    ts = ts_dt or _now_utc()
    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
    departamento_id = _to_int(getattr(atendimento, "departamento_id", None))

    if atendimento_id is None or empresa_id is None:
        raise ValueError("Atendimento sem id/empresa_id")

    if not participacao_feature_enabled(db):
        operador_atual = _to_int(getattr(atendimento, "operador_id", None))
        if operador_atual is not None and operador_atual != int(colaborador_id_i) and not force:
            raise PermissionError("Somente o responsável atual pode liberar a conversa")

        _set_atendimento_operador(atendimento, None)
        _set_atendimento_status(atendimento, _status_value_waiting(departamento_id is not None))
        _touch_atendimento(atendimento, ts)
        db.add(atendimento)
        db.flush()

        return {
            "atendimento_id": int(atendimento_id),
            "responsavel_id": None,
            "participantes_ids": [],
            "status": _status_to_str(getattr(atendimento, "status", None)),
            "departamento_id": departamento_id,
        }

    bootstrap_operador_legado_como_participante(db, atendimento=atendimento)

    row = _find_participante_any_state(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
        colaborador_id=int(colaborador_id_i),
    )

    if row is None and not force:
        raise PermissionError("Esse colaborador não participa da conversa")

    if row is not None:
        era_responsavel = bool(getattr(row, "is_responsavel", False))

        if hasattr(row, "is_ativo"):
            row.is_ativo = False
        if hasattr(row, "saiu_em"):
            row.saiu_em = ts
        if hasattr(row, "is_responsavel"):
            row.is_responsavel = False

        db.add(row)
        db.flush()

        ativos = listar_participantes_ativos(
            db,
            empresa_id=int(empresa_id),
            atendimento_id=int(atendimento_id),
        )

        if ativos:
            novo_responsavel = None
            for p in ativos:
                if bool(getattr(p, "is_responsavel", False)):
                    novo_responsavel = p
                    break

            if novo_responsavel is None and era_responsavel:
                novo_responsavel = ativos[0]
                if hasattr(novo_responsavel, "is_responsavel"):
                    novo_responsavel.is_responsavel = True
                    db.add(novo_responsavel)
                    db.flush()

            if novo_responsavel is None:
                novo_responsavel = ativos[0]

            _set_atendimento_operador(atendimento, _to_int(getattr(novo_responsavel, "colaborador_id", None)))
            _set_atendimento_status(atendimento, _status_value_open())
        else:
            _set_atendimento_operador(atendimento, None)
            _set_atendimento_status(atendimento, _status_value_waiting(departamento_id is not None))

    _touch_atendimento(atendimento, ts)
    db.add(atendimento)
    db.flush()

    responsavel = obter_responsavel_ativo(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )

    return {
        "atendimento_id": int(atendimento_id),
        "responsavel_id": _to_int(getattr(responsavel, "colaborador_id", None)) if responsavel is not None else None,
        "participantes_ids": listar_participantes_ativos_ids(
            db,
            empresa_id=int(empresa_id),
            atendimento_id=int(atendimento_id),
        ),
        "status": _status_to_str(getattr(atendimento, "status", None)),
        "departamento_id": departamento_id,
    }


def transferir_responsavel(
    db: Session,
    *,
    atendimento: Any,
    colaborador_id_destino: int,
    ts_dt: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Torna o colaborador destino o novo responsável.
    Se ele ainda não participa, entra como participante ativo.
    """
    if atendimento is None:
        raise ValueError("Atendimento inválido")

    colaborador_id_i = _to_int(colaborador_id_destino)
    if colaborador_id_i is None:
        raise ValueError("colaborador_id_destino inválido")

    ts = ts_dt or _now_utc()
    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
    departamento_id = _to_int(getattr(atendimento, "departamento_id", None))

    if atendimento_id is None or empresa_id is None:
        raise ValueError("Atendimento sem id/empresa_id")

    if not participacao_feature_enabled(db):
        _set_atendimento_operador(atendimento, int(colaborador_id_i))
        _set_atendimento_status(atendimento, _status_value_open())
        _touch_atendimento(atendimento, ts)
        db.add(atendimento)
        db.flush()

        return {
            "atendimento_id": int(atendimento_id),
            "responsavel_id": int(colaborador_id_i),
            "participantes_ids": [int(colaborador_id_i)],
            "status": _status_to_str(getattr(atendimento, "status", None)),
            "departamento_id": departamento_id,
        }

    bootstrap_operador_legado_como_participante(db, atendimento=atendimento)

    adicionar_ou_reativar_participante(
        db,
        atendimento=atendimento,
        colaborador_id=int(colaborador_id_i),
        tornar_responsavel=True,
        aceito_em=ts,
    )

    sincronizar_operador_legado_com_responsavel(db, atendimento=atendimento)
    _set_atendimento_status(atendimento, _status_value_open())
    _touch_atendimento(atendimento, ts)
    db.add(atendimento)
    db.flush()

    responsavel = obter_responsavel_ativo(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )

    return {
        "atendimento_id": int(atendimento_id),
        "responsavel_id": _to_int(getattr(responsavel, "colaborador_id", None)) if responsavel is not None else int(colaborador_id_i),
        "participantes_ids": listar_participantes_ativos_ids(
            db,
            empresa_id=int(empresa_id),
            atendimento_id=int(atendimento_id),
        ),
        "status": _status_to_str(getattr(atendimento, "status", None)),
        "departamento_id": departamento_id,
    }


# =========================================================
# Regras de permissão operacional
# =========================================================
def colaborador_esta_ativo_no_atendimento(
    db: Session,
    *,
    atendimento: Any,
    colaborador_id: int,
) -> bool:
    if atendimento is None:
        return False

    colaborador_id_i = _to_int(colaborador_id)
    if colaborador_id_i is None:
        return False

    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
    if atendimento_id is None or empresa_id is None:
        return False

    if not participacao_feature_enabled(db):
        operador_id = _to_int(getattr(atendimento, "operador_id", None))
        return operador_id is not None and operador_id == int(colaborador_id_i)

    bootstrap_operador_legado_como_participante(db, atendimento=atendimento)
    row = obter_participante_ativo(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
        colaborador_id=int(colaborador_id_i),
    )
    return row is not None


def colaborador_pode_interagir_no_atendimento(
    db: Session,
    *,
    atendimento: Any,
    colaborador_id: int,
    permitir_sem_participantes: bool = False,
) -> bool:
    """
    Use no envio:
    - False => precisa aceitar antes
    - True  => se ainda ninguém aceitou, deixa o primeiro enviar
    """
    if atendimento is None:
        return False

    colaborador_id_i = _to_int(colaborador_id)
    if colaborador_id_i is None:
        return False

    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
    if atendimento_id is None or empresa_id is None:
        return False

    if not participacao_feature_enabled(db):
        operador_id = _to_int(getattr(atendimento, "operador_id", None))
        if operador_id is None:
            return bool(permitir_sem_participantes)
        return operador_id == int(colaborador_id_i)

    bootstrap_operador_legado_como_participante(db, atendimento=atendimento)

    ativos = listar_participantes_ativos_ids(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )
    if not ativos:
        return bool(permitir_sem_participantes)

    return int(colaborador_id_i) in set(int(x) for x in ativos)


def listar_participantes_payload(
    db: Session,
    *,
    atendimento: Any,
) -> List[Dict[str, Any]]:
    """
    Payload pronto para rota/meta do front.
    """
    if atendimento is None:
        return []

    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
    if atendimento_id is None or empresa_id is None:
        return []

    if not participacao_feature_enabled(db):
        operador_id = _to_int(getattr(atendimento, "operador_id", None))
        if operador_id is None:
            return []

        colab = db.query(models.Colaborador).filter(
            models.Colaborador.empresa_id == int(empresa_id),
            models.Colaborador.id == int(operador_id),
        ).first()

        return [{
            "colaborador_id": int(operador_id),
            "nome": getattr(colab, "nome", None),
            "email": getattr(colab, "email", None),
            "is_responsavel": True,
            "is_ativo": True,
        }]

    bootstrap_operador_legado_como_participante(db, atendimento=atendimento)

    rows = listar_participantes_ativos(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )
    if not rows:
        return []

    ids = [
        int(getattr(r, "colaborador_id"))
        for r in rows
        if getattr(r, "colaborador_id", None) is not None
    ]

    colaboradores = db.query(models.Colaborador).filter(
        models.Colaborador.empresa_id == int(empresa_id),
        models.Colaborador.id.in_(ids),
    ).all()

    by_id = {int(c.id): c for c in colaboradores}

    out: List[Dict[str, Any]] = []
    for row in rows:
        cid = _to_int(getattr(row, "colaborador_id", None))
        if cid is None:
            continue
        c = by_id.get(int(cid))
        out.append({
            "colaborador_id": int(cid),
            "nome": getattr(c, "nome", None),
            "email": getattr(c, "email", None),
            "cargo": getattr(c, "cargo", None),
            "is_responsavel": bool(getattr(row, "is_responsavel", False)),
            "is_ativo": bool(getattr(row, "is_ativo", True)) if hasattr(row, "is_ativo") else True,
            "aceito_em": getattr(row, "aceito_em", None).isoformat() if getattr(row, "aceito_em", None) else None,
            "entrou_em": getattr(row, "entrou_em", None).isoformat() if getattr(row, "entrou_em", None) else None,
        })

    return out


__all__ = [
    "has_atendimento_participante_model",
    "participacao_feature_enabled",
    "listar_participantes_ativos",
    "listar_participantes_ativos_ids",
    "listar_participantes_payload",
    "obter_participante_ativo",
    "obter_responsavel_ativo",
    "bootstrap_operador_legado_como_participante",
    "adicionar_ou_reativar_participante",
    "promover_responsavel",
    "sincronizar_operador_legado_com_responsavel",
    "aceitar_atendimento",
    "liberar_participacao",
    "transferir_responsavel",
    "colaborador_esta_ativo_no_atendimento",
    "colaborador_pode_interagir_no_atendimento",
]
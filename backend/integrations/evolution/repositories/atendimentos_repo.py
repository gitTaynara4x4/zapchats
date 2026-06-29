# backend/integrations/evolution/repositories/atendimentos_repo.py

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, List, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from backend import models


def has_mensagem_atendimento_field() -> bool:
    return hasattr(models.Mensagem, "atendimento_id")


def _get_atendimento_model():
    return getattr(models, "Atendimento", None)


def _get_participante_model():
    return getattr(models, "AtendimentoParticipante", None)


def has_atendimento_participante_model() -> bool:
    return _get_participante_model() is not None


def _safe_rollback(db: Session) -> None:
    try:
        db.rollback()
    except Exception:
        pass


def _to_int(v) -> int | None:
    try:
        if v is None:
            return None

        s = str(v).strip()
        if not s:
            return None

        return int(s)
    except Exception:
        return None


def _now_utc():
    return datetime.now(timezone.utc)


def _table_exists(db: Session, table_name: str) -> bool:
    try:
        name = str(table_name or "").strip()
        if not name.replace("_", "").isalnum():
            return False

        reg = db.execute(
            text("SELECT to_regclass(:table_name)"),
            {"table_name": f"public.{name}"},
        ).scalar()

        return reg is not None
    except Exception:
        return False


def _participant_feature_enabled(db: Session) -> bool:
    return has_atendimento_participante_model() and _table_exists(db, "atendimento_participantes")


def _cliente_exists_for_empresa(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int | None,
) -> bool:
    cid = _to_int(cliente_id)
    if cid is None:
        return False

    try:
        row = db.execute(
            text(
                """
                SELECT 1
                  FROM clientes
                 WHERE id = :cliente_id
                   AND empresa_id = :empresa_id
                 LIMIT 1
                """
            ),
            {
                "cliente_id": int(cid),
                "empresa_id": int(empresa_id),
            },
        ).first()

        return bool(row)

    except Exception:
        _safe_rollback(db)
        return False


def _instancia_exists_for_empresa(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
) -> bool:
    iid = _to_int(instancia_id)
    if iid is None:
        return False

    try:
        row = db.execute(
            text(
                """
                SELECT 1
                  FROM empresa_instancias
                 WHERE id = :instancia_id
                   AND empresa_id = :empresa_id
                 LIMIT 1
                """
            ),
            {
                "instancia_id": int(iid),
                "empresa_id": int(empresa_id),
            },
        ).first()

        return bool(row)

    except Exception:
        # compat caso a tabela no seu banco esteja com outro nome/modelo;
        # não bloqueia atendimento por falha de introspecção.
        try:
            row = (
                db.query(models.EmpresaInstancia.id)
                .filter(
                    models.EmpresaInstancia.id == int(iid),
                    models.EmpresaInstancia.empresa_id == int(empresa_id),
                )
                .first()
            )
            return bool(row and row[0] is not None)
        except Exception:
            _safe_rollback(db)
            return False


def _atendimento_context_ok(
    atendimento,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
) -> bool:
    if atendimento is None:
        return False

    if hasattr(atendimento, "empresa_id"):
        emp = _to_int(getattr(atendimento, "empresa_id", None))
        if emp is not None and emp != int(empresa_id):
            return False

    if hasattr(atendimento, "cliente_id"):
        cid = _to_int(getattr(atendimento, "cliente_id", None))
        if cid is not None and cid != int(cliente_id):
            return False

    if hasattr(atendimento, "instancia_id"):
        iid = _to_int(getattr(atendimento, "instancia_id", None))
        if iid is not None and iid != int(instancia_id):
            return False

    return True


def _status_abertos() -> list[object]:
    status_enum = getattr(models, "StatusAtendimento", None)
    vals: list[object] = []

    if status_enum is not None:
        for attr in ("NOVO", "AGUARDANDO", "EM_ATENDIMENTO", "PAUSADO"):
            if hasattr(status_enum, attr):
                try:
                    vals.append(getattr(status_enum, attr))
                except Exception:
                    pass

    vals.extend(["novo", "aguardando", "em_atendimento", "pausado", "aberto", "pendente"])

    out = []
    seen = set()

    for v in vals:
        key = str(v)
        if key in seen:
            continue

        seen.add(key)
        out.append(v)

    return out


def _set_status_inicial(novo) -> None:
    if not hasattr(novo, "status"):
        return

    status_enum = getattr(models, "StatusAtendimento", None)
    if status_enum is not None and hasattr(status_enum, "NOVO"):
        try:
            novo.status = status_enum.NOVO
            return
        except Exception:
            pass

    try:
        novo.status = "novo"
    except Exception:
        pass


def _set_status_aguardando(atendimento) -> None:
    """Coloca o atendimento na fila compartilhada do departamento."""
    if not hasattr(atendimento, "status"):
        return

    status_enum = getattr(models, "StatusAtendimento", None)
    if status_enum is not None and hasattr(status_enum, "AGUARDANDO"):
        try:
            atendimento.status = status_enum.AGUARDANDO
            return
        except Exception:
            pass

    try:
        atendimento.status = "aguardando"
    except Exception:
        pass


def _set_status_novo(atendimento) -> None:
    """Volta o atendimento para novo quando ainda não existe departamento escolhido."""
    if not hasattr(atendimento, "status"):
        return

    status_enum = getattr(models, "StatusAtendimento", None)
    if status_enum is not None and hasattr(status_enum, "NOVO"):
        try:
            atendimento.status = status_enum.NOVO
            return
        except Exception:
            pass

    try:
        atendimento.status = "novo"
    except Exception:
        pass


def _clear_active_participantes_for_triage(db: Session, *, atendimento) -> None:
    """
    Quando o robô só direciona para um departamento, ninguém assumiu ainda.
    Então participantes antigos precisam ficar inativos para a conversa voltar para
    a fila compartilhada do departamento.
    """
    AP = _get_participante_model()
    if AP is None or not _participant_feature_enabled(db):
        return

    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
    if atendimento_id is None or empresa_id is None:
        return

    try:
        rows = _list_active_participantes(
            db,
            empresa_id=int(empresa_id),
            atendimento_id=int(atendimento_id),
        )
        if not rows:
            return

        now = _now_utc()
        for row in rows:
            if hasattr(row, "is_ativo"):
                row.is_ativo = False
            if hasattr(row, "saiu_em"):
                row.saiu_em = now
            if hasattr(row, "atualizado_em"):
                row.atualizado_em = now
            if hasattr(row, "updated_at"):
                row.updated_at = now
            db.add(row)
    except Exception:
        return


def _query_open_atendimento(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    departamento_id: int | None = None,
):
    Atendimento = _get_atendimento_model()
    if Atendimento is None:
        return None

    if not _cliente_exists_for_empresa(
        db,
        empresa_id=int(empresa_id),
        cliente_id=int(cliente_id),
    ):
        return None

    q = db.query(Atendimento)

    if hasattr(Atendimento, "empresa_id"):
        q = q.filter(Atendimento.empresa_id == int(empresa_id))

    if hasattr(Atendimento, "cliente_id"):
        q = q.filter(Atendimento.cliente_id == int(cliente_id))

    if hasattr(Atendimento, "instancia_id"):
        q = q.filter(Atendimento.instancia_id == int(instancia_id))

    if hasattr(Atendimento, "departamento_id"):
        if departamento_id is None:
            q = q.filter(Atendimento.departamento_id.is_(None))
        else:
            q = q.filter(Atendimento.departamento_id == int(departamento_id))

    if hasattr(Atendimento, "status"):
        try:
            q = q.filter(Atendimento.status.in_(_status_abertos()))
        except Exception:
            pass

    try:
        row = q.order_by(Atendimento.id.desc()).first() if hasattr(Atendimento, "id") else q.first()

        if not _atendimento_context_ok(
            row,
            empresa_id=int(empresa_id),
            instancia_id=int(instancia_id),
            cliente_id=int(cliente_id),
        ):
            return None

        return row

    except Exception:
        _safe_rollback(db)
        return None


def _query_latest_open_atendimento_any_department(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
):
    Atendimento = _get_atendimento_model()
    if Atendimento is None:
        return None

    if not _cliente_exists_for_empresa(
        db,
        empresa_id=int(empresa_id),
        cliente_id=int(cliente_id),
    ):
        return None

    q = db.query(Atendimento)

    if hasattr(Atendimento, "empresa_id"):
        q = q.filter(Atendimento.empresa_id == int(empresa_id))

    if hasattr(Atendimento, "cliente_id"):
        q = q.filter(Atendimento.cliente_id == int(cliente_id))

    if hasattr(Atendimento, "instancia_id"):
        q = q.filter(Atendimento.instancia_id == int(instancia_id))

    if hasattr(Atendimento, "status"):
        try:
            q = q.filter(Atendimento.status.in_(_status_abertos()))
        except Exception:
            pass

    try:
        row = q.order_by(Atendimento.id.desc()).first() if hasattr(Atendimento, "id") else q.first()

        if not _atendimento_context_ok(
            row,
            empresa_id=int(empresa_id),
            instancia_id=int(instancia_id),
            cliente_id=int(cliente_id),
        ):
            return None

        return row

    except Exception:
        _safe_rollback(db)
        return None


def _list_active_participantes(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
):
    AP = _get_participante_model()
    if AP is None or not _participant_feature_enabled(db):
        return []

    q = db.query(AP).filter(
        AP.empresa_id == int(empresa_id),
        AP.atendimento_id == int(atendimento_id),
    )

    if hasattr(AP, "is_ativo"):
        q = q.filter(AP.is_ativo.is_(True))
    elif hasattr(AP, "saiu_em"):
        q = q.filter(AP.saiu_em.is_(None))

    try:
        return q.order_by(AP.id.asc()).all() if hasattr(AP, "id") else q.all()
    except Exception:
        _safe_rollback(db)
        return []


def _list_active_participante_ids(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
) -> List[int]:
    rows = _list_active_participantes(
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


def _upsert_participante(
    db: Session,
    *,
    atendimento,
    colaborador_id: int,
    is_responsavel: Optional[bool] = None,
):
    AP = _get_participante_model()
    if AP is None or not _participant_feature_enabled(db):
        return None

    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))

    if atendimento_id is None or empresa_id is None:
        return None

    q = db.query(AP).filter(
        AP.empresa_id == int(empresa_id),
        AP.atendimento_id == int(atendimento_id),
        AP.colaborador_id == int(colaborador_id),
    )

    try:
        row = q.order_by(AP.id.desc()).first() if hasattr(AP, "id") else q.first()
    except Exception:
        _safe_rollback(db)
        return None

    now = _now_utc()

    if row is None:
        data = {
            "empresa_id": int(empresa_id),
            "atendimento_id": int(atendimento_id),
            "colaborador_id": int(colaborador_id),
        }

        if hasattr(AP, "aceito_em"):
            data["aceito_em"] = now
        if hasattr(AP, "entrou_em"):
            data["entrou_em"] = now
        if hasattr(AP, "is_ativo"):
            data["is_ativo"] = True
        if hasattr(AP, "saiu_em"):
            data["saiu_em"] = None
        if hasattr(AP, "is_responsavel"):
            data["is_responsavel"] = bool(is_responsavel) if is_responsavel is not None else False

        row = AP(**data)
        db.add(row)
        db.flush()
        return row

    if hasattr(row, "is_ativo"):
        row.is_ativo = True
    if hasattr(row, "saiu_em"):
        row.saiu_em = None
    if hasattr(row, "aceito_em") and getattr(row, "aceito_em", None) is None:
        row.aceito_em = now
    if hasattr(row, "entrou_em") and getattr(row, "entrou_em", None) is None:
        row.entrou_em = now
    if hasattr(row, "is_responsavel") and is_responsavel is not None:
        row.is_responsavel = bool(is_responsavel)

    db.add(row)
    db.flush()
    return row


def _bootstrap_legacy_operador_as_participante(
    db: Session,
    *,
    atendimento,
) -> None:
    """
    Migração preguiçosa:
    se existe operador_id no atendimento legado e ainda não existe
    participante ativo, cria 1 participante ativo/responsável.
    """
    if atendimento is None or not _participant_feature_enabled(db):
        return

    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
    operador_id = _to_int(getattr(atendimento, "operador_id", None))

    if atendimento_id is None or empresa_id is None or operador_id is None:
        return

    active_ids = _list_active_participante_ids(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )
    if active_ids:
        return

    _upsert_participante(
        db,
        atendimento=atendimento,
        colaborador_id=int(operador_id),
        is_responsavel=True,
    )


def ensure_participante_ativo_repo(
    db: Session,
    *,
    atendimento,
    colaborador_id: int | None,
    preferir_responsavel_se_vazio: bool = True,
):
    """
    Garante que o colaborador fique como participante ativo do atendimento.
    Não remove ninguém; só adiciona/reativa.
    """
    if atendimento is None:
        return None

    colaborador_id_i = _to_int(colaborador_id)
    if colaborador_id_i is None:
        return None

    if not _participant_feature_enabled(db):
        if hasattr(atendimento, "operador_id") and getattr(atendimento, "operador_id", None) is None:
            atendimento.operador_id = int(colaborador_id_i)
            db.add(atendimento)
            db.flush()
        return None

    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))

    if atendimento_id is None or empresa_id is None:
        return None

    _bootstrap_legacy_operador_as_participante(db, atendimento=atendimento)

    active_ids = _list_active_participante_ids(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )

    is_responsavel = bool(preferir_responsavel_se_vazio and not active_ids)

    row = _upsert_participante(
        db,
        atendimento=atendimento,
        colaborador_id=int(colaborador_id_i),
        is_responsavel=is_responsavel,
    )

    if hasattr(atendimento, "operador_id") and getattr(atendimento, "operador_id", None) is None:
        atendimento.operador_id = int(colaborador_id_i)
        db.add(atendimento)
        db.flush()

    return row


def get_or_open_atendimento_repo(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    direcao: str,
    ts_dt,
    departamento_id: int | None = None,
    operador_id: int | None = None,
) -> Any | None:
    if not has_mensagem_atendimento_field():
        return None

    Atendimento = _get_atendimento_model()
    if Atendimento is None:
        return None

    empresa_id_i = int(empresa_id)
    instancia_id_i = int(instancia_id)
    cliente_id_i = int(cliente_id)
    departamento_id_i = _to_int(departamento_id)
    operador_id_i = _to_int(operador_id)

    if not _cliente_exists_for_empresa(
        db,
        empresa_id=empresa_id_i,
        cliente_id=cliente_id_i,
    ):
        return None

    # Se a instância não existir para a empresa, não abre atendimento.
    # Isso evita atendimento solto quando a instância foi apagada/recriada.
    if not _instancia_exists_for_empresa(
        db,
        empresa_id=empresa_id_i,
        instancia_id=instancia_id_i,
    ):
        return None

    try:
        if hasattr(db, "is_active") and not db.is_active:
            _safe_rollback(db)
    except Exception:
        _safe_rollback(db)

    atendimento = _query_open_atendimento(
        db,
        empresa_id=empresa_id_i,
        instancia_id=instancia_id_i,
        cliente_id=cliente_id_i,
        departamento_id=departamento_id_i,
    )

    if atendimento is not None:
        try:
            _bootstrap_legacy_operador_as_participante(db, atendimento=atendimento)

            if operador_id_i is not None:
                ensure_participante_ativo_repo(
                    db,
                    atendimento=atendimento,
                    colaborador_id=operador_id_i,
                    preferir_responsavel_se_vazio=True,
                )

            if _atendimento_context_ok(
                atendimento,
                empresa_id=empresa_id_i,
                instancia_id=instancia_id_i,
                cliente_id=cliente_id_i,
            ):
                return atendimento

            return None

        except Exception:
            _safe_rollback(db)
            return _query_open_atendimento(
                db,
                empresa_id=empresa_id_i,
                instancia_id=instancia_id_i,
                cliente_id=cliente_id_i,
                departamento_id=departamento_id_i,
            )

    try:
        novo = Atendimento()
    except Exception:
        return None

    try:
        if not _cliente_exists_for_empresa(
            db,
            empresa_id=empresa_id_i,
            cliente_id=cliente_id_i,
        ):
            return None

        if hasattr(novo, "empresa_id"):
            novo.empresa_id = empresa_id_i

        if hasattr(novo, "cliente_id"):
            novo.cliente_id = cliente_id_i

        if hasattr(novo, "instancia_id"):
            novo.instancia_id = instancia_id_i

        if hasattr(novo, "departamento_id"):
            novo.departamento_id = departamento_id_i

        _set_status_inicial(novo)

        if hasattr(novo, "tipo"):
            novo.tipo = direcao

        if hasattr(novo, "direcao"):
            novo.direcao = direcao

        if hasattr(novo, "operador_id") and operador_id_i is not None:
            novo.operador_id = operador_id_i

        if hasattr(novo, "criado_em") and ts_dt is not None:
            novo.criado_em = ts_dt

        if hasattr(novo, "created_at") and ts_dt is not None:
            novo.created_at = ts_dt

        if hasattr(novo, "atualizado_em") and ts_dt is not None:
            novo.atualizado_em = ts_dt

        if hasattr(novo, "updated_at") and ts_dt is not None:
            novo.updated_at = ts_dt

        db.add(novo)
        db.flush()

        if not _atendimento_context_ok(
            novo,
            empresa_id=empresa_id_i,
            instancia_id=instancia_id_i,
            cliente_id=cliente_id_i,
        ):
            return None

        if operador_id_i is not None:
            ensure_participante_ativo_repo(
                db,
                atendimento=novo,
                colaborador_id=operador_id_i,
                preferir_responsavel_se_vazio=True,
            )

        return novo

    except Exception:
        _safe_rollback(db)

        return _query_open_atendimento(
            db,
            empresa_id=empresa_id_i,
            instancia_id=instancia_id_i,
            cliente_id=cliente_id_i,
            departamento_id=departamento_id_i,
        )


def update_open_atendimento_departamento_repo(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    departamento_id: int | None,
    ts_dt=None,
    operador_id: int | None = None,
    status_aguardando: bool = False,
    clear_operador: bool = False,
    clear_participantes: bool = False,
) -> Any | None:
    """
    Atualiza o atendimento aberto mais recente da conversa para o departamento informado.
    Se não existir atendimento aberto, cria um já no departamento correto.

    Para triagem por departamento, use status_aguardando=True e clear_operador=True:
    o robô só escolhe o departamento, mas nenhum colaborador assume ainda.
    """
    if not has_mensagem_atendimento_field():
        return None

    Atendimento = _get_atendimento_model()
    if Atendimento is None:
        return None

    empresa_id_i = int(empresa_id)
    instancia_id_i = int(instancia_id)
    cliente_id_i = int(cliente_id)
    departamento_id_i = _to_int(departamento_id)
    operador_id_i = _to_int(operador_id)

    if not _cliente_exists_for_empresa(
        db,
        empresa_id=empresa_id_i,
        cliente_id=cliente_id_i,
    ):
        return None

    if not _instancia_exists_for_empresa(
        db,
        empresa_id=empresa_id_i,
        instancia_id=instancia_id_i,
    ):
        return None

    try:
        if hasattr(db, "is_active") and not db.is_active:
            _safe_rollback(db)
    except Exception:
        _safe_rollback(db)

    atendimento = _query_latest_open_atendimento_any_department(
        db,
        empresa_id=empresa_id_i,
        instancia_id=instancia_id_i,
        cliente_id=cliente_id_i,
    )

    if atendimento is None:
        atendimento = get_or_open_atendimento_repo(
            db,
            empresa_id=empresa_id_i,
            instancia_id=instancia_id_i,
            cliente_id=cliente_id_i,
            direcao="entrada",
            ts_dt=ts_dt,
            departamento_id=departamento_id_i,
            operador_id=None if clear_operador else operador_id_i,
        )

        if atendimento is not None:
            changed = False

            if hasattr(atendimento, "operador_id") and clear_operador:
                atendimento.operador_id = None
                changed = True

            if clear_participantes:
                _clear_active_participantes_for_triage(db, atendimento=atendimento)
                changed = True

            if status_aguardando and departamento_id_i is not None:
                _set_status_aguardando(atendimento)
                changed = True
            elif departamento_id_i is None and clear_operador:
                _set_status_novo(atendimento)
                changed = True

            if changed:
                db.add(atendimento)
                db.flush()

        return atendimento

    try:
        if not _atendimento_context_ok(
            atendimento,
            empresa_id=empresa_id_i,
            instancia_id=instancia_id_i,
            cliente_id=cliente_id_i,
        ):
            return None

        changed = False

        _bootstrap_legacy_operador_as_participante(db, atendimento=atendimento)

        if hasattr(atendimento, "departamento_id"):
            atual_dep = _to_int(getattr(atendimento, "departamento_id", None))
            if atual_dep != departamento_id_i:
                atendimento.departamento_id = departamento_id_i
                changed = True

        if hasattr(atendimento, "operador_id"):
            atual_operador = _to_int(getattr(atendimento, "operador_id", None))

            if clear_operador and atual_operador is not None:
                atendimento.operador_id = None
                changed = True
            elif (not clear_operador) and operador_id_i is not None and atual_operador is None:
                atendimento.operador_id = operador_id_i
                changed = True

        if clear_participantes:
            _clear_active_participantes_for_triage(db, atendimento=atendimento)
            changed = True

        if status_aguardando and departamento_id_i is not None:
            _set_status_aguardando(atendimento)
            changed = True
        elif departamento_id_i is None and clear_operador:
            _set_status_novo(atendimento)
            changed = True

        if ts_dt is not None:
            if hasattr(atendimento, "atualizado_em"):
                atendimento.atualizado_em = ts_dt
                changed = True
            elif hasattr(atendimento, "updated_at"):
                atendimento.updated_at = ts_dt
                changed = True

        if changed:
            db.flush()

        if (not clear_operador) and operador_id_i is not None:
            ensure_participante_ativo_repo(
                db,
                atendimento=atendimento,
                colaborador_id=operador_id_i,
                preferir_responsavel_se_vazio=True,
            )

        return atendimento

    except Exception:
        _safe_rollback(db)
        return _query_open_atendimento(
            db,
            empresa_id=empresa_id_i,
            instancia_id=instancia_id_i,
            cliente_id=cliente_id_i,
            departamento_id=departamento_id_i,
        )


def get_atendimento_id_repo(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    direcao: str,
    ts_dt,
    departamento_id: int | None = None,
    operador_id: int | None = None,
) -> int | None:
    atendimento = get_or_open_atendimento_repo(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        cliente_id=cliente_id,
        direcao=direcao,
        ts_dt=ts_dt,
        departamento_id=departamento_id,
        operador_id=operador_id,
    )

    if atendimento is None:
        return None

    att_id = getattr(atendimento, "id", None)
    return int(att_id) if att_id is not None else None


def attach_atendimento_to_message_if_supported(msg_model, atendimento_id: int | None):
    if not has_mensagem_atendimento_field():
        return msg_model

    if atendimento_id is None:
        return msg_model

    if hasattr(msg_model, "atendimento_id"):
        setattr(msg_model, "atendimento_id", int(atendimento_id))

    return msg_model


__all__ = [
    "has_mensagem_atendimento_field",
    "has_atendimento_participante_model",
    "get_or_open_atendimento_repo",
    "get_atendimento_id_repo",
    "update_open_atendimento_departamento_repo",
    "ensure_participante_ativo_repo",
    "attach_atendimento_to_message_if_supported",
]
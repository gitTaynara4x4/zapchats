#backend\integrations\evolution\repositories\instancias_repo.py


from __future__ import annotations
import re
from typing import Optional
from sqlalchemy.orm import Session
from backend import models
from ..utils.time_utils import _now_utc


def get_instancia_by_name(
    db: Session,
    *,
    instance_name: str | None,
) -> Optional[models.EmpresaInstancia]:
    raw = str(instance_name or "").strip()
    if not raw:
        return None

    return (
        db.query(models.EmpresaInstancia)
        .filter(models.EmpresaInstancia.instance_name == raw)
        .first()
    )


def get_empresa_id_by_instance_name(
    db: Session,
    *,
    instance_name: str | None,
) -> int | None:
    inst = get_instancia_by_name(db, instance_name=instance_name)
    return int(inst.empresa_id) if inst and getattr(inst, "empresa_id", None) else None


def get_me_number_by_instancia(inst: models.EmpresaInstancia | None) -> str | None:
    if not inst:
        return None

    numero = getattr(inst, "numero_instancia", None)
    if numero:
        digits = re.sub(r"\D", "", str(numero))
        return digits or None

    return None


def recount_connected_instances_for_empresa(
    db: Session,
    *,
    empresa_id: int,
) -> int:
    total = (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.empresa_id == int(empresa_id),
            models.EmpresaInstancia.connected.is_(True),
        )
        .count()
    )

    emp = db.query(models.Empresa).filter(models.Empresa.id == int(empresa_id)).first()
    if emp and hasattr(emp, "quantidade_instancias"):
        emp.quantidade_instancias = total

    return total


def set_instance_connection_state(
    db: Session,
    *,
    instance_name: str,
    connected: bool,
    wuid: str | None = None,
) -> models.EmpresaInstancia | None:
    inst = get_instancia_by_name(db, instance_name=instance_name)
    if not inst:
        return None

    inst.connected = bool(connected)
    inst.last_seen = _now_utc()

    if isinstance(wuid, str) and wuid.endswith("@s.whatsapp.net"):
        inst.numero_instancia = re.sub(r"\D", "", wuid.split("@", 1)[0])

    if getattr(inst, "empresa_id", None):
        recount_connected_instances_for_empresa(db, empresa_id=int(inst.empresa_id))

    return inst


def mark_instance_disconnected(
    db: Session,
    *,
    instance_name: str,
) -> models.EmpresaInstancia | None:
    return set_instance_connection_state(
        db,
        instance_name=instance_name,
        connected=False,
        wuid=None,
    )


__all__ = [
    "get_instancia_by_name",
    "get_empresa_id_by_instance_name",
    "get_me_number_by_instancia",
    "recount_connected_instances_for_empresa",
    "set_instance_connection_state",
    "mark_instance_disconnected",
]
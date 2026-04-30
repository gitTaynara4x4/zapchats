from __future__ import annotations

from typing import Any, List, Optional

from sqlalchemy.orm import Session

from backend import models


def _id_get(obj: Any, key: str, default: Any = None) -> Any:
    """
    Lê campo do identity suportando dict ou objeto.
    """
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _to_int(v: Any) -> Optional[int]:
    try:
        if v is None:
            return None
        s = str(v).strip()
        if not s:
            return None
        return int(s)
    except Exception:
        return None


def _normalize_ids(raw: Any) -> List[int]:
    """
    Converte lista mista para ints únicos.
    """
    if not raw:
        return []

    out: List[int] = []
    for x in raw:
        if x is None:
            continue
        try:
            n = int(x)
        except (TypeError, ValueError):
            continue
        if n not in out:
            out.append(n)
    return out


def _is_admin(identity: Any) -> bool:
    try:
        if identity is None:
            return False

        if bool(_id_get(identity, "is_admin")) or bool(_id_get(identity, "admin")):
            return True

        perms = _id_get(identity, "permissoes") or _id_get(identity, "permissions") or []
        if isinstance(perms, dict):
            perms = [k for k, v in perms.items() if v]

        perms = set(str(p).lower() for p in (perms or []))
        return any(p in perms for p in ("admin", "root", "clientes.gerenciar", "atendimento.gerenciar"))
    except Exception:
        return False


def _infer_kind(identity: Any) -> str:
    """
    Retorna:
      - 'colaborador'
      - 'usuario'
    """
    if identity is None:
        return "usuario"

    k = str(_id_get(identity, "kind") or _id_get(identity, "tipo") or "").strip().lower()
    if k in ("colaborador", "usuario", "admin"):
        return "colaborador" if k == "colaborador" else "usuario"

    sub = str(_id_get(identity, "sub") or "").strip().lower()
    role = str(_id_get(identity, "role") or "").strip().lower()

    if sub.startswith("colab-") or "colab" in role or "colaborador" in role:
        return "colaborador"

    for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
        if _to_int(_id_get(identity, key)):
            return "colaborador"

    return "usuario"


def _get_colab_id(identity: Any) -> Optional[int]:
    for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
        cid = _to_int(_id_get(identity, key))
        if cid:
            return cid

    sub = str(_id_get(identity, "sub") or "").strip().lower()
    if sub.startswith("colab-"):
        try:
            return int(sub.split("-", 1)[1])
        except Exception:
            return None

    return _to_int(_id_get(identity, "id"))


def instancias_visiveis(identity: Any, db: Session) -> Optional[List[int]]:
    """
    Retorna quais IDs de instância o login atual pode ver.

    Convenção:
      - None   => sem filtro (pode ver TODAS)
      - []     => não pode ver nenhuma
      - [1, 2] => só pode ver essas

    Regras:
      - admin / usuário normal => None
      - colaborador:
          * precisa existir no banco
          * precisa ser da empresa do token
          * usa SOMENTE colaboradores.instancias_ver
          * vazio/None => []
    """
    if _is_admin(identity):
        return None

    if _infer_kind(identity) != "colaborador":
        return None

    empresa_id = _to_int(_id_get(identity, "empresa_id"))
    colab_id = _get_colab_id(identity)

    if not colab_id:
        return []

    colab: models.Colaborador | None = db.get(models.Colaborador, int(colab_id))  # type: ignore[arg-type]
    if not colab:
        return []

    try:
        if empresa_id is not None and int(getattr(colab, "empresa_id", 0) or 0) != int(empresa_id):
            return []
    except Exception:
        return []

    raw_insts = getattr(colab, "instancias_ver", None)

    # vazio = não vê nada
    if not raw_insts:
        return []

    norm_ids = _normalize_ids(raw_insts)
    if not norm_ids:
        return []

    try:
        rows = (
            db.query(models.EmpresaInstancia.id)
            .filter(
                models.EmpresaInstancia.empresa_id == int(getattr(colab, "empresa_id")),
                models.EmpresaInstancia.id.in_(norm_ids),
            )
            .all()
        )
        valid_ids = [int(r[0]) for r in rows if r and r[0] is not None]
    except Exception:
        return []

    if not valid_ids:
        return []

    return valid_ids


def instancia_permitida(identity: Any, db: Session, instancia_id: Any) -> bool:
    """
    True se pode usar/ver a instância.
    """
    try:
        inst_id = int(instancia_id)
    except (TypeError, ValueError):
        return False

    visiveis = instancias_visiveis(identity, db)

    if visiveis is None:
        return True

    return inst_id in visiveis


__all__ = [
    "instancias_visiveis",
    "instancia_permitida",
]
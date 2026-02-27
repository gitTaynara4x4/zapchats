# backend/security/instancias.py
from __future__ import annotations

from typing import Any, List, Optional

from sqlalchemy.orm import Session

from backend import models


def _id_get(obj: Any, key: str, default: Any = None) -> Any:
    """
    Helper simples pra ler campos do `identity` tanto se ele for dict
    quanto se for um objeto com atributos.
    """
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _normalize_ids(raw: Any) -> List[int]:
    """
    Converte uma lista qualquer (ints/str/misto) em lista de ints únicos.
    Ignora valores inválidos.
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


def instancias_visiveis(identity: Any, db: Session) -> Optional[List[int]]:
    """
    Retorna quais IDs de instância o login atual pode ver.

    Convenção de retorno:
      - retorna `None`  -> sem filtro (pode ver TODAS as instâncias)
      - retorna [1, 2]  -> só pode ver as instâncias 1 e 2

    Regras de negócio:

      - USUÁRIO (admin / usuário normal):
          * kind == "usuario" => sempre `None` (sem filtro por instância)

      - COLABORADOR:
          * se `instancias_ver` estiver vazio/None -> `None` (pode ver todas)
          * se tiver [ids...] -> retorna essa lista normalizada
    """
    kind = _id_get(identity, "kind")  # "usuario" ou "colaborador"

    # Usuário normal/admin -> não restringe por instância
    if kind != "colaborador":
        return None

    empresa_id = _id_get(identity, "empresa_id")
    colab_id = _id_get(identity, "colaborador_id")

    if not colab_id:
        # Algum colaborador sem ID? Por segurança, não restringe aqui.
        # Se preferir travar tudo, poderia retornar [].
        return None

    # Busca o colaborador no banco (SQLAlchemy 1.4/2.0 friendly)
    colab: models.Colaborador | None = db.get(models.Colaborador, int(colab_id))  # type: ignore[arg-type]
    if not colab:
        # Colaborador não encontrado: não faz filtro aqui
        return None

    # Se tiver empresa_id no identity, confere (defesa extra)
    try:
        if empresa_id is not None and getattr(colab, "empresa_id", None) != int(empresa_id):
            # Empresa divergente: por segurança, retorna lista vazia (vê nada)
            return []
    except Exception:
        # Se der qualquer erro estranho, não derruba a request por causa disso
        pass

    # Campo que já existe no model (usado em colaboradores.py)
    raw_insts = getattr(colab, "instancias_ver", None)

    # Se não tiver nada configurado => sem filtro (vê todas)
    if not raw_insts:
        return None

    norm_ids = _normalize_ids(raw_insts)

    # Se depois de normalizar ainda ficar vazio, também considera "sem filtro"
    # (se quiser que vazio signifique "não vê nada", troque pra `return []` aqui)
    if not norm_ids:
        return None

    return norm_ids


def instancia_permitida(identity: Any, db: Session, instancia_id: Any) -> bool:
    """
    Helper de conveniência:

      - True  => esse login PODE usar/ver a instância informada
      - False => NÃO pode

    Regras:
      - Se instancias_visiveis() retornar None -> qualquer instância é permitida
      - Se retornar [ids] -> só é permitida se instancia_id estiver nessa lista
    """
    try:
        inst_id = int(instancia_id)
    except (TypeError, ValueError):
        # ID inválido -> por segurança, nega
        return False

    visiveis = instancias_visiveis(identity, db)

    # None = sem filtro (todas permitidas)
    if visiveis is None:
        return True

    return inst_id in visiveis

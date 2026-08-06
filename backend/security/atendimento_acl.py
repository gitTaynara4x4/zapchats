from __future__ import annotations

import re
import unicodedata
from typing import Any, Optional, List

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from backend import models
from backend.services.chatbot_claim_policy import department_acl_enabled


# =========================================================
# Helpers básicos
# =========================================================
def _id_get(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


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


def _is_admin(identity: Any) -> bool:
    try:
        if not identity:
            return False

        if _id_get(identity, "is_admin") or _id_get(identity, "admin"):
            return True

        role = str(_id_get(identity, "role") or "").strip().lower()
        if role == "admin":
            return True

        kind = str(_id_get(identity, "kind") or _id_get(identity, "tipo") or "").strip().lower()
        if kind == "usuario":
            return True

        perms = _id_get(identity, "permissoes") or _id_get(identity, "permissions") or []
        if isinstance(perms, dict):
            perms = [k for k, v in perms.items() if v]

        perms = set(str(p).lower() for p in (perms or []))
        return any(
            p in perms
            for p in (
                "admin",
                "root",
                "clientes.gerenciar",
                "atendimento.gerenciar",
            )
        )
    except Exception:
        return False


def _infer_kind(identity: Any) -> str:
    if not identity:
        return "usuario"

    k = str(_id_get(identity, "kind") or _id_get(identity, "tipo") or "").lower().strip()
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
    """
    Retorna id de colaborador.

    Importante:
    - Dá prioridade para campos explícitos de colaborador.
    - Só usa identity["id"] como fallback quando a identidade realmente parece ser colaborador.
    """
    if not identity:
        return None

    for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
        cid = _to_int(_id_get(identity, key))
        if cid:
            return cid

    sub = str(_id_get(identity, "sub") or "").strip().lower()
    if sub.startswith("colab-"):
        cid = _to_int(sub.split("-", 1)[1])
        if cid:
            return cid

    if _infer_kind(identity) == "colaborador":
        return _to_int(_id_get(identity, "id"))

    return None


def _get_empresa_id(identity: Any) -> Optional[int]:
    if not identity:
        return None
    return _to_int(_id_get(identity, "empresa_id"))


VISIBILIDADE_ATENDIMENTOS_TODOS = "todos"
VISIBILIDADE_ATENDIMENTOS_PROPRIOS = "proprios"


def _norm_visibilidade_atendimentos(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in {
        "proprios", "proprias", "somente_meus", "somente_minhas",
        "meus", "minhas", "own", "only_own",
    }:
        return VISIBILIDADE_ATENDIMENTOS_PROPRIOS
    return VISIBILIDADE_ATENDIMENTOS_TODOS


def get_atendimento_visibility_scope(
    db: Session,
    *,
    identity: Any,
    empresa_id: int,
) -> str:
    """Retorna 'todos' ou 'proprios' para a identidade atual.

    Administradores/usuários master mantêm acesso total. O valor padrão também
    é total para preservar o comportamento dos colaboradores já existentes.
    """
    # Usuários da empresa (conta principal) continuam com visão total. Para
    # colaboradores, respeitamos a configuração mesmo quando o perfil possui
    # permissões amplas, como atendimento.gerenciar.
    if _infer_kind(identity) != "colaborador":
        return VISIBILIDADE_ATENDIMENTOS_TODOS

    role = str(_id_get(identity, "role") or "").strip().lower()
    if bool(_id_get(identity, "is_admin") or _id_get(identity, "admin")) or role == "admin":
        return VISIBILIDADE_ATENDIMENTOS_TODOS

    colab_id = _get_colab_id(identity)
    if not colab_id:
        return VISIBILIDADE_ATENDIMENTOS_TODOS

    try:
        # SAVEPOINT evita deixar a sessão inteira em estado de erro durante um
        # deploy rolling em que a aplicação subiu antes da nova coluna existir.
        with db.begin_nested():
            value = (
                db.query(models.Colaborador.visibilidade_atendimentos)
                .filter(
                    models.Colaborador.id == int(colab_id),
                    models.Colaborador.empresa_id == int(empresa_id),
                )
                .scalar()
            )
        return _norm_visibilidade_atendimentos(value)
    except Exception:
        # O padrão seguro para compatibilidade é preservar o comportamento
        # anterior até a migração automática terminar.
        return VISIBILIDADE_ATENDIMENTOS_TODOS


def is_own_atendimento_conversation(
    db: Session,
    *,
    identity: Any,
    empresa_id: int,
    cliente: Any = None,
    atendimento: Any = None,
) -> bool:
    """Verifica se a conversa pertence atualmente ao colaborador.

    Fontes de verdade, em ordem:
    - operador atual do atendimento;
    - participante ativo (compatibilidade);
    - colaborador responsável diretamente no cliente, quando ainda não há
      atendimento criado.
    """
    if get_atendimento_visibility_scope(
        db, identity=identity, empresa_id=int(empresa_id)
    ) != VISIBILIDADE_ATENDIMENTOS_PROPRIOS:
        return True

    colab_id = _get_colab_id(identity)
    if not colab_id:
        return False

    if atendimento is not None:
        operador_id = _to_int(getattr(atendimento, "operador_id", None))
        if operador_id is not None and int(operador_id) == int(colab_id):
            return True

        atendimento_id = _to_int(getattr(atendimento, "id", None))
        if atendimento_id is not None and is_atendimento_participante_ativo(
            db,
            empresa_id=int(empresa_id),
            atendimento_id=int(atendimento_id),
            colaborador_id=int(colab_id),
        ):
            return True

    cliente_colab_id = _to_int(getattr(cliente, "colaborador_id", None))
    atendimento_sem_operador = (
        atendimento is None
        or _to_int(getattr(atendimento, "operador_id", None)) is None
    )
    if atendimento_sem_operador and cliente_colab_id is not None:
        return int(cliente_colab_id) == int(colab_id)

    return False


def assert_cliente_conversation_visibility(
    db: Session,
    *,
    identity: Any,
    empresa_id: int,
    cliente: Any,
    atendimento: Any = None,
    detail: str = "Esta conversa pertence a outro colaborador",
) -> None:
    if not is_own_atendimento_conversation(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
        cliente=cliente,
        atendimento=atendimento,
    ):
        raise HTTPException(status_code=403, detail=detail)


def _norm_dept_name(value: Any) -> str:
    """
    Normaliza nomes antigos como "02 - Financeiro" para comparar com
    departamentos reais como "Financeiro".
    """
    try:
        txt = str(value or "").strip().lower()
        if not txt:
            return ""
        txt = unicodedata.normalize("NFKD", txt)
        txt = "".join(ch for ch in txt if not unicodedata.combining(ch))
        txt = re.sub(r"^\s*\d+\s*[-–—.:/)]+\s*", "", txt)
        txt = re.sub(r"[^a-z0-9]+", " ", txt)
        txt = re.sub(r"\s+", " ", txt).strip()
        return txt
    except Exception:
        return ""


def _find_departamento_ids_by_fuzzy_name(
    db: Session,
    *,
    empresa_id: int,
    nome: Any,
) -> List[int]:
    """
    Resolve Setor antigo -> Departamento novo mesmo quando um lado tem código
    visual no nome. Ex.: Setor "02 - Financeiro" e Departamento "Financeiro".
    """
    alvo = _norm_dept_name(nome)
    if not alvo:
        return []

    try:
        rows = (
            db.query(models.Departamento.id, models.Departamento.nome)
            .filter(models.Departamento.empresa_id == int(empresa_id))
            .all()
        )
    except Exception:
        return []

    out: List[int] = []
    for dep_id, dep_nome in rows:
        dep_norm = _norm_dept_name(dep_nome)
        if not dep_norm:
            continue
        if dep_norm == alvo or dep_norm.endswith(" " + alvo) or alvo.endswith(" " + dep_norm):
            try:
                did = int(dep_id)
                if did not in out:
                    out.append(did)
            except Exception:
                pass
    return out


def _table_exists(db: Session, table_name: str) -> bool:
    """
    Postgres: to_regclass('public.tabela') retorna NULL se não existir.
    Seguro contra SQL dinâmico inseguro: valida nome e usa parâmetro.
    """
    try:
        name = str(table_name or "").strip()
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
            return False

        reg = db.execute(
            text("SELECT to_regclass(:table_name)"),
            {"table_name": f"public.{name}"},
        ).scalar()
        return reg is not None
    except Exception:
        return False


def _participant_feature_enabled(db: Session) -> bool:
    return getattr(models, "AtendimentoParticipante", None) is not None and _table_exists(
        db, "atendimento_participantes"
    )


# =========================================================
# Empresa / permissão base
# =========================================================
def ensure_perm(identity: Any, perm: str) -> None:
    if _is_admin(identity):
        return

    perms = _id_get(identity, "permissoes") or _id_get(identity, "permissions") or []
    if isinstance(perms, dict):
        perms = [k for k, v in perms.items() if v]

    perms = set(str(p) for p in (perms or []))
    perms_lower = set(str(p).lower() for p in perms)

    if perm not in perms and perm.lower() not in perms_lower:
        raise HTTPException(status_code=403, detail=f"Sem permissão ({perm})")


def assert_same_company(identity: Any, empresa_id: int | None) -> int:
    """
    Segurança multiempresa:
    - A empresa oficial vem sempre do token/identity.
    - Se empresa_id vier vazio, usa a empresa do token.
    - Se vier diferente, bloqueia.
    """
    token_emp = _get_empresa_id(identity)
    if token_emp is None:
        raise HTTPException(status_code=401, detail="Empresa não encontrada no token")

    if empresa_id is None:
        return int(token_emp)

    try:
        emp_req = int(empresa_id)
    except Exception:
        raise HTTPException(status_code=400, detail="empresa_id inválido")

    if int(token_emp) != int(emp_req):
        raise HTTPException(status_code=403, detail="Empresa inválida para este recurso")

    return int(token_emp)


# =========================================================
# Instâncias permitidas
# =========================================================
def allowed_instancia_ids(
    db: Session,
    *,
    identity: Any,
) -> Optional[List[int]]:
    """
    Retorna:
      - None => sem restrição
      - []   => sem acesso
      - [..] => whitelist de instâncias

    Regra segura:
    - admin/usuário master tende a retornar None via instancias_visiveis.
    - se helper de instâncias falhar, colaborador fica sem acesso por segurança.
    """
    try:
        from backend.security.instancias import instancias_visiveis

        ids = instancias_visiveis(identity, db)
        if ids is None:
            return None
        return [int(x) for x in ids if x is not None]
    except Exception:
        if _is_admin(identity):
            return None
        return []


def assert_instancia_allowed(
    *,
    allowed_instancias: Optional[List[int]],
    instancia_id: Optional[int],
    detail: str = "Instância não permitida para este usuário",
) -> None:
    if allowed_instancias is None:
        return

    if not allowed_instancias:
        raise HTTPException(
            status_code=403,
            detail="Sem instâncias permitidas para este colaborador",
        )

    if instancia_id is None:
        raise HTTPException(status_code=403, detail=detail)

    if int(instancia_id) not in set(int(x) for x in allowed_instancias):
        raise HTTPException(status_code=403, detail=detail)


# =========================================================
# Departamentos permitidos
# =========================================================
def _expand_departamento_ids_with_descendants(
    db: Session,
    *,
    empresa_id: int,
    departamento_ids: List[int],
) -> List[int]:
    """
    Se o colaborador atende um departamento pai, também libera os filhos.
    Exemplo:
    - Financeiro
      - Cobrança
      - Contabilidade

    Se o colaborador atende Financeiro, ele também vê Cobrança/Contabilidade.
    """
    base: List[int] = []

    for raw in departamento_ids or []:
        n = _to_int(raw)
        if n and n not in base:
            base.append(int(n))

    if not base:
        return []

    if not hasattr(models.Departamento, "parent_id"):
        return base

    try:
        rows = (
            db.query(models.Departamento.id, models.Departamento.parent_id)
            .filter(models.Departamento.empresa_id == int(empresa_id))
            .all()
        )
    except Exception:
        return base

    children_by_parent: dict[int, list[int]] = {}

    for dep_id_raw, parent_id_raw in rows:
        dep_id = _to_int(dep_id_raw)
        parent_id = _to_int(parent_id_raw)

        if dep_id is None or parent_id is None:
            continue

        children_by_parent.setdefault(int(parent_id), []).append(int(dep_id))

    out: List[int] = []
    queue: List[int] = list(base)

    while queue:
        dep_id = queue.pop(0)

        if dep_id in out:
            continue

        out.append(dep_id)

        for child_id in children_by_parent.get(dep_id, []):
            if child_id not in out:
                queue.append(child_id)

    return out


def _fallback_departamentos_do_colaborador_por_setor(
    db: Session,
    *,
    empresa_id: int,
    colaborador_id: int,
) -> List[int]:
    """
    Compatibilidade com dados antigos e com o cadastro visual do colaborador.

    O campo colaboradores.setor_id pode apontar para:
    1) um Setor antigo; nesse caso resolvemos o Departamento pelo nome do Setor;
    2) um Departamento real; nesse caso usamos o próprio id.

    Importante: primeiro tenta Setor por nome. Assim evitamos confundir
    setor_id=2 com departamento_id=2 quando o Financeiro real tem outro id.
    """
    colab = (
        db.query(models.Colaborador)
        .filter(
            models.Colaborador.empresa_id == int(empresa_id),
            models.Colaborador.id == int(colaborador_id),
        )
        .first()
    )

    if not colab:
        return []

    setor_id = _to_int(getattr(colab, "setor_id", None))
    if not setor_id:
        return []

    out: List[int] = []

    # 1) Preferência: setor antigo -> departamento com mesmo nome.
    setor_nome = None

    try:
        setor = (
            db.query(models.Setor)
            .filter(
                models.Setor.empresa_id == int(empresa_id),
                models.Setor.id == int(setor_id),
            )
            .first()
        )
        setor_nome = getattr(setor, "nome", None) if setor else None
    except Exception:
        setor_nome = None

    if setor_nome:
        # Compatibilidade: Setor antigo pode ter código visual no nome
        # (ex.: "02 - Financeiro") enquanto Departamento novo é "Financeiro".
        for dep_id in _find_departamento_ids_by_fuzzy_name(
            db,
            empresa_id=int(empresa_id),
            nome=setor_nome,
        ):
            if dep_id not in out:
                out.append(dep_id)

        if not out:
            dep_by_name = (
                db.query(models.Departamento.id)
                .filter(
                    models.Departamento.empresa_id == int(empresa_id),
                    text("lower(trim(nome)) = lower(trim(:nome))"),
                )
                .params(nome=str(setor_nome).strip())
                .first()
            )

            if dep_by_name and dep_by_name[0] is not None:
                dep_id = int(dep_by_name[0])
                if dep_id not in out:
                    out.append(dep_id)

    # 2) Compatibilidade: se não achou por Setor, tenta tratar setor_id como Departamento.
    if not out:
        dep_direct = (
            db.query(models.Departamento.id)
            .filter(
                models.Departamento.empresa_id == int(empresa_id),
                models.Departamento.id == int(setor_id),
            )
            .first()
        )

        if dep_direct and dep_direct[0] is not None:
            out.append(int(dep_direct[0]))

    return out


def allowed_departamento_ids(
    db: Session,
    *,
    identity: Any,
    empresa_id: int,
) -> Optional[List[int]]:
    """
    Modelo 2:
      - None => sem restrição (admin / usuário master)
      - []   => colaborador sem nenhum departamento permitido
      - [..] => departamentos do colaborador em departamentos_membros

    Regra:
      - Colaborador usa departamentos_membros.
      - Se não tiver dados novos, cai no fallback por setor_id antigo.
      - Departamento pai libera filhos.
    """
    if _is_admin(identity):
        return None

    if _infer_kind(identity) != "colaborador":
        return None

    if not _table_exists(db, "departamentos_membros"):
        return None

    colab_id = _get_colab_id(identity)
    if not colab_id:
        return []

    rows = db.execute(
        text(
            """
            SELECT departamento_id
            FROM departamentos_membros
            WHERE empresa_id = :emp
              AND colaborador_id = :cid
            ORDER BY is_primary DESC, departamento_id ASC
            """
        ),
        {"emp": int(empresa_id), "cid": int(colab_id)},
    ).fetchall()

    deps: List[int] = []

    for r in rows:
        dep_id = _to_int(r[0] if r else None)
        if dep_id and dep_id not in deps:
            deps.append(int(dep_id))

    # Junta o vínculo novo (departamentos_membros) com o departamento principal
    # do cadastro do colaborador. Isso evita o caso: tela mostra Amanda no
    # Financeiro, mas a lista fica vazia porque o Financeiro salvo no atendimento
    # tem outro id interno.
    fallback_deps = _fallback_departamentos_do_colaborador_por_setor(
        db,
        empresa_id=int(empresa_id),
        colaborador_id=int(colab_id),
    )

    for dep_id in fallback_deps:
        dep_id = _to_int(dep_id)
        if dep_id and dep_id not in deps:
            deps.append(int(dep_id))

    return _expand_departamento_ids_with_descendants(
        db,
        empresa_id=int(empresa_id),
        departamento_ids=deps,
    )


def assert_departamento_allowed(
    *,
    allowed_departamentos: Optional[List[int]],
    departamento_id: Optional[int],
    allow_unassigned: bool = True,
    detail: str = "Departamento não permitido para este usuário",
) -> None:
    """
    Modelo 2:
    - Se a conversa ainda NÃO tem departamento, não bloqueia por departamento.
    - Se tem departamento, precisa estar em departamentos_membros.
    """
    if allowed_departamentos is None:
        return

    if departamento_id is None:
        if allow_unassigned:
            return
        raise HTTPException(status_code=403, detail=detail)

    if not allowed_departamentos:
        raise HTTPException(
            status_code=403,
            detail="Sem departamentos permitidos para este colaborador",
        )

    if int(departamento_id) not in set(int(x) for x in allowed_departamentos):
        raise HTTPException(status_code=403, detail=detail)


# =========================================================
# ACL composta: departamento + instância
# =========================================================
def assert_atendimento_acl(
    *,
    allowed_instancias: Optional[List[int]],
    allowed_departamentos: Optional[List[int]],
    instancia_id: Optional[int],
    departamento_id: Optional[int],
    allow_unassigned_department: bool = True,
) -> None:
    assert_instancia_allowed(
        allowed_instancias=allowed_instancias,
        instancia_id=instancia_id,
    )
    assert_departamento_allowed(
        allowed_departamentos=allowed_departamentos,
        departamento_id=departamento_id,
        allow_unassigned=allow_unassigned_department,
    )


def _atendimento_is_owned_by_identity(identity: Any, atendimento: Any) -> bool:
    """Permite manter acesso ao atendimento que já foi assumido pelo próprio colaborador."""
    try:
        colab_id = _get_colab_id(identity)
        operador_id = _to_int(getattr(atendimento, "operador_id", None))
        return bool(colab_id and operador_id and int(colab_id) == int(operador_id))
    except Exception:
        return False


def resolve_acl_context(
    db: Session,
    *,
    identity: Any,
    empresa_id: int | None,
) -> dict:
    empresa_id = assert_same_company(identity, empresa_id)

    return {
        "empresa_id": int(empresa_id),
        "allowed_instancias": allowed_instancia_ids(db, identity=identity),
        "allowed_departamentos": allowed_departamento_ids(
            db,
            identity=identity,
            empresa_id=int(empresa_id),
        ),
    }


def _allowed_departamentos_for_instancia(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int],
    allowed_departamentos: Optional[List[int]],
) -> Optional[List[int]]:
    """
    O departamento só restringe conversas quando o menu por departamentos
    está ligado naquela instância.

    Com o botão desligado, a ACL efetiva fica somente por WhatsApp/instância.
    """
    if allowed_departamentos is None:
        return None

    if not department_acl_enabled(
        db,
        empresa_id=int(empresa_id),
        instancia_id=instancia_id,
    ):
        return None

    return allowed_departamentos


def build_allowed_filters(
    *,
    allowed_instancias: Optional[List[int]],
    allowed_departamentos: Optional[List[int]],
) -> dict:
    return {
        "instancias": None if allowed_instancias is None else [int(x) for x in allowed_instancias],
        "departamentos": None if allowed_departamentos is None else [int(x) for x in allowed_departamentos],
    }


# =========================================================
# Lookups de atendimento / cliente
# =========================================================
def get_atendimento_or_404(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
):
    row = (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.empresa_id == int(empresa_id),
            models.Atendimento.id == int(atendimento_id),
        )
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Atendimento não encontrado")
    return row


def get_latest_atendimento_for_cliente(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    instancia_id: int | None = None,
):
    q = (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.empresa_id == int(empresa_id),
            models.Atendimento.cliente_id == int(cliente_id),
        )
    )

    if instancia_id is not None:
        q = q.filter(models.Atendimento.instancia_id == int(instancia_id))

    row = q.order_by(models.Atendimento.id.desc()).first()
    return row


def get_cliente_or_404(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
):
    row = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.empresa_id == int(empresa_id),
            models.Cliente.id == int(cliente_id),
        )
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")
    return row


# =========================================================
# Participação / aceite da conversa
# =========================================================
def get_atendimento_participantes_ativos(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
):
    if not _participant_feature_enabled(db):
        return []

    AP = models.AtendimentoParticipante

    q = db.query(AP).filter(
        AP.empresa_id == int(empresa_id),
        AP.atendimento_id == int(atendimento_id),
    )

    if hasattr(AP, "is_ativo"):
        q = q.filter(AP.is_ativo.is_(True))

    return q.order_by(AP.id.asc()).all()


def get_atendimento_participante_ids_ativos(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
) -> List[int]:
    rows = get_atendimento_participantes_ativos(
        db,
        empresa_id=empresa_id,
        atendimento_id=atendimento_id,
    )
    out: List[int] = []
    for r in rows:
        cid = _to_int(getattr(r, "colaborador_id", None))
        if cid and cid not in out:
            out.append(cid)
    return out


def is_atendimento_participante_ativo(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
    colaborador_id: int,
) -> bool:
    if not _participant_feature_enabled(db):
        return False

    AP = models.AtendimentoParticipante

    q = db.query(AP.id).filter(
        AP.empresa_id == int(empresa_id),
        AP.atendimento_id == int(atendimento_id),
        AP.colaborador_id == int(colaborador_id),
    )

    if hasattr(AP, "is_ativo"):
        q = q.filter(AP.is_ativo.is_(True))

    row = q.first()
    return row is not None


def assert_atendimento_participante(
    db: Session,
    *,
    identity: Any,
    empresa_id: int,
    atendimento_id: int,
    allow_when_no_participants: bool = False,
    detail: str = "Você precisa aceitar/entrar nesta conversa antes de responder",
) -> List[int]:
    """
    Regra de interação:
      - admin/usuário master: bypass
      - se feature de participantes ainda não existir: bypass
      - colaborador precisa estar entre os participantes ativos
      - se não houver participantes ativos:
          * allow_when_no_participants=True -> libera
          * False -> bloqueia
    """
    if _is_admin(identity):
        return []

    if _infer_kind(identity) != "colaborador":
        return []

    if not _participant_feature_enabled(db):
        return []

    colab_id = _get_colab_id(identity)
    if not colab_id:
        raise HTTPException(status_code=403, detail=detail)

    participantes_ids = get_atendimento_participante_ids_ativos(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )

    if not participantes_ids:
        if allow_when_no_participants:
            return []
        raise HTTPException(status_code=403, detail=detail)

    if int(colab_id) not in set(int(x) for x in participantes_ids):
        raise HTTPException(status_code=403, detail=detail)

    return participantes_ids


# =========================================================
# Asserts de acesso prontos para usar nas rotas
# =========================================================
def assert_atendimento_access(
    db: Session,
    *,
    identity: Any,
    empresa_id: int | None,
    atendimento_id: int,
    allow_unassigned_department: bool = True,
):
    ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id)
    atendimento = get_atendimento_or_404(
        db,
        empresa_id=int(ctx["empresa_id"]),
        atendimento_id=int(atendimento_id),
    )

    assert_cliente_conversation_visibility(
        db,
        identity=identity,
        empresa_id=int(ctx["empresa_id"]),
        cliente=getattr(atendimento, "cliente", None),
        atendimento=atendimento,
    )

    if _atendimento_is_owned_by_identity(identity, atendimento):
        assert_instancia_allowed(
            allowed_instancias=ctx["allowed_instancias"],
            instancia_id=getattr(atendimento, "instancia_id", None),
        )
    else:
        allowed_departamentos = _allowed_departamentos_for_instancia(
            db,
            empresa_id=int(ctx["empresa_id"]),
            instancia_id=getattr(atendimento, "instancia_id", None),
            allowed_departamentos=ctx["allowed_departamentos"],
        )
        assert_atendimento_acl(
            allowed_instancias=ctx["allowed_instancias"],
            allowed_departamentos=allowed_departamentos,
            instancia_id=getattr(atendimento, "instancia_id", None),
            departamento_id=getattr(atendimento, "departamento_id", None),
            allow_unassigned_department=allow_unassigned_department,
        )

    return atendimento


def assert_cliente_access(
    db: Session,
    *,
    identity: Any,
    empresa_id: int | None,
    cliente_id: int,
    instancia_id: int | None = None,
    allow_unassigned_department: bool = True,
    allow_unowned_if_no_history: bool = False,
    allow_join_existing: bool = False,
):
    ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id)

    cliente = get_cliente_or_404(
        db,
        empresa_id=int(ctx["empresa_id"]),
        cliente_id=int(cliente_id),
    )

    atendimento = get_latest_atendimento_for_cliente(
        db,
        empresa_id=int(ctx["empresa_id"]),
        cliente_id=int(cliente_id),
        instancia_id=instancia_id,
    )

    # Para "Nova conversa"/participação, um atendimento histórico já fechado
    # não deve bloquear a conversa nova com a ACL do responsável antigo.
    if allow_join_existing and atendimento is not None:
        status_atd = str(getattr(atendimento, "status", "") or "").split(".")[-1].strip().lower()
        if status_atd not in {"novo", "aguardando", "em_atendimento", "pausado"}:
            atendimento = None

    can_start_unowned_conversation = False
    if allow_unowned_if_no_history:
        history_query = db.query(models.Mensagem.id).filter(
            models.Mensagem.empresa_id == int(ctx["empresa_id"]),
            models.Mensagem.cliente_id == int(cliente_id),
        )
        if instancia_id is not None:
            history_query = history_query.filter(
                models.Mensagem.instancia_id == int(instancia_id)
            )

        has_history = history_query.first() is not None
        atendimento_operador_id = (
            _to_int(getattr(atendimento, "operador_id", None))
            if atendimento is not None
            else None
        )
        cliente_colaborador_id = _to_int(getattr(cliente, "colaborador_id", None))
        can_start_unowned_conversation = (
            not has_history
            and atendimento_operador_id is None
            and cliente_colaborador_id is None
        )

    if atendimento is not None:
        if not can_start_unowned_conversation and not allow_join_existing:
            assert_cliente_conversation_visibility(
                db,
                identity=identity,
                empresa_id=int(ctx["empresa_id"]),
                cliente=cliente,
                atendimento=atendimento,
            )

        if _atendimento_is_owned_by_identity(identity, atendimento):
            assert_instancia_allowed(
                allowed_instancias=ctx["allowed_instancias"],
                instancia_id=getattr(atendimento, "instancia_id", None),
            )
        else:
            allowed_departamentos = _allowed_departamentos_for_instancia(
                db,
                empresa_id=int(ctx["empresa_id"]),
                instancia_id=getattr(atendimento, "instancia_id", None),
                allowed_departamentos=ctx["allowed_departamentos"],
            )
            assert_atendimento_acl(
                allowed_instancias=ctx["allowed_instancias"],
                allowed_departamentos=allowed_departamentos,
                instancia_id=getattr(atendimento, "instancia_id", None),
                departamento_id=getattr(atendimento, "departamento_id", None),
                allow_unassigned_department=allow_unassigned_department,
            )
        return cliente, atendimento

    if not can_start_unowned_conversation and not allow_join_existing:
        assert_cliente_conversation_visibility(
            db,
            identity=identity,
            empresa_id=int(ctx["empresa_id"]),
            cliente=cliente,
            atendimento=None,
        )

    fallback_instancia_id = instancia_id
    if fallback_instancia_id is None:
        fallback_instancia_id = getattr(cliente, "instancia_id", None)

    fallback_departamento_id = getattr(cliente, "departamento_id", None)

    allowed_departamentos = _allowed_departamentos_for_instancia(
        db,
        empresa_id=int(ctx["empresa_id"]),
        instancia_id=fallback_instancia_id,
        allowed_departamentos=ctx["allowed_departamentos"],
    )

    assert_atendimento_acl(
        allowed_instancias=ctx["allowed_instancias"],
        allowed_departamentos=allowed_departamentos,
        instancia_id=fallback_instancia_id,
        departamento_id=fallback_departamento_id,
        allow_unassigned_department=allow_unassigned_department,
    )

    return cliente, None


def assert_atendimento_interaction_access(
    db: Session,
    *,
    identity: Any,
    empresa_id: int | None,
    atendimento_id: int,
    allow_unassigned_department: bool = True,
    allow_when_no_participants: bool = False,
):
    """
    Usa quando a rota precisa de permissão de INTERAÇÃO,
    não só de visualização.
    Ex.: enviar mensagem, marcar como lida manualmente, etc.
    """
    atendimento = assert_atendimento_access(
        db,
        identity=identity,
        empresa_id=empresa_id,
        atendimento_id=atendimento_id,
        allow_unassigned_department=allow_unassigned_department,
    )

    assert_atendimento_participante(
        db,
        identity=identity,
        empresa_id=int(getattr(atendimento, "empresa_id")),
        atendimento_id=int(getattr(atendimento, "id")),
        allow_when_no_participants=allow_when_no_participants,
    )

    return atendimento


def assert_cliente_interaction_access(
    db: Session,
    *,
    identity: Any,
    empresa_id: int | None,
    cliente_id: int,
    instancia_id: int | None = None,
    allow_unassigned_department: bool = True,
    allow_when_no_participants: bool = False,
):
    """
    Igual ao assert_cliente_access, mas para ação de interação.
    Se existir atendimento, exige participação.
    Se ainda não existir atendimento, só valida ACL de visibilidade.
    """
    cliente, atendimento = assert_cliente_access(
        db,
        identity=identity,
        empresa_id=empresa_id,
        cliente_id=cliente_id,
        instancia_id=instancia_id,
        allow_unassigned_department=allow_unassigned_department,
    )

    if atendimento is not None:
        assert_atendimento_participante(
            db,
            identity=identity,
            empresa_id=int(getattr(atendimento, "empresa_id")),
            atendimento_id=int(getattr(atendimento, "id")),
            allow_when_no_participants=allow_when_no_participants,
        )

    return cliente, atendimento


__all__ = [
    "ensure_perm",
    "assert_same_company",
    "allowed_instancia_ids",
    "allowed_departamento_ids",
    "assert_instancia_allowed",
    "assert_departamento_allowed",
    "assert_atendimento_acl",
    "get_atendimento_visibility_scope",
    "is_own_atendimento_conversation",
    "assert_cliente_conversation_visibility",
    "resolve_acl_context",
    "build_allowed_filters",
    "get_atendimento_or_404",
    "get_latest_atendimento_for_cliente",
    "get_cliente_or_404",
    "get_atendimento_participantes_ativos",
    "get_atendimento_participante_ids_ativos",
    "is_atendimento_participante_ativo",
    "assert_atendimento_participante",
    "assert_atendimento_access",
    "assert_cliente_access",
    "assert_atendimento_interaction_access",
    "assert_cliente_interaction_access",
]
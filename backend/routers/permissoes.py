from __future__ import annotations
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Body, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from pydantic import BaseModel, Field

from backend.database import get_db
from backend.routers.auth import get_current_identity, get_current_user
from backend import models

router = APIRouter(prefix="/api/permissoes", tags=["Permissões"])

# ===== Catálogo de permissões (exibido no front) =====
PERMISSOES_CATALOGO = [
    {"id": "dashboard.ver",             "label": "Ver Dashboard"},

    # ===== MÓDULO CLIENTES =====
    {"id": "clientes.ver",              "label": "Ver clientes"},
    {"id": "clientes.criar",            "label": "Criar clientes"},
    {"id": "clientes.editar",           "label": "Editar clientes"},
    {"id": "clientes.importar_exportar","label": "Importar/Exportar clientes"},
    {"id": "clientes.excluir",          "label": "Excluir clientes"},

    # ===== OUTROS MÓDULOS =====
    {"id": "departamentos.gerenciar",   "label": "Gerenciar departamentos"},
    {"id": "usuarios.gerenciar",        "label": "Gerenciar usuários/equipe"},
    {"id": "colaboradores.ver",         "label": "Ver colaboradores"},
    {"id": "colaboradores.gerenciar",   "label": "Gerenciar colaboradores"},
    {"id": "colaboradores.redefinir_senha", "label": "Redefinir senha de colaboradores"},

    {"id": "integracoes.whatsapp",      "label": "Gerenciar integrações WhatsApp"},
    {"id": "config.editar",             "label": "Editar configurações"},
    {"id": "chatinterno.ver",           "label": "Ver Chat Interno"},
    {"id": "chatbot.configurar",        "label": "Configurar Chatbot"},

    # ===== ATENDIMENTO =====
    {"id": "atendimento.ver",           "label": "Ver Atendimento"},
    {"id": "atendimento.enviar",        "label": "Enviar mensagens no Atendimento"},
    {"id": "atendimento.apagar_mensagens", "label": "Apagar mensagens do Atendimento"},
    {"id": "arquivos.ver",              "label": "Ver Mídias/Arquivos"},

    # ===== MÓDULO DE E-MAIL =====
    {"id": "email.ver",                 "label": "Ver E-mails"},
    {"id": "email.gerenciar",           "label": "Gerenciar contas de E-mail"},
]


def _all_perm_ids() -> List[str]:
    return [p["id"] for p in PERMISSOES_CATALOGO]


def _sync_catalog_to_db(db: Session) -> None:
    for p in PERMISSOES_CATALOGO:
        pid, label = p["id"], p["label"]
        db.execute(
            text(
                """
                INSERT INTO permissoes (id, nome)
                VALUES (:id, :nome)
                ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome
                """
            ),
            {"id": pid, "nome": label},
        )
    db.commit()


@router.get("", response_model=List[dict])
def listar_permissoes(
    empresa_id: Optional[int] = None,  # compatibilidade
    user=Depends(get_current_user),
):
    """Lista o catálogo de permissões (empresa_id é ignorado; compatibilidade)."""
    return PERMISSOES_CATALOGO


@router.post("/sync", status_code=204)
def syncar_catalogo(
    user: models.Usuario = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Sincroniza o catálogo no banco (tabela 'permissoes')."""
    _sync_catalog_to_db(db)
    return


# ===== Minhas permissões (sem bypass; com fallback para admin sem espelho) =====
@router.get("/minhas", response_model=List[str])
def minhas_permissoes(
    identity=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    """Retorna as permissões efetivas do usuário logado.

    Regras:
      - Se houver colaborador correspondente (espelho), retorna o que estiver na tabela colaboradores_permissoes;
      - NÃO há bypass automático só por ser admin;
      - Somente se for admin e NÃO existir colaborador espelho, fallback = todas as permissões.
    """
    empresa_id = identity.get("empresa_id")
    kind = identity.get("kind")  # "usuario" ou "colaborador"
    is_admin = bool(identity.get("is_admin"))

    # 1) Tentar resolver o "colaborador espelho"
    colab: models.Colaborador | None = None
    if kind == "colaborador":
        colab = (
            db.query(models.Colaborador)
            .filter(
                models.Colaborador.id == identity.get("id"),
                models.Colaborador.empresa_id == empresa_id,
            )
            .first()
        )
    else:
        # logou como Usuario admin -> procurar colaborador espelho por usuario_id
        colab = (
            db.query(models.Colaborador)
            .filter(
                models.Colaborador.usuario_id == identity.get("id"),
                models.Colaborador.empresa_id == empresa_id,
            )
            .first()
        )

    # 2) Se achou colaborador: aplica a regra da tabela (sem bypass)
    if colab:
        rows = db.execute(
            text(
                """
                SELECT p.id
                  FROM colaboradores_permissoes cp
                  JOIN permissoes p ON p.id = cp.permissao_id
                 WHERE cp.colaborador_id = :cid
                 ORDER BY p.id
                """
            ),
            {"cid": colab.id},
        ).fetchall()
        return [r[0] for r in rows]

    # 3) Sem colaborador espelho:
    if is_admin:
        return _all_perm_ids()
    return []


# ===== Endpoints para ver/alterar permissões de um colaborador =====
@router.get("/colaboradores/{colab_id}", response_model=List[str])
def permissoes_do_colaborador(
    colab_id: int,
    user: models.Usuario = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    colab = db.query(models.Colaborador).get(colab_id)
    if not colab or colab.empresa_id != user.empresa_id:
        raise HTTPException(status_code=404, detail="Colaborador não encontrado")

    rows = db.execute(
        text(
            """
            SELECT permissao_id
              FROM colaboradores_permissoes
             WHERE colaborador_id = :cid
             ORDER BY permissao_id
            """
        ),
        {"cid": colab_id},
    ).fetchall()
    return [r[0] for r in rows]


class PermsUpdateBody(BaseModel):
    permissoes: List[str] = Field(default_factory=list)


@router.put("/colaboradores/{colab_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def salvar_permissoes_do_colaborador(
    colab_id: int,
    body: PermsUpdateBody = Body(...),
    user: models.Usuario = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    colab = db.query(models.Colaborador).get(colab_id)
    if not colab or colab.empresa_id != user.empresa_id:
        raise HTTPException(status_code=404, detail="Colaborador não encontrado")

    # valida ids
    ids = list(dict.fromkeys(body.permissoes))  # remove duplicados mantendo ordem
    valid = set(_all_perm_ids())
    for pid in ids:
        if pid not in valid:
            raise HTTPException(status_code=422, detail=f"Permissão inválida: {pid}")

    # garante que catálogo está no banco
    _sync_catalog_to_db(db)

    # sobrescreve permissões do colaborador
    with db.begin():
        db.execute(
            text("DELETE FROM colaboradores_permissoes WHERE colaborador_id = :cid"),
            {"cid": colab_id},
        )
        for pid in ids:
            db.execute(
                text(
                    """
                    INSERT INTO colaboradores_permissoes (colaborador_id, permissao_id)
                    VALUES (:cid, :pid)
                    """
                ),
                {"cid": colab_id, "pid": pid},
            )
    return

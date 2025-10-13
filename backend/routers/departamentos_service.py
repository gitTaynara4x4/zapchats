# backend/services/departamentos_service.py
from __future__ import annotations
from typing import Optional, Sequence
import re
from sqlalchemy.orm import Session
from sqlalchemy import select
from backend.models import Departamento  # ajuste o import

_slug_rx = re.compile(r"[^a-z0-9]+")
def _slug(s: str) -> str:
    s = (s or "").strip().lower()
    s = _slug_rx.sub("-", s).strip("-")
    return s or "dept"

def _frag(dep: Departamento) -> str:
    return (dep.codigo or _slug(dep.nome))[:64]

def _build_path(session: Session, dep: Departamento) -> list[str]:
    if dep.parent_id:
        parent = session.get(Departamento, dep.parent_id)
        if not parent:
            raise ValueError("parent_id inválido")
        base = parent.path or [_frag(parent)]
        return list(base) + [_frag(dep)]
    return [_frag(dep)]

def create_departamento(
    session: Session,
    empresa_id: int,
    nome: str,
    descricao: Optional[str] = None,
    parent_id: Optional[int] = None,
    codigo: Optional[str] = None,
    chefe_id: Optional[int] = None,
    ativo: bool = True,
) -> Departamento:
    dep = Departamento(
        empresa_id=empresa_id,
        nome=nome,
        descricao=descricao,
        parent_id=parent_id,
        codigo=codigo,
        chefe_id=chefe_id,
        ativo=ativo,
    )
    session.add(dep)
    session.flush()  # ganha ID
    dep.path = _build_path(session, dep)
    session.add(dep)
    session.commit()
    session.refresh(dep)
    return dep

def move_departamento(session: Session, dep_id: int, new_parent_id: Optional[int]) -> None:
    dep = session.get(Departamento, dep_id)
    if not dep:
        raise ValueError("Departamento não encontrado")

    # impede ciclo: novo pai não pode estar dentro do meu subtree
    if new_parent_id:
        new_parent = session.get(Departamento, new_parent_id)
        if not new_parent:
            raise ValueError("Novo parent inválido")
        if dep.path and new_parent.path and new_parent.path[:len(dep.path)] == dep.path:
            raise ValueError("Não pode mover para dentro do próprio subtree")

    old_path = dep.path or [_frag(dep)]
    dep.parent_id = new_parent_id
    session.flush()

    new_path = _build_path(session, dep)
    dep.path = new_path
    session.add(dep)

    # atualiza todos os descendentes (prefix match)
    children: Sequence[Departamento] = session.scalars(
        select(Departamento).where(
            Departamento.empresa_id == dep.empresa_id,
            Departamento.id != dep.id
        )
    ).all()
    for ch in children:
        if ch.path and ch.path[:len(old_path)] == old_path:
            suffix = ch.path[len(old_path):]
            ch.path = list(new_path) + list(suffix)
            session.add(ch)

    session.commit()

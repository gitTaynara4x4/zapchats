from __future__ import annotations

import argparse
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, or_, or_

from backend import models
from backend.database import SessionLocal
from backend.integrations.evolution.parsers.contact_parser import (
    filter_real_contacts,
    parse_contacts_payload,
)
from backend.integrations.evolution.parsers.chat_parser import (
    filter_direct_chats,
    parse_chats_payload,
)
from backend.integrations.evolution.repositories.instancias_repo import get_me_number_by_instancia
from backend.integrations.evolution.transport.evolution_http_client import EvolutionHttpClient
from backend.integrations.evolution.utils.phone_utils import (
    formatar_telefone_br,
    normalize_phone_for_db,
)


GENERIC_SELF_NAMES = {"eu", "voce", "você", "you", "me", "myself"}
GENERIC_CONTACT_NAMES = {
    "cliente",
    "contato",
    "sem nome",
    "desconhecido",
    "unknown",
    "whatsapp",
    "contato whatsapp",
    "contato do whatsapp",
    "0",
}
PROFILE_NAME_KEYS = {
    "pushname",
    "profilename",
    "profile_name",
    "notifyname",
    "verifiedname",
    "displayname",
    "businessname",
    "name",
}


@dataclass
class Stats:
    instancias: int = 0
    suspeitos: int = 0
    com_nome_real: int = 0
    corrigidos: int = 0
    fallback_telefone: int = 0
    sem_nome_real: int = 0
    identidades_limpas: int = 0
    erros: int = 0


def _clean(v: Any) -> str:
    return str(v or "").strip()


def _norm_name(v: Any) -> str:
    s = _clean(v)
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"\s+", " ", s).strip().casefold()
    return s


def _same_name(a: Any, b: Any) -> bool:
    na = _norm_name(a)
    nb = _norm_name(b)
    return bool(na and nb and na == nb)


def _only_digits(v: Any) -> str:
    return re.sub(r"\D+", "", _clean(v))


def _looks_like_phone_name(name: Any, phone: Any = None) -> bool:
    s = _clean(name)
    digits = _only_digits(s)
    if not s or not digits:
        return False
    if s == digits and len(digits) >= 10:
        return True
    phone_digits = _only_digits(phone)
    return bool(phone_digits and digits == phone_digits)


def _is_good_candidate(name: Any, *, aliases_norm: set[str], phone: Any = None) -> bool:
    s = _clean(name)
    n = _norm_name(s)
    if not s or not n:
        return False
    if n in aliases_norm or n in {_norm_name(x) for x in GENERIC_SELF_NAMES}:
        return False
    if n in {_norm_name(x) for x in GENERIC_CONTACT_NAMES}:
        return False
    if n.startswith("contato do whatsapp") or n.startswith("contato whatsapp") or n.startswith("contato lid"):
        return False
    if _looks_like_phone_name(s, phone):
        return False
    if s.isdigit() and len(s) >= 13:
        return False
    return True


def _iter_profile_name_values(obj: Any, *, depth: int = 0):
    if depth > 6:
        return
    if isinstance(obj, dict):
        for key, value in obj.items():
            key_norm = str(key or "").replace("-", "_").casefold()
            if key_norm in PROFILE_NAME_KEYS and isinstance(value, (str, int, float)):
                yield _clean(value)
            if isinstance(value, (dict, list)):
                yield from _iter_profile_name_values(value, depth=depth + 1)
    elif isinstance(obj, list):
        for item in obj:
            yield from _iter_profile_name_values(item, depth=depth + 1)


def _collect_self_aliases(inst, explicit: list[str]) -> list[str]:
    candidates: list[str] = []
    candidates.extend(explicit or [])
    candidates.append(_clean(getattr(inst, "perfil_nome_whatsapp", None)))

    raw = getattr(inst, "perfil_raw_json", None)
    if raw:
        candidates.extend(_iter_profile_name_values(raw))

    out: list[str] = []
    seen: set[str] = set()
    generic_norm = {_norm_name(x) for x in GENERIC_SELF_NAMES}

    for candidate in candidates:
        s = _clean(candidate)
        n = _norm_name(s)
        if not s or not n or n in generic_norm:
            continue
        # número/JID não é alias de nome
        if "@" in s or (s.isdigit() and len(s) >= 8):
            continue
        if n in seen:
            continue
        seen.add(n)
        out.append(s)

    return out


def _args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Diagnostica/corrige clientes cujo nome foi contaminado pelo nome "
            "do próprio WhatsApp conectado em mensagens fromMe=true."
        )
    )
    p.add_argument("--empresa-id", type=int, default=None)
    p.add_argument("--instancia-id", type=int, default=None)
    p.add_argument(
        "--nome-contaminado",
        action="append",
        default=[],
        help=(
            "Nome do perfil próprio que vazou para clientes. Pode repetir a opção. "
            "Ex.: --nome-contaminado Taynara"
        ),
    )
    p.add_argument(
        "--fallback-telefone",
        action="store_true",
        help=(
            "Quando não houver nome real confiável, troca o nome contaminado pelo "
            "telefone e limpa nome_whatsapp. Só é efetivado junto com --aplicar."
        ),
    )
    p.add_argument(
        "--aplicar",
        action="store_true",
        help="Grava as correções. Sem esta flag, roda em modo diagnóstico e faz rollback.",
    )
    return p.parse_args()


def _build_source_maps(evo: EvolutionHttpClient, inst, me_number: str | None, aliases_norm: set[str]):
    by_phone: dict[str, tuple[str, str, str | None]] = {}
    seen_alias_from_evo: set[str] = set()

    try:
        raw_contacts = evo.find_contacts(str(inst.instance_name))
        contacts = filter_real_contacts(
            parse_contacts_payload(
                raw_contacts,
                inst_name=str(inst.instance_name),
                empresa_id=int(inst.empresa_id),
                instancia_id=int(inst.id),
                me_number=me_number,
            )
        )
    except Exception as exc:
        contacts = []
        print(f"  ! aviso: findContacts falhou: {exc}")

    for item in contacts:
        tel_norm = normalize_phone_for_db(item.get("telefone"))
        name = _clean(item.get("nome"))
        if not tel_norm or not name:
            continue
        if _norm_name(name) in aliases_norm:
            seen_alias_from_evo.add(tel_norm)
            continue
        if _is_good_candidate(name, aliases_norm=aliases_norm, phone=item.get("telefone")):
            by_phone[tel_norm] = (name, "contatos", item.get("avatar_url"))

    try:
        raw_chats = evo.find_chats(str(inst.instance_name))
        chats = filter_direct_chats(
            parse_chats_payload(
                raw_chats,
                inst_name=str(inst.instance_name),
                empresa_id=int(inst.empresa_id),
                instancia_id=int(inst.id),
            )
        )
    except Exception as exc:
        chats = []
        print(f"  ! aviso: findChats falhou: {exc}")

    for item in chats:
        tel_norm = normalize_phone_for_db(item.get("telefone"))
        name = _clean(item.get("nome"))
        if not tel_norm or not name:
            continue
        if _norm_name(name) in aliases_norm:
            seen_alias_from_evo.add(tel_norm)
            continue
        if _is_good_candidate(name, aliases_norm=aliases_norm, phone=item.get("telefone")):
            by_phone.setdefault(tel_norm, (name, "chats", item.get("avatar_url")))

    return by_phone, seen_alias_from_evo


def _build_identity_maps(db, inst, aliases_norm: set[str]):
    by_client: dict[int, tuple[str, str, str | None]] = {}
    by_phone: dict[str, tuple[str, str, str | None]] = {}

    rows = (
        db.query(models.ContatoWhatsappIdentidade)
        .filter(
            models.ContatoWhatsappIdentidade.empresa_id == int(inst.empresa_id),
            models.ContatoWhatsappIdentidade.instancia_id == int(inst.id),
        )
        .all()
    )

    for row in rows:
        name = _clean(getattr(row, "push_name", None))
        tel_norm = normalize_phone_for_db(getattr(row, "telefone_norm", None))
        if not _is_good_candidate(name, aliases_norm=aliases_norm, phone=tel_norm):
            continue
        value = (name, "identidade", getattr(row, "profile_pic_url", None))
        cid = getattr(row, "cliente_id", None)
        if cid is not None:
            by_client.setdefault(int(cid), value)
        if tel_norm:
            by_phone.setdefault(tel_norm, value)

    return by_client, by_phone


def _clean_contaminated_identities(db, *, inst, cli, aliases_norm: set[str], replacement: str | None) -> int:
    q = db.query(models.ContatoWhatsappIdentidade).filter(
        models.ContatoWhatsappIdentidade.empresa_id == int(inst.empresa_id),
        models.ContatoWhatsappIdentidade.instancia_id == int(inst.id),
    )

    cid = getattr(cli, "id", None)
    tel_norm = normalize_phone_for_db(getattr(cli, "telefone", None))
    conditions = []
    if cid is not None:
        conditions.append(models.ContatoWhatsappIdentidade.cliente_id == int(cid))
    if tel_norm:
        conditions.append(models.ContatoWhatsappIdentidade.telefone_norm == tel_norm)
    if not conditions:
        return 0

    rows = q.filter(or_(*conditions)).all()
    changed = 0
    replacement_clean = _clean(replacement) or None

    for row in rows:
        current = _clean(getattr(row, "push_name", None))
        if _norm_name(current) not in aliases_norm:
            continue
        row.push_name = replacement_clean
        row.push_name_norm = _norm_name(replacement_clean) or None
        changed += 1

    return changed


def main() -> int:
    args = _args()
    stats = Stats()
    evo = EvolutionHttpClient()

    with SessionLocal() as db:
        q = db.query(models.EmpresaInstancia)
        if args.empresa_id is not None:
            q = q.filter(models.EmpresaInstancia.empresa_id == int(args.empresa_id))
        if args.instancia_id is not None:
            q = q.filter(models.EmpresaInstancia.id == int(args.instancia_id))

        instancias = q.order_by(models.EmpresaInstancia.id.asc()).all()
        if not instancias:
            print("[ZapsChat] Nenhuma instância encontrada para os filtros informados.")
            return 1

        print("[ZapsChat] REPARO DE NOMES DE CONTATOS / SELF-PUSHNAME V4")
        print(f"Modo: {'APLICAR' if args.aplicar else 'DIAGNÓSTICO (rollback)'}")
        if args.fallback_telefone:
            print("Fallback sem nome real: TELEFONE")

        for inst in instancias:
            aliases = _collect_self_aliases(inst, list(args.nome_contaminado or []))
            aliases_norm = {_norm_name(x) for x in aliases if _norm_name(x)}

            if not aliases_norm:
                print(
                    f"- Instância #{inst.id} {inst.instance_name}: sem alias confiável do perfil; "
                    "use --nome-contaminado NOME."
                )
                continue

            stats.instancias += 1
            me_number = get_me_number_by_instancia(inst)
            me_norm = normalize_phone_for_db(me_number) if me_number else None

            print(
                f"\n- Instância #{inst.id} {inst.instance_name}: "
                f"aliases={', '.join(repr(x) for x in aliases)}"
            )

            # O que aparece na lista vem de Cliente.nome. Não exigimos mais que
            # nome_whatsapp também esteja contaminado; essa exigência fazia vários
            # registros 'Taynara' escaparem do reparo anterior.
            # A lista lateral NÃO depende somente de Cliente.instancia_id.
            # Ela usa Mensagem.instancia_id para montar cada conversa. Há clientes
            # antigos com Cliente.instancia_id nulo/desatualizado que aparecem na
            # instância normalmente e, por isso, escapavam do V3.
            msg_clientes_da_instancia = (
                db.query(models.Mensagem.cliente_id)
                .filter(
                    models.Mensagem.empresa_id == int(inst.empresa_id),
                    models.Mensagem.instancia_id == int(inst.id),
                    models.Mensagem.cliente_id.isnot(None),
                )
                .distinct()
            )

            suspects = (
                db.query(models.Cliente)
                .filter(
                    models.Cliente.empresa_id == int(inst.empresa_id),
                    or_(
                        models.Cliente.instancia_id == int(inst.id),
                        models.Cliente.id.in_(msg_clientes_da_instancia),
                    ),
                    func.lower(func.trim(func.coalesce(models.Cliente.nome, ""))).in_(
                        [x.casefold() for x in aliases]
                    ),
                )
                .order_by(models.Cliente.id.asc())
                .all()
            )

            if me_norm:
                suspects = [
                    cli
                    for cli in suspects
                    if normalize_phone_for_db(getattr(cli, "telefone", None)) != me_norm
                ]

            if not suspects:
                print("  nenhum cliente visível com esses nomes.")
                continue

            stats.suspeitos += len(suspects)
            source_by_phone, alias_confirmed_by_evo = _build_source_maps(
                evo, inst, me_number, aliases_norm
            )
            identity_by_client, identity_by_phone = _build_identity_maps(db, inst, aliases_norm)

            fixed_here = 0
            missing_here = 0

            for cli in suspects:
                tel_norm = normalize_phone_for_db(getattr(cli, "telefone", None))
                current_nome = _clean(getattr(cli, "nome", None))
                current_wa = _clean(getattr(cli, "nome_whatsapp", None))

                found: tuple[str, str, str | None] | None = None

                # Se nome_whatsapp já tem um nome diferente do alias, ele é a
                # primeira fonte local segura para reparar o nome visível.
                if _is_good_candidate(current_wa, aliases_norm=aliases_norm, phone=getattr(cli, "telefone", None)):
                    found = (current_wa, "nome_whatsapp_db", getattr(cli, "avatar_url", None))

                if not found:
                    found = identity_by_client.get(int(cli.id))
                if not found and tel_norm:
                    found = identity_by_phone.get(tel_norm)
                if not found and tel_norm:
                    found = source_by_phone.get(tel_norm)

                candidate = _clean(found[0]) if found else ""
                source = found[1] if found else "-"
                candidate_avatar = found[2] if found else None
                evo_same_alias = bool(tel_norm and tel_norm in alias_confirmed_by_evo)

                action = "sem_nome_real"
                if candidate:
                    action = "corrigir"
                elif args.fallback_telefone:
                    action = "telefone"

                print(
                    f"  cliente #{cli.id} tel={getattr(cli, 'telefone', '')!s} "
                    f"nome={current_nome!r} nome_whatsapp={current_wa!r} "
                    f"candidato={candidate!r} fonte={source} "
                    f"evolution_alias={'sim' if evo_same_alias else 'nao'} ação={action}"
                )

                if candidate:
                    stats.com_nome_real += 1
                    cli.nome = candidate
                    cli.nome_whatsapp = candidate
                    if candidate_avatar and not getattr(cli, "avatar_url", None):
                        cli.avatar_url = candidate_avatar
                    stats.identidades_limpas += _clean_contaminated_identities(
                        db,
                        inst=inst,
                        cli=cli,
                        aliases_norm=aliases_norm,
                        replacement=candidate,
                    )
                    fixed_here += 1
                    stats.corrigidos += 1
                    continue

                if args.fallback_telefone:
                    # Não inventa outro nome. Remove o nome errado e deixa o
                    # número visível até o WhatsApp fornecer um nome confiável.
                    phone_label = formatar_telefone_br(getattr(cli, "telefone", None)) or _clean(getattr(cli, "telefone", None)) or "Cliente"
                    cli.nome = phone_label
                    if _norm_name(current_wa) in aliases_norm:
                        cli.nome_whatsapp = None
                    stats.identidades_limpas += _clean_contaminated_identities(
                        db,
                        inst=inst,
                        cli=cli,
                        aliases_norm=aliases_norm,
                        replacement=None,
                    )
                    fixed_here += 1
                    stats.corrigidos += 1
                    stats.fallback_telefone += 1
                    continue

                missing_here += 1
                stats.sem_nome_real += 1

            print(
                f"  resumo instância: suspeitos={len(suspects)} "
                f"corrigíveis={fixed_here} sem_nome_real={missing_here}"
            )

        if args.aplicar:
            try:
                db.commit()
            except Exception as exc:
                db.rollback()
                stats.erros += 1
                print(f"\nERRO NO COMMIT: {exc}")
                return 2
        else:
            db.rollback()

    print("\nResumo geral:")
    print(f"  Instâncias analisadas: {stats.instancias}")
    print(f"  Clientes suspeitos: {stats.suspeitos}")
    print(f"  Nomes reais encontrados: {stats.com_nome_real}")
    print(f"  Correções planejadas/feitas: {stats.corrigidos}")
    print(f"  Fallback para telefone: {stats.fallback_telefone}")
    print(f"  Sem nome real: {stats.sem_nome_real}")
    print(f"  Identidades contaminadas limpas: {stats.identidades_limpas}")
    print(f"  Erros: {stats.erros}")

    if not args.aplicar:
        print("\nNada foi gravado. Revise as linhas acima antes de usar --aplicar.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations
import enum
from datetime import datetime, timezone
from sqlalchemy.schema import FetchedValue
from sqlalchemy import JSON
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, TIMESTAMP, func,
    ForeignKey, UniqueConstraint, Boolean, LargeBinary, Index, BigInteger, text
)

from sqlalchemy import Enum as SqlEnum
from sqlalchemy.orm import relationship, backref  # ← adicionado backref
from sqlalchemy import Column, Integer, Boolean, Time, Text
from sqlalchemy.dialects.postgresql import JSONB
# ✅ Tipos específicos do Postgres
from sqlalchemy.dialects.postgresql import UUID as PG_UUID, ARRAY as PG_ARRAY

from backend.database import Base
from backend.utils.plans import PLAN_LIMITS  # fonte única de limites


# =========================
# Planos e helpers
# =========================
class PlanoAssinatura(str, enum.Enum):
    PRATA      = "PRATA"
    OURO       = "OURO"
    PLATINA    = "PLATINA"
    DIAMANTE   = "DIAMANTE"
    ASCENDENTE = "ASCENDENTE"
    IMORTAL    = "IMORTAL"
    RADIANTE   = "RADIANTE"


def max_instancias_por_plano(plano: str | None) -> int:
    """Evita duplicar números: usa os limites do módulo plans."""
    return PLAN_LIMITS.get((plano or "FREE").upper(), 0)


# =========================
# Enum para Status do Atendimento
# =========================
class StatusAtendimento(str, enum.Enum):
    NOVO = "novo"
    AGUARDANDO = "aguardando"
    EM_ATENDIMENTO = "em_atendimento"
    PAUSADO = "pausado"
    RESOLVIDO = "resolvido"
    TRANSFERIDO = "transferido"


# =========================
# Empresa
# =========================
class Empresa(Base):
    __tablename__ = "empresas"

    id       = Column(Integer, primary_key=True, index=True)
    nome     = Column(String, nullable=False)
    telefone = Column(String, nullable=False)

    # Plano atual selecionado (pago ou FREE)
    assinatura = Column(String, nullable=False, server_default="FREE")

    # Trial opcional (ex.: PRATA por 7 dias)
    trial_tier       = Column(String, nullable=True)
    trial_expires_at = Column(TIMESTAMP(timezone=True), nullable=True)

    # ✅ Validade do plano PAGO (se estiver setado e no futuro, o pago prevalece)
    plano_expira_em  = Column(TIMESTAMP(timezone=True), nullable=True)

    quantidade_instancias = Column(Integer, nullable=False, server_default="0")

    avatar_url    = Column(Text)
    status_numero = Column(String)
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now())
    nome_adm      = Column(String, nullable=True, default=None)

    cnpj_cpf = Column(String, nullable=True, index=True)

    # relacionamentos
    clientes        = relationship("Cliente", back_populates="empresa", cascade="all, delete-orphan")
    usuarios        = relationship("Usuario", back_populates="empresa", cascade="all, delete-orphan")
    departamentos   = relationship("Departamento", back_populates="empresa", cascade="all, delete-orphan")
    setores         = relationship("Setor", back_populates="empresa", cascade="all, delete-orphan")
    colaboradores   = relationship("Colaborador", back_populates="empresa", cascade="all, delete-orphan")
    midias          = relationship("Midia", back_populates="empresa", cascade="all, delete-orphan")
    grupos          = relationship("Grupo", back_populates="empresa", cascade="all, delete-orphan")
    mensagens_grupo = relationship("MensagemGrupo", back_populates="empresa", cascade="all, delete-orphan")

    instancias = relationship(
        "EmpresaInstancia",
        back_populates="empresa",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    # ---------- Helpers de plano ----------

    @property
    def plano(self) -> str:
        """Alias para compat: lê o campo `assinatura`."""
        return (self.assinatura or "FREE").upper()

    @plano.setter
    def plano(self, value: str) -> None:
        """Alias para compat: escreve no campo `assinatura`."""
        self.assinatura = (value or "FREE").upper()

    @property
    def trial_active(self) -> bool:
        return bool(
            self.trial_tier
            and self.trial_expires_at
            and datetime.now(timezone.utc) < self.trial_expires_at
        )

    @property
    def paid_active(self) -> bool:
        """
        Considera ativo se assinatura != FREE e:
          - plano_expira_em é NULL (sem expiração) OU
          - plano_expira_em ainda não passou.
        """
        if (self.assinatura or "FREE").upper() == "FREE":
            return False
        if not self.plano_expira_em:
            return True
        return datetime.now(timezone.utc) < self.plano_expira_em

    @property
    def effective_tier(self) -> str:
        """
        Prioridade: PAGO > TRIAL > FREE
        """
        if self.paid_active:
            return (self.assinatura or "FREE").upper()
        if self.trial_active:
            return str(self.trial_tier).upper()
        return "FREE"


# =========================
# EmpresaInstancia (multi-whatsapp por empresa)

class EmpresaInstancia(Base):
    __tablename__ = "empresas_instancias"

    id = Column(Integer, primary_key=True)
    empresa_id = Column(Integer, ForeignKey("empresas.id", ondelete="CASCADE"), nullable=False)

    # identificador/slug interno da instância no Evolution
    instance_name = Column(String, nullable=False, index=True, unique=True)

    apelido = Column(String, nullable=True)
    numero_instancia = Column(String, nullable=True)

    connected  = Column(Boolean, nullable=False, server_default="false")
    last_seen  = Column(TIMESTAMP(timezone=True), nullable=True)

    # preferências de histórico: "none" | "24h" | "7d"
    historico_restaurar = Column(String, nullable=True, server_default="none")

    # ── relationships
    empresa = relationship("Empresa", back_populates="instancias")

    mensagens = relationship(
        "Mensagem",
        back_populates="instancia",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    grupos = relationship(
        "Grupo",
        back_populates="instancia",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    mensagens_grupo = relationship(
        "MensagemGrupo",
        back_populates="instancia",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    # vínculo 1:N com configurações do chatbot
    chatbot_configs = relationship(
        "ChatbotConfig",
        back_populates="instancia",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    # N:N via pivot com departamentos
    dep_instancias = relationship(
        "DepartamentoInstancia",
        back_populates="instancia",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return f"<EmpresaInstancia id={self.id} emp={self.empresa_id} inst={self.instance_name!r}>"

# =========================
# Cliente
# =========================
class Cliente(Base):
    __tablename__ = "clientes"
    __table_args__ = (
        UniqueConstraint("empresa_id", "telefone", "instancia_id", name="u_empresa_cli_inst"),
        Index("ix_clientes_empresa_inst", "empresa_id", "instancia_id"),
        Index("ix_clientes_tel_norm", "telefone_norm"),  # índice p/ buscas por número normalizado
    )

    id           = Column(Integer, primary_key=True, index=True)
    empresa_id   = Column(Integer, ForeignKey("empresas.id"), nullable=False)

    instancia_id = Column(
        Integer,
        ForeignKey("empresas_instancias.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    colaborador_id = Column(
        Integer,
        ForeignKey("colaboradores.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # dados básicos
    nome          = Column(String, default="Cliente")
    telefone      = Column(String, nullable=False)

    # IMPORTANTE: coluna gerada no banco → nunca enviar valor no INSERT/UPDATE
    telefone_norm = Column(
        String,                      # ou Text, se no seu DDL for TEXT
        nullable=False,              # ajuste conforme seu DDL
        server_default=FetchedValue(),
        server_onupdate=FetchedValue(),
    )

    departamento  = Column(String)
    avatar_url    = Column(Text)
    timestamp     = Column(TIMESTAMP(timezone=True), server_default=func.now())

    # informações de WhatsApp/Evolution
    nome_whatsapp   = Column(String)
    is_business     = Column(Boolean, default=False)
    status_whatsapp = Column(String)

    # anotações e perfis públicos
    sobre_cliente = Column(Text)
    descricao     = Column(Text)
    website       = Column(String)

    # contato/documentos
    cpf_cnpj = Column(String)
    rg       = Column(String)
    email    = Column(String)

    # dados pessoais/endereço
    data_nascimento = Column(DateTime)
    genero          = Column(String)
    cep             = Column(String)
    endereco        = Column(String)
    numero          = Column(String)
    complemento     = Column(String)
    bairro          = Column(String)
    cidade          = Column(String)
    estado          = Column(String)
    nome_completo   = Column(String)

    # relacionamentos
    empresa   = relationship("Empresa", back_populates="clientes")
    mensagens = relationship("Mensagem", back_populates="cliente", cascade="all, delete-orphan")
    midias    = relationship("Midia", back_populates="cliente", cascade="all, delete-orphan")

    # (opcional) facilita trazer o nome do colaborador no join
    colaborador = relationship("Colaborador", foreign_keys=[colaborador_id])

    departamento_id = Column(
        Integer,
        ForeignKey("departamentos.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    departamento_rel = relationship("Departamento") 

# =========================
# Mensagem (1:1)
# =========================
class Mensagem(Base):
    __tablename__ = "mensagens"
    __table_args__ = (
        # ⚠️ Garante idempotência por instância + msg_id
        UniqueConstraint("instancia_id", "msg_id", name="uq_mensagens_inst_msgid"),
        Index("ix_mensagens_msg_id", "msg_id"),
        Index("ix_mensagens_empresa_cliente_ts", "empresa_id", "cliente_id", "timestamp"),
    )

    id          = Column(Integer, primary_key=True, index=True)
    empresa_id  = Column(Integer, ForeignKey("empresas.id"), nullable=False, index=True)
    cliente_id  = Column(Integer, ForeignKey("clientes.id"),  nullable=False, index=True)

    instancia_id = Column(
        Integer,
        ForeignKey("empresas_instancias.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    conteudo    = Column(Text,    nullable=False)
    tipo        = Column(String,  nullable=False)  # 'entrada' | 'saida'
    lida        = Column(Boolean, default=False)
    timestamp   = Column(TIMESTAMP(timezone=True), server_default=func.now())

    msg_id      = Column(String, index=True)  # id do Baileys/Evolution (pode ser NULL em casos raros)
    ack         = Column(Integer, default=0)

    cliente   = relationship("Cliente", back_populates="mensagens")
    instancia = relationship("EmpresaInstancia", back_populates="mensagens")

    def __repr__(self) -> str:
        return f"<Mensagem id={self.id} cli={self.cliente_id} inst={self.instancia_id} tipo={self.tipo} ts={self.timestamp}>"


# =========================
# Midia
# =========================
class Midia(Base):
    __tablename__ = "midias"
    __table_args__ = (
        # ⚠️ Evita duplicar a mesma mídia da mesma mensagem (quando tivermos hash)
        UniqueConstraint("mensagem_id", "file_sha256", name="uq_midias_msg_sha"),
        # Opcional (Postgres): fallback quando não houver hash -> único por (msg, filename, tamanho) *apenas* quando file_sha256 é NULL
        Index(
            "uq_midias_msg_fn_size_nullsha",
            "mensagem_id", "filename", "tamanho",
            unique=True,
            postgresql_where=text("file_sha256 IS NULL")
        ),
        Index("ix_midias_instancia", "instancia_id"),
    )

    id            = Column(Integer, primary_key=True, index=True)
    empresa_id    = Column(Integer, ForeignKey("empresas.id"))
    cliente_id    = Column(Integer, ForeignKey("clientes.id"))
    mensagem_id   = Column(Integer, ForeignKey("mensagens.id"))
    instancia_id  = Column(Integer, ForeignKey("empresas_instancias.id", ondelete="SET NULL"), index=True, nullable=True)

    tipo          = Column(String)         # image / audio / document / video / sticker
    filename      = Column(String)
    mimetype      = Column(String)
    nome_original = Column(String)

    url           = Column(String)
    local_path    = Column(String)
    data          = Column(LargeBinary)
    tamanho       = Column(Integer)
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now())
    page_count    = Column(Integer)

    file_sha256     = Column(Text)  # hash do arquivo (quando disponível)
    file_enc_sha256 = Column(Text)  # hash do conteúdo criptografado (se aplicável)

    empresa   = relationship("Empresa", back_populates="midias")
    cliente   = relationship("Cliente", back_populates="midias")
    mensagem  = relationship("Mensagem", foreign_keys=[mensagem_id])


# =========================
# Grupo
# =========================
class Grupo(Base):
    __tablename__ = "grupos"
    __table_args__ = (
        UniqueConstraint("empresa_id", "remote_jid", name="u_empresa_grupo"),
        Index("ix_grupos_empresa", "empresa_id"),
        Index("ix_grupos_instancia", "empresa_id", "instancia_id"),
    )

    id            = Column(BigInteger, primary_key=True, index=True)
    empresa_id    = Column(Integer, ForeignKey("empresas.id"), nullable=False)
    instancia_id  = Column(Integer, ForeignKey("empresas_instancias.id", ondelete="SET NULL"), nullable=True)
    remote_jid    = Column(Text, nullable=False)
    nome          = Column(Text)
    avatar_url    = Column(Text)
    descricao     = Column(Text)
    criado_em     = Column(TIMESTAMP(timezone=True), server_default=func.now())
    atualizado_em = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())

    empresa   = relationship("Empresa", back_populates="grupos")
    mensagens = relationship("MensagemGrupo", back_populates="grupo", cascade="all, delete-orphan")
    instancia = relationship("EmpresaInstancia", back_populates="grupos")


# =========================
# Mensagem de Grupo
# =========================
class MensagemGrupo(Base):
    __tablename__ = "mensagens_grupo"
    __table_args__ = (
        UniqueConstraint("msg_id", name="u_msg_grupo_msgid"),
        Index("ix_msggrupo_grupo_ts", "grupo_id", "timestamp"),
        Index("ix_msggrupo_empresa", "empresa_id"),
        Index("ix_msggrupo_author", "author_jid"),
        Index("ix_msggrupo_instancia", "empresa_id", "instancia_id"),
    )

    id           = Column(BigInteger, primary_key=True, index=True)
    empresa_id   = Column(Integer, ForeignKey("empresas.id"), nullable=False)
    grupo_id     = Column(BigInteger, ForeignKey("grupos.id"), nullable=False)

    instancia_id = Column(
        Integer,
        ForeignKey("empresas_instancias.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    author_jid   = Column(Text)
    from_me      = Column(Boolean, default=False)
    conteudo     = Column(Text)
    tipo         = Column(Text)
    message_type = Column(Text)
    lida         = Column(Boolean, default=False)
    timestamp    = Column(BigInteger)               # epoch
    msg_id       = Column(Text, nullable=False)
    ack          = Column(Integer, default=0)
    criado_em    = Column(TIMESTAMP(timezone=True), server_default=func.now())

    empresa   = relationship("Empresa", back_populates="mensagens_grupo")
    grupo     = relationship("Grupo", back_populates="mensagens")
    instancia = relationship("EmpresaInstancia", back_populates="mensagens_grupo")

# =========================
# Departamento
# =========================

class Departamento(Base):
    __tablename__ = "departamentos"

    id         = Column(Integer, primary_key=True, index=True)
    empresa_id = Column(Integer, ForeignKey("empresas.id", ondelete="CASCADE"), nullable=False, index=True)

    nome      = Column(String(80), nullable=False)
    descricao = Column(Text, nullable=True)

    # hierarquia / organização
    parent_id = Column(Integer, ForeignKey("departamentos.id", ondelete="RESTRICT"), nullable=True, index=True)
    codigo    = Column(String(64), nullable=True)                     # ex.: "FIN", "TI-SUP"
    path      = Column(PG_ARRAY(String), nullable=True)               # ex.: ["empresa","ti","suporte"]
    chefe_id  = Column(Integer, nullable=True)                        # FK para usuarios.id (quando houver)
    ativo     = Column(Boolean, nullable=False, server_default="true")

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    empresa = relationship("Empresa", back_populates="departamentos")

    # árvore
    parent   = relationship("Departamento", remote_side=[id], backref=backref("children", cascade="all"))
    usuarios = relationship("Usuario", back_populates="departamento", cascade="all, delete-orphan")

    # 👇 vínculo N:N (via pivot) com instâncias do WhatsApp
    dep_instancias = relationship(
        "DepartamentoInstancia",
        back_populates="departamento",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        UniqueConstraint("empresa_id", "nome",   name="uq_departamentos_empresa_nome"),
        UniqueConstraint("empresa_id", "codigo", name="uq_departamentos_empresa_codigo"),
    )

    def __repr__(self) -> str:
        return f"<Departamento id={self.id} emp={self.empresa_id} nome={self.nome!r}>"


# =========================
# Pivot: Departamento <-> EmpresaInstancia
# =========================
class DepartamentoInstancia(Base):
    __tablename__ = "departamentos_instancias"
    __table_args__ = (
        UniqueConstraint("empresa_id", "departamento_id", "instancia_id", name="uq_depinst_emp_dep_inst"),
        Index("ix_depinst_dep", "departamento_id"),
        Index("ix_depinst_inst", "instancia_id"),
        Index("ix_depinst_empdep", "empresa_id", "departamento_id"),
    )

    id              = Column(Integer, primary_key=True, index=True)
    empresa_id      = Column(Integer, nullable=False, index=True)  # (sem FK na sua DDL, mantido assim)
    departamento_id = Column(Integer, ForeignKey("departamentos.id", ondelete="CASCADE"), nullable=False, index=True)
    instancia_id    = Column(Integer, ForeignKey("empresas_instancias.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())

    # relacionamentos para navegar em ORM
    departamento = relationship("Departamento", back_populates="dep_instancias")
    instancia    = relationship("EmpresaInstancia", back_populates="dep_instancias")

    def __repr__(self):
        return f"<DepartamentoInstancia emp={self.empresa_id} dep={self.departamento_id} inst={self.instancia_id}>"

class AtendimentoPinnedConversa(Base):
    __tablename__ = "atendimento_pinned_conversas"
    __table_args__ = (
        # PK composta: 1 linha por (empresa, usuário, conversa)
        UniqueConstraint("empresa_id", "user_id", "conversa_id", name="pk_pinned_emp_user_conv"),
        Index("ix_pinned_user", "empresa_id", "user_id"),
        Index("ix_pinned_conv", "empresa_id", "conversa_id"),
    )

    empresa_id  = Column(Integer, ForeignKey("empresas.id",  ondelete="CASCADE"), nullable=False, primary_key=True)
    user_id     = Column(Integer, ForeignKey("usuarios.id",  ondelete="CASCADE"), nullable=False, primary_key=True)
    conversa_id = Column(Integer, ForeignKey("clientes.id",  ondelete="CASCADE"), nullable=False, primary_key=True)

    pinned_at   = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    # relacionamentos (opcionais, mas úteis pra joins/debug)
    empresa  = relationship("Empresa")
    usuario  = relationship("Usuario")
    conversa = relationship("Cliente")

    def __repr__(self) -> str:
        return f"<Pinned emp={self.empresa_id} user={self.user_id} conv={self.conversa_id}>"
    
    
# =========================
# Setor
# =========================
class Setor(Base):
    __tablename__ = "setores"

    id         = Column(Integer, primary_key=True, index=True)
    nome       = Column(String(60), nullable=False)
    empresa_id = Column(Integer, ForeignKey('empresas.id'), nullable=False)

    empresa       = relationship("Empresa", back_populates="setores")
    colaboradores = relationship("Colaborador", back_populates="setor")


# =========================
# Colaborador
# =========================
class Colaborador(Base):
    __tablename__ = "colaboradores"

    id         = Column(Integer, primary_key=True, index=True)
    empresa_id = Column(Integer, ForeignKey('empresas.id'), nullable=False)
    setor_id   = Column(Integer, ForeignKey('setores.id'), nullable=True)
    usuario_id = Column(Integer, ForeignKey('usuarios.id'), nullable=True)  # opcional

    nome       = Column(String(60), nullable=False)
    email      = Column(String(120), nullable=False, unique=True)
    senha      = Column(String(200), nullable=False)
    telefone   = Column(String(20), nullable=True)
    cargo      = Column(String(50), nullable=True)

    empresa = relationship("Empresa", back_populates="colaboradores")
    setor   = relationship("Setor", back_populates="colaboradores")
    usuario = relationship("Usuario")  # opcional

    # Many-to-many com Permissao
    permissoes = relationship(
        "Permissao",
        secondary="colaboradores_permissoes",
        back_populates="colaboradores",
        lazy="joined",
    )
    instancias_ver = Column(PG_ARRAY(Integer), nullable=True)

# =========================
# Usuario
# =========================
class Usuario(Base):
    __tablename__ = "usuarios"

    id              = Column(Integer, primary_key=True, index=True)
    empresa_id      = Column(Integer, ForeignKey("empresas.id"))
    departamento_id = Column(Integer, ForeignKey("departamentos.id"), nullable=True)
    nome            = Column(String, nullable=False)
    email           = Column(String, unique=True, index=True, nullable=False)
    senha_hash      = Column(String, nullable=False)
    cargo           = Column(String)
    is_admin        = Column(Boolean, default=False)
    avatar_data     = Column(LargeBinary)
    avatar_mime     = Column(String)

    reset_token        = Column(String, nullable=True)
    reset_token_expira = Column(TIMESTAMP(timezone=True), nullable=True)

    empresa      = relationship("Empresa", back_populates="usuarios")
    departamento = relationship("Departamento", back_populates="usuarios")


# =========================
# Atendimentos
# =========================
class Atendimento(Base):
    __tablename__ = "atendimentos"

    id           = Column(Integer, primary_key=True)
    cliente_id   = Column(Integer, index=True)
    operador_id  = Column(Integer, index=True)

    instancia_id = Column(
        Integer,
        ForeignKey("empresas_instancias.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    criado_em    = Column(TIMESTAMP(timezone=True), server_default=func.now())

    status = Column(
        SqlEnum(
            StatusAtendimento,
            name="statusatendimento",                          # nome do tipo ENUM já existente no PG
            values_callable=lambda enum_cls: [e.value for e in enum_cls],  # usa os values (minúsculos)
            native_enum=True,
        ),
        default=StatusAtendimento.NOVO,
        nullable=False,
    )

# =========================
# Permissao
# =========================
class Permissao(Base):
    __tablename__ = "permissoes"

    id   = Column(String, primary_key=True)  # ex.: "clientes.ver"
    nome = Column(String, nullable=False)

    colaboradores = relationship(
        "Colaborador",
        secondary="colaboradores_permissoes",
        back_populates="permissoes",
    )


# =========================
# Associação Colaborador <-> Permissão
# =========================
class ColaboradorPermissao(Base):
    __tablename__ = "colaboradores_permissoes"

    colaborador_id = Column(Integer, ForeignKey("colaboradores.id", ondelete="CASCADE"), primary_key=True)
    permissao_id   = Column(String,  ForeignKey("permissoes.id",     ondelete="CASCADE"), primary_key=True)
    criado_em      = Column(TIMESTAMP(timezone=True), server_default=func.now())


# =========================
# ChatbotConfig  (por instancia_id)
# =========================

# =========================
# ChatbotConfig (por instancia_id)
# =========================
class ChatbotConfig(Base):
    __tablename__ = "chatbot_configs"

    id = Column(Integer, primary_key=True)
    empresa_id   = Column(Integer, ForeignKey("empresas.id", ondelete="CASCADE"), nullable=False, index=True)
    instancia_id = Column(Integer, ForeignKey("empresas_instancias.id", ondelete="CASCADE"), nullable=False, index=True)

    ativo = Column(Boolean, nullable=False, server_default="true")

    # ✔️ UMA única tz, NOT NULL + default
    tz = Column(String(64), nullable=False, server_default="Etc/UTC")

    welcome_enabled = Column(Boolean, default=True)
    welcome_start   = Column(Time, nullable=True)
    welcome_end     = Column(Time, nullable=True)

    off_enabled     = Column(Boolean, default=False)
    off_start       = Column(Time, nullable=True)
    off_end         = Column(Time, nullable=True)

    config = Column(JSONB, default=dict)

    instancia = relationship("EmpresaInstancia", back_populates="chatbot_configs")
    empresa   = relationship("Empresa", backref=backref("chatbot_configs", cascade="all, delete-orphan"))

    __table_args__ = (
        UniqueConstraint("empresa_id", "instancia_id", name="uq_chatbot_conf_emp_inst"),
    )

# =======================================================
# Chat Interno — MODELO (1 tabela + estado de leitura)
# =======================================================
class ChatKind(str, enum.Enum):
    HEAD   = "head"     # criação da thread + participantes atuais
    MSG    = "msg"      # mensagem normal
    SYSTEM = "system"   # eventos do sistema (opcional)
    RENAME = "rename"   # renome da thread
    JOIN   = "join"     # entrou participante
    LEAVE  = "leave"    # saiu participante


class ChatEvento(Base):
    """
    Tabela única de eventos do chat interno.
    Bate com o SQL já criado (chat_eventos).
    """
    __tablename__ = "chat_eventos"
    __table_args__ = (
        Index("idx_chat_eventos_emp_created", "empresa_id", "created_at"),
        Index("idx_chat_eventos_thread_created", "thread_id", "created_at"),
        Index("idx_chat_eventos_participantes", "participantes", postgresql_using="gin"),
    )

    id           = Column(BigInteger, primary_key=True)                       # bigserial
    empresa_id   = Column(Integer, ForeignKey("empresas.id", ondelete="CASCADE"), nullable=False, index=True)
    thread_id    = Column(PG_UUID(as_uuid=False), nullable=False, index=True) # UUID (string)
    kind         = Column(SqlEnum(ChatKind), nullable=False)                  # 'head' | 'msg' | ...
    autor_id     = Column(Integer, ForeignKey("colaboradores.id", ondelete="SET NULL"), nullable=True, index=True)

    # Para eventos 'head' e 'participants' (lista dos IDs de colaboradores na conversa)
    participantes = Column(PG_ARRAY(Integer), nullable=True)

    # Payloads opcionais
    texto       = Column(Text, nullable=True)     # corpo da mensagem
    titulo      = Column(String(200), nullable=True)

    created_at  = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False, index=True)
    deleted_at  = Column(TIMESTAMP(timezone=True), nullable=True)

    empresa = relationship("Empresa")
    autor   = relationship("Colaborador", foreign_keys=[autor_id])


class ChatReadState(Base):
    """
    Estado de leitura por usuário: último 'created_at' lido por (empresa, thread, user).
    """
    __tablename__ = "chat_read_state"
    __table_args__ = (
        UniqueConstraint("empresa_id", "thread_id", "user_id", name="pk_chat_read_state"),
        Index("idx_read_state_user", "empresa_id", "user_id"),
    )

    empresa_id   = Column(Integer, ForeignKey("empresas.id", ondelete="CASCADE"), nullable=False, primary_key=True)
    thread_id    = Column(PG_UUID(as_uuid=False), nullable=False, primary_key=True)
    user_id      = Column(Integer, ForeignKey("colaboradores.id", ondelete="CASCADE"), nullable=False, primary_key=True)

    last_read_at = Column(TIMESTAMP(timezone=True), nullable=True)

    empresa = relationship("Empresa")
    user    = relationship("Colaborador")


# ======================================================
# Organização: Membros e ACL por Departamento
# ======================================================
class DepartamentoMembro(Base):
    __tablename__ = "departamentos_membros"

    id = Column(Integer, primary_key=True, index=True)
    empresa_id      = Column(Integer, nullable=False, index=True)
    departamento_id = Column(Integer, ForeignKey("departamentos.id", ondelete="CASCADE"), nullable=False, index=True)
    colaborador_id  = Column(Integer, nullable=False, index=True)  # -> colaboradores.id (ou usuarios.id)
    role            = Column(String(32), nullable=False, server_default="member")  # 'head','manager','member','viewer'
    is_primary      = Column(Boolean, nullable=False, server_default="false")

    departamento = relationship("Departamento", backref=backref("membros", cascade="all, delete-orphan"))

    __table_args__ = (
        UniqueConstraint("empresa_id", "departamento_id", "colaborador_id", name="uq_dep_membro"),
    )

    def __repr__(self) -> str:
        return f"<DepartamentoMembro dep={self.departamento_id} colab={self.colaborador_id} role={self.role}>"


class DepartamentoACL(Base):
    __tablename__ = "departamentos_acl"

    id = Column(Integer, primary_key=True, index=True)
    empresa_id      = Column(Integer, nullable=False, index=True)
    departamento_id = Column(Integer, ForeignKey("departamentos.id", ondelete="CASCADE"), nullable=False, index=True)

    resource = Column(String(64), nullable=False)                 # 'clientes','atendimentos','financeiro','midias', ...
    action   = Column(String(32), nullable=False)                 # 'view','create','edit','delete','export','assign'
    scope    = Column(String(32), nullable=False, server_default="own")  # 'own','department','subtree','company'
    effect   = Column(Boolean, nullable=False)                    # True=ALLOW, False=DENY

    departamento = relationship("Departamento", backref=backref("acls", cascade="all, delete-orphan"))

    __table_args__ = (
        UniqueConstraint("empresa_id", "departamento_id", "resource", "action", "scope", name="uq_dep_acl"),
    )

    def __repr__(self) -> str:
        ef = "ALLOW" if self.effect else "DENY"
        return f"<DepartamentoACL dep={self.departamento_id} {self.resource}.{self.action} {self.scope}={ef}>"

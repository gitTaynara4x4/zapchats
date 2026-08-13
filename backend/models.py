from __future__ import annotations

import enum
from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, String, Text, DateTime, TIMESTAMP, func,
    ForeignKey, UniqueConstraint, Boolean, LargeBinary, Index, BigInteger, text, Computed
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID, ARRAY as PG_ARRAY
from sqlalchemy.orm import relationship, backref
from sqlalchemy import Enum as SqlEnum

from backend.database import Base
from backend.utils.plans import (
    plan_limit,
    limit_value,
    normalize_plan,
    effective_plan as resolve_effective_plan,
    is_trial_active as plan_is_trial_active,
    is_paid_active as plan_is_paid_active,
    PLAN_FREE,
    PLAN_START,
    PLAN_BUSINESS,
    PLAN_ENTERPRISE,
)


# =========================
# Planos e helpers
# =========================
class PlanoAssinatura(str, enum.Enum):
    FREE       = PLAN_FREE
    START      = PLAN_START
    BUSINESS   = PLAN_BUSINESS
    ENTERPRISE = PLAN_ENTERPRISE


def max_instancias_por_plano(plano: str | None) -> int:
    """
    Evita duplicar números no models.
    Usa a matriz de entitlements do plans.py.
    """
    return limit_value(plano or PLAN_FREE, "whatsapp_instances_max", default=0)


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

    assinatura = Column(String, nullable=False, server_default=PLAN_FREE)

    trial_tier       = Column(String, nullable=True)
    trial_expires_at = Column(TIMESTAMP(timezone=True), nullable=True)

    plano_expira_em  = Column(TIMESTAMP(timezone=True), nullable=True)

    quantidade_instancias = Column(Integer, nullable=False, server_default="0")

    avatar_url    = Column(Text)
    status_numero = Column(String)
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now())
    nome_adm      = Column(String, nullable=True, default=None)

    cnpj_cpf = Column(String, nullable=True, index=True)

    requer_token_login = Column(Boolean, nullable=False, server_default="false")

    # =========================
    # Billing / Asaas
    # =========================
    billing_provider = Column(String(30), nullable=True)
    billing_status = Column(String(40), nullable=True)
    billing_plan_pending = Column(String(40), nullable=True)

    asaas_customer_id = Column(String(120), nullable=True)
    asaas_subscription_id = Column(String(120), nullable=True)
    asaas_last_payment_id = Column(String(120), nullable=True)

    billing_updated_at = Column(TIMESTAMP(timezone=True), nullable=True)

    # =========================
    # Módulo de E-mail
    # =========================
    email_assinatura       = Column(String, nullable=True)
    email_plano_expira_em  = Column(TIMESTAMP(timezone=True), nullable=True)

    email_trial_tier       = Column(String, nullable=True)
    email_trial_expires_at = Column(TIMESTAMP(timezone=True), nullable=True)

    max_email_accounts_override = Column(Integer, nullable=True)
    email_storage_override_bytes = Column(Integer, nullable=True)

    # =========================
    # Relacionamentos
    # =========================
    clientes        = relationship("Cliente", back_populates="empresa", cascade="all, delete-orphan")
    usuarios        = relationship("Usuario", back_populates="empresa", cascade="all, delete-orphan")
    departamentos   = relationship("Departamento", back_populates="empresa", cascade="all, delete-orphan")
    setores         = relationship("Setor", back_populates="empresa", cascade="all, delete-orphan")
    colaboradores   = relationship("Colaborador", back_populates="empresa", cascade="all, delete-orphan")
    atendimentos    = relationship("Atendimento", back_populates="empresa", cascade="all, delete-orphan")

    filas_atendimento = relationship(
        "FilaAtendimento",
        back_populates="empresa",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    atendimento_participantes = relationship(
        "AtendimentoParticipante",
        back_populates="empresa",
        cascade="all, delete-orphan",
    )

    midias          = relationship("Midia", back_populates="empresa", cascade="all, delete-orphan")
    grupos          = relationship("Grupo", back_populates="empresa", cascade="all, delete-orphan")
    mensagens_grupo = relationship("MensagemGrupo", back_populates="empresa", cascade="all, delete-orphan")

    instancias = relationship(
        "EmpresaInstancia",
        back_populates="empresa",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    whatsapp_identidades = relationship(
        "ContatoWhatsappIdentidade",
        back_populates="empresa",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    email_accounts = relationship(
        "EmailAccount",
        back_populates="empresa",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    email_messages    = relationship("EmailMessage",    back_populates="empresa", cascade="all, delete-orphan")
    email_attachments = relationship("EmailAttachment", back_populates="empresa", cascade="all, delete-orphan")

    billing_asaas_events = relationship(
        "BillingAsaasEvent",
        back_populates="empresa",
        passive_deletes=True,
    )

    @property
    def plano(self) -> str:
        return normalize_plan(self.assinatura or PLAN_FREE)

    @plano.setter
    def plano(self, value: str) -> None:
        self.assinatura = normalize_plan(value or PLAN_FREE)

    @property
    def trial_active(self) -> bool:
        return plan_is_trial_active(self)

    @property
    def paid_active(self) -> bool:
        return plan_is_paid_active(self)

    @property
    def effective_tier(self) -> str:
        return resolve_effective_plan(self)

    @property
    def email_paid_active(self) -> bool:
        if not self.email_assinatura:
            return False
        if not self.email_plano_expira_em:
            return True
        return datetime.now(timezone.utc) < self.email_plano_expira_em

    @property
    def email_trial_active(self) -> bool:
        if not (self.email_trial_tier and self.email_trial_expires_at):
            return False
        return datetime.now(timezone.utc) < self.email_trial_expires_at

    @property
    def email_quota_effective(self) -> int:
        if self.max_email_accounts_override is not None:
            return int(self.max_email_accounts_override)

        if self.email_paid_active:
            tier = normalize_plan(self.email_assinatura or "")
        elif self.email_trial_active:
            tier = normalize_plan(self.email_trial_tier or "")
        else:
            return 0

        limits = {
            PLAN_START: 1,
            PLAN_BUSINESS: 3,
            PLAN_ENTERPRISE: 10,

            "PRATA": 1,
            "OURO": 3,
            "PLATINA": 10,
            "DIAMANTE": 10,
            "ASCENDENTE": 10,
            "IMORTAL": 10,
            "RADIANTE": 10,
        }
        return int(limits.get(tier, 0))


# =========================
# EmpresaInstancia
# =========================
# =========================
# EmpresaInstancia
# =========================
class EmpresaInstancia(Base):
    __tablename__ = "empresas_instancias"

    id = Column(Integer, primary_key=True)
    empresa_id = Column(Integer, ForeignKey("empresas.id", ondelete="CASCADE"), nullable=False)

    instance_name = Column(String, nullable=False, index=True, unique=True)

    # Nome interno que o cliente vê no ZapsChat
    apelido = Column(String, nullable=True)

    # Número real conectado nessa instância
    numero_instancia = Column(String, nullable=True)

    connected = Column(Boolean, nullable=False, server_default="false")
    last_seen = Column(TIMESTAMP(timezone=True), nullable=True)

    # =========================
    # Cache do perfil real do WhatsApp conectado
    # =========================
    perfil_nome_whatsapp = Column(Text, nullable=True)
    perfil_recado = Column(Text, nullable=True)
    perfil_avatar_url = Column(Text, nullable=True)

    perfil_is_business = Column(Boolean, nullable=False, server_default="false")
    perfil_business_email = Column(Text, nullable=True)
    perfil_business_website = Column(Text, nullable=True)
    perfil_business_description = Column(Text, nullable=True)

    perfil_wuid = Column(Text, nullable=True)
    perfil_raw_json = Column(JSONB, nullable=True)
    perfil_atualizado_em = Column(TIMESTAMP(timezone=True), nullable=True)

    # =========================
    # Score / qualidade da instância
    # =========================
    score = Column(Integer, nullable=True, index=True)
    score_status = Column(String(30), nullable=True, index=True)
    score_label = Column(String(50), nullable=True)
    score_resumo = Column(Text, nullable=True)

    score_motivos = Column(JSONB, nullable=True)
    score_metricas = Column(JSONB, nullable=True)
    score_recomendacoes = Column(JSONB, nullable=True)

    score_atualizado_em = Column(TIMESTAMP(timezone=True), nullable=True)

    historico_restaurar = Column(String, nullable=True, server_default="none")

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

    chatbot_configs = relationship(
        "ChatbotConfig",
        back_populates="instancia",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    dep_instancias = relationship(
        "DepartamentoInstancia",
        back_populates="instancia",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    atendimentos = relationship(
        "Atendimento",
        back_populates="instancia",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    filas_instancias = relationship(
        "FilaInstancia",
        back_populates="instancia",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    whatsapp_identidades = relationship(
        "ContatoWhatsappIdentidade",
        back_populates="instancia",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return (
            f"<EmpresaInstancia id={self.id} emp={self.empresa_id} "
            f"inst={self.instance_name!r} connected={self.connected} "
            f"perfil_nome={self.perfil_nome_whatsapp!r} "
            f"score={self.score} status={self.score_status!r}>"
        )

# =========================
# Cliente
# =========================
class Cliente(Base):
    __tablename__ = "clientes"
    __table_args__ = (
        UniqueConstraint("empresa_id", "telefone_norm", name="u_emp_cli_tel_norm"),
        Index("ix_clientes_empresa_inst", "empresa_id", "instancia_id"),
        Index("ix_clientes_tel_norm", "telefone_norm"),
        Index("ix_clientes_triagem", "empresa_id", "instancia_id", "triagem_ativa"),
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

    nome          = Column(String, default="Cliente")
    telefone      = Column(String, nullable=False)

    # Coluna GENERATED ALWAYS no PostgreSQL. O valor vem exclusivamente
    # de ``telefone`` e nunca deve ser enviado em INSERT/UPDATE pelo ORM.
    telefone_norm = Column(
        String,
        Computed(
            "regexp_replace(COALESCE(telefone, ''), '\\D', '', 'g')",
            persisted=True,
        ),
        nullable=False,
    )

    departamento  = Column(String)
    avatar_url    = Column(Text)
    timestamp     = Column(TIMESTAMP(timezone=True), server_default=func.now())

    nome_whatsapp   = Column(String)
    is_business     = Column(Boolean, default=False)
    status_whatsapp = Column(String)

    sobre_cliente = Column(Text)
    descricao     = Column(Text)
    website       = Column(String)

    cpf_cnpj = Column(String)
    rg       = Column(String)
    email    = Column(String)

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

    triagem_ativa = Column(Boolean, nullable=False, server_default="false")
    triagem_tentativas = Column(Integer, nullable=False, server_default="0")
    triagem_iniciada_em = Column(TIMESTAMP(timezone=True), nullable=True)
    triagem_ultima_msg_em = Column(TIMESTAMP(timezone=True), nullable=True)

    departamento_id = Column(
        Integer,
        ForeignKey("departamentos.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    empresa      = relationship("Empresa", back_populates="clientes")
    mensagens    = relationship("Mensagem", back_populates="cliente", cascade="all, delete-orphan")
    midias       = relationship("Midia", back_populates="cliente", cascade="all, delete-orphan")
    atendimentos = relationship("Atendimento", back_populates="cliente", cascade="all, delete-orphan")

    whatsapp_identidades = relationship(
        "ContatoWhatsappIdentidade",
        back_populates="cliente",
        passive_deletes=True,
    )

    colaborador      = relationship("Colaborador", foreign_keys=[colaborador_id])
    departamento_rel = relationship("Departamento")

    def __repr__(self) -> str:
        return f"<Cliente id={self.id} emp={self.empresa_id} tel={self.telefone!r} dep={self.departamento_id} inst={self.instancia_id}>"


# =========================
# Identidades WhatsApp / LID
# =========================
class ContatoWhatsappIdentidade(Base):
    __tablename__ = "contatos_whatsapp_identidades"
    __table_args__ = (
        Index(
            "uq_cwi_emp_inst_remote_jid",
            "empresa_id",
            "instancia_id",
            "remote_jid",
            unique=True,
        ),
        Index(
            "ix_cwi_emp_inst_lid",
            "empresa_id",
            "instancia_id",
            "lid_jid",
            postgresql_where=text("lid_jid IS NOT NULL"),
        ),
        Index(
            "ix_cwi_emp_inst_real",
            "empresa_id",
            "instancia_id",
            "real_jid",
            postgresql_where=text("real_jid IS NOT NULL"),
        ),
        Index(
            "ix_cwi_emp_inst_tel",
            "empresa_id",
            "instancia_id",
            "telefone_norm",
            postgresql_where=text("telefone_norm IS NOT NULL"),
        ),
        Index(
            "ix_cwi_emp_inst_push_norm",
            "empresa_id",
            "instancia_id",
            "push_name_norm",
            postgresql_where=text("push_name_norm IS NOT NULL"),
        ),
        Index(
            "ix_cwi_cliente",
            "cliente_id",
            postgresql_where=text("cliente_id IS NOT NULL"),
        ),
        Index(
            "ix_cwi_confirmado",
            "empresa_id",
            "instancia_id",
            "confirmado",
        ),
        Index(
            "ix_cwi_ultimo_evento",
            "empresa_id",
            "instancia_id",
            text("ultimo_evento_em DESC"),
        ),
    )

    id = Column(BigInteger, primary_key=True, index=True)

    empresa_id = Column(
        Integer,
        ForeignKey("empresas.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    instancia_id = Column(
        Integer,
        ForeignKey("empresas_instancias.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )

    cliente_id = Column(
        Integer,
        ForeignKey("clientes.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    remote_jid = Column(Text, nullable=False)
    jid_tipo = Column(String(30), nullable=False, server_default="unknown")

    lid_jid = Column(Text, nullable=True)
    real_jid = Column(Text, nullable=True)
    telefone_norm = Column(String(32), nullable=True)

    push_name = Column(Text, nullable=True)
    push_name_norm = Column(Text, nullable=True)

    profile_pic_url = Column(Text, nullable=True)
    profile_pic_hash = Column(Text, nullable=True)

    is_business = Column(Boolean, nullable=False, server_default="false")

    origem = Column(String(80), nullable=True)

    confirmado = Column(Boolean, nullable=False, server_default="false")
    confianca = Column(Integer, nullable=False, server_default="0")
    resolved_by = Column(String(120), nullable=True)

    payload = Column(JSONB, nullable=True)

    criado_em = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
    atualizado_em = Column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    ultimo_evento_em = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    empresa = relationship("Empresa", back_populates="whatsapp_identidades")
    instancia = relationship("EmpresaInstancia", back_populates="whatsapp_identidades")
    cliente = relationship("Cliente", back_populates="whatsapp_identidades")

    def __repr__(self) -> str:
        return (
            f"<ContatoWhatsappIdentidade id={self.id} emp={self.empresa_id} "
            f"inst={self.instancia_id} remote={self.remote_jid!r} "
            f"lid={self.lid_jid!r} real={self.real_jid!r} "
            f"nome={self.push_name!r} confirmado={self.confirmado}>"
        )


# =========================
# Mensagem (1:1)
# =========================
class Mensagem(Base):
    __tablename__ = "mensagens"
    __table_args__ = (
        Index("ix_mensagens_msg_id", "msg_id"),
        Index("ix_mensagens_empresa_cliente_ts", "empresa_id", "cliente_id", "timestamp"),
        Index(
            "ix_mensagens_hist_emp_cli_inst_ts_id",
            "empresa_id", "cliente_id", "instancia_id", "timestamp", "id",
            postgresql_where=text("apagada_usuario = false"),
        ),
        Index(
            "ix_mensagens_hist_emp_cli_ts_id",
            "empresa_id", "cliente_id", "timestamp", "id",
            postgresql_where=text("apagada_usuario = false"),
        ),
        Index(
            "ix_mensagens_hist_emp_cli_inst_id",
            "empresa_id", "cliente_id", "instancia_id", "id",
            postgresql_where=text("apagada_usuario = false"),
        ),
        Index("ix_mensagens_colaborador_id", "colaborador_id"),
        Index("ix_mensagens_empresa_colab_ts", "empresa_id", "colaborador_id", "timestamp"),
        Index(
            "uq_mensagens_cliente_msgid_notnull",
            "cliente_id", "msg_id",
            unique=True,
            postgresql_where=text("msg_id IS NOT NULL"),
        ),
    )

    id         = Column(Integer, primary_key=True, index=True)
    empresa_id = Column(Integer, ForeignKey("empresas.id"), nullable=False, index=True)
    cliente_id = Column(Integer, ForeignKey("clientes.id"), nullable=False, index=True)

    instancia_id = Column(
        Integer,
        ForeignKey("empresas_instancias.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    atendimento_id = Column(
        Integer,
        ForeignKey("atendimentos.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    colaborador_id = Column(
        Integer,
        ForeignKey("colaboradores.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    conteudo  = Column(Text,   nullable=False)
    tipo      = Column(String, nullable=False)
    lida      = Column(Boolean, default=False)
    timestamp = Column(TIMESTAMP(timezone=True), server_default=func.now())

    msg_id = Column(String, index=True)
    ack    = Column(Integer, default=0)

    quoted = Column(JSONB, nullable=True)
    quoted_preview = Column(JSONB, nullable=True)

    cliente     = relationship("Cliente", back_populates="mensagens")
    instancia   = relationship("EmpresaInstancia", back_populates="mensagens")
    atendimento = relationship("Atendimento", back_populates="mensagens")
    colaborador = relationship("Colaborador", foreign_keys=[colaborador_id], back_populates="mensagens_enviadas")

    apagada_cliente = Column(Boolean, nullable=False, default=False)
    apagada_usuario = Column(Boolean, nullable=False, default=False)

    def __repr__(self) -> str:
        return (
            f"<Mensagem id={self.id} cli={self.cliente_id} inst={self.instancia_id} "
            f"atd={self.atendimento_id} colab={self.colaborador_id} tipo={self.tipo} ts={self.timestamp}>"
        )


# =========================
# Midia
# =========================
class Midia(Base):
    __tablename__ = "midias"
    __table_args__ = (
        UniqueConstraint("mensagem_id", "file_sha256", name="uq_midias_msg_sha"),
        Index(
            "uq_midias_msg_fn_size_nullsha",
            "mensagem_id", "filename", "tamanho",
            unique=True,
            postgresql_where=text("file_sha256 IS NULL")
        ),
        Index("ix_midias_instancia", "instancia_id"),
        Index("ix_midias_grupo_id", "grupo_id"),
        Index("ix_midias_mensagem_grupo_id", "mensagem_grupo_id"),
    )

    id            = Column(Integer, primary_key=True, index=True)
    empresa_id    = Column(Integer, ForeignKey("empresas.id"))
    cliente_id    = Column(Integer, ForeignKey("clientes.id"))
    grupo_id      = Column(BigInteger, ForeignKey("grupos.id"), nullable=True, index=True)
    mensagem_id   = Column(Integer, ForeignKey("mensagens.id"), nullable=True)
    mensagem_grupo_id = Column(
        BigInteger,
        ForeignKey("mensagens_grupo.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    instancia_id  = Column(Integer, ForeignKey("empresas_instancias.id", ondelete="SET NULL"), index=True, nullable=True)

    tipo          = Column(String)
    filename      = Column(String)
    mimetype      = Column(String)
    nome_original = Column(String)

    url           = Column(String)
    local_path    = Column(String)
    data          = Column(LargeBinary)
    tamanho       = Column(Integer)
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now())
    page_count    = Column(Integer)

    file_sha256     = Column(Text)
    file_enc_sha256 = Column(Text)

    empresa   = relationship("Empresa", back_populates="midias")
    cliente   = relationship("Cliente", back_populates="midias")
    grupo     = relationship("Grupo")
    mensagem  = relationship("Mensagem", foreign_keys=[mensagem_id])
    mensagem_grupo = relationship("MensagemGrupo", foreign_keys=[mensagem_grupo_id])


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
        Index("ix_msggrupo_hist_emp_grupo_inst_id", "empresa_id", "grupo_id", "instancia_id", "id"),
    )

    id = Column(BigInteger, primary_key=True, index=True)

    empresa_id = Column(Integer, ForeignKey("empresas.id"), nullable=False, index=True)
    grupo_id = Column(BigInteger, ForeignKey("grupos.id"), nullable=False, index=True)

    instancia_id = Column(
        Integer,
        ForeignKey("empresas_instancias.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    author_jid = Column(Text, nullable=True)
    from_me = Column(Boolean, default=False)

    conteudo = Column(Text, nullable=False)
    tipo = Column(Text, nullable=False)
    message_type = Column(Text, nullable=True)

    lida = Column(Boolean, default=False)
    ack = Column(Integer, default=0)
    apagada_cliente = Column(Boolean, nullable=False, default=False)
    apagada_usuario = Column(Boolean, nullable=False, default=False)

    timestamp = Column(BigInteger, nullable=True)
    msg_id = Column(Text, nullable=False, index=True)

    quoted = Column(JSONB, nullable=True)
    quoted_preview = Column(JSONB, nullable=True)

    criado_em = Column(TIMESTAMP(timezone=True), server_default=func.now())

    empresa = relationship("Empresa", back_populates="mensagens_grupo")
    grupo = relationship("Grupo", back_populates="mensagens")
    instancia = relationship("EmpresaInstancia", back_populates="mensagens_grupo")

    def __repr__(self) -> str:
        return (
            f"<MensagemGrupo id={self.id} emp={self.empresa_id} grupo={self.grupo_id} "
            f"inst={self.instancia_id} from_me={self.from_me} tipo={self.tipo} "
            f"ack={self.ack} lida={self.lida} ts={self.timestamp} msg_id={self.msg_id}>"
        )


# =========================
# Departamento
# =========================
class Departamento(Base):
    __tablename__ = "departamentos"

    id         = Column(Integer, primary_key=True, index=True)
    empresa_id = Column(Integer, ForeignKey("empresas.id", ondelete="CASCADE"), nullable=False, index=True)

    nome      = Column(String(80), nullable=False)
    descricao = Column(Text, nullable=True)

    parent_id = Column(Integer, ForeignKey("departamentos.id", ondelete="RESTRICT"), nullable=True, index=True)
    codigo    = Column(String(64), nullable=True)
    path      = Column(PG_ARRAY(String), nullable=True)
    chefe_id  = Column(Integer, nullable=True)
    ativo     = Column(Boolean, nullable=False, server_default="true")

    hora_login_inicio_padrao = Column(String(5), nullable=True)
    hora_login_fim_padrao    = Column(String(5), nullable=True)

    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    empresa = relationship("Empresa", back_populates="departamentos")

    parent   = relationship("Departamento", remote_side=[id], backref=backref("children", cascade="all"))
    usuarios = relationship("Usuario", back_populates="departamento", cascade="all, delete-orphan")

    dep_instancias = relationship(
        "DepartamentoInstancia",
        back_populates="departamento",
        cascade="all, delete-orphan",
    )

    atendimentos = relationship(
        "Atendimento",
        back_populates="departamento",
        passive_deletes=True,
    )

    filas_atendimento = relationship(
        "FilaAtendimento",
        back_populates="departamento",
        passive_deletes=True,
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
    empresa_id      = Column(Integer, nullable=False, index=True)
    departamento_id = Column(Integer, ForeignKey("departamentos.id", ondelete="CASCADE"), nullable=False, index=True)
    instancia_id    = Column(Integer, ForeignKey("empresas_instancias.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())

    departamento = relationship("Departamento", back_populates="dep_instancias")
    instancia    = relationship("EmpresaInstancia", back_populates="dep_instancias")

    def __repr__(self):
        return f"<DepartamentoInstancia emp={self.empresa_id} dep={self.departamento_id} inst={self.instancia_id}>"


# =========================
# Filas de Atendimento
# =========================
class FilaAtendimento(Base):
    __tablename__ = "filas_atendimento"
    __table_args__ = (
        UniqueConstraint("empresa_id", "nome", name="uq_filas_atendimento_empresa_nome"),
        Index("ix_filas_empresa_ativa", "empresa_id", "ativa"),
        Index("ix_filas_empresa_departamento", "empresa_id", "departamento_id"),
        Index("ix_filas_empresa_prioridade", "empresa_id", "prioridade"),
    )

    id = Column(Integer, primary_key=True, index=True)

    empresa_id = Column(
        Integer,
        ForeignKey("empresas.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    departamento_id = Column(
        Integer,
        ForeignKey("departamentos.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    nome = Column(String(80), nullable=False)
    descricao = Column(Text, nullable=True)

    prioridade = Column(String(20), nullable=False, server_default="normal")
    sla_minutos = Column(Integer, nullable=True)

    cor = Column(String(20), nullable=True)
    mensagem_padrao = Column(Text, nullable=True)

    ativa = Column(Boolean, nullable=False, server_default="true")
    ordem = Column(Integer, nullable=False, server_default="0")

    exigir_aceite = Column(Boolean, nullable=False, server_default="true")
    retorno_ao_liberar = Column(Boolean, nullable=False, server_default="true")
    auto_distribuir = Column(Boolean, nullable=False, server_default="false")

    # Se ativo, quem assumir precisa enviar ao menos uma resposta dentro do
    # prazo. Caso contrário o atendimento volta automaticamente para a fila.
    retorno_inatividade_ativo = Column(Boolean, nullable=False, default=False, server_default="false")
    retorno_inatividade_minutos = Column(Integer, nullable=True)

    criada_em = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
    atualizada_em = Column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    empresa = relationship("Empresa", back_populates="filas_atendimento")
    departamento = relationship("Departamento", back_populates="filas_atendimento")

    instancias = relationship(
        "FilaInstancia",
        back_populates="fila",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    atendimentos = relationship(
        "Atendimento",
        back_populates="fila",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return (
            f"<FilaAtendimento id={self.id} emp={self.empresa_id} "
            f"nome={self.nome!r} dep={self.departamento_id} ativa={self.ativa}>"
        )


class FilaInstancia(Base):
    __tablename__ = "filas_instancias"
    __table_args__ = (
        UniqueConstraint("empresa_id", "fila_id", "instancia_id", name="uq_fila_instancia_emp_fila_inst"),
        Index("ix_fila_instancia_fila", "fila_id"),
        Index("ix_fila_instancia_inst", "instancia_id"),
        Index("ix_fila_instancia_emp_inst", "empresa_id", "instancia_id"),
    )

    id = Column(Integer, primary_key=True, index=True)

    empresa_id = Column(
        Integer,
        ForeignKey("empresas.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    fila_id = Column(
        Integer,
        ForeignKey("filas_atendimento.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    instancia_id = Column(
        Integer,
        ForeignKey("empresas_instancias.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    criada_em = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    fila = relationship("FilaAtendimento", back_populates="instancias")
    instancia = relationship("EmpresaInstancia", back_populates="filas_instancias")

    def __repr__(self) -> str:
        return f"<FilaInstancia emp={self.empresa_id} fila={self.fila_id} inst={self.instancia_id}>"


class AtendimentoDeletedConversa(Base):
    """
    Conversa removida apenas da lista lateral.

    O cliente e o histórico continuam no banco; esta tabela funciona como
    tombstone persistente para a conversa não voltar após F5, reinício do
    backend ou expiração do Redis. A remoção é global para a empresa, igual ao
    comportamento anterior do cache `conv:deleted`.
    """

    __tablename__ = "atendimento_deleted_conversas"
    __table_args__ = (
        UniqueConstraint(
            "empresa_id",
            "cliente_id",
            name="uq_atd_deleted_emp_cliente",
        ),
        Index(
            "ix_atd_deleted_emp_cliente",
            "empresa_id",
            "cliente_id",
        ),
    )

    empresa_id = Column(
        Integer,
        ForeignKey("empresas.id", ondelete="CASCADE"),
        nullable=False,
        primary_key=True,
    )

    cliente_id = Column(
        Integer,
        ForeignKey("clientes.id", ondelete="CASCADE"),
        nullable=False,
        primary_key=True,
    )

    deleted_by_user_id = Column(Integer, nullable=True)

    deleted_at = Column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    empresa = relationship("Empresa")
    cliente = relationship("Cliente")

    def __repr__(self) -> str:
        return (
            f"<DeletedConversa emp={self.empresa_id} cliente={self.cliente_id} "
            f"by={self.deleted_by_user_id}>"
        )


class AtendimentoPinnedConversa(Base):
    __tablename__ = "atendimento_pinned_conversas"
    __table_args__ = (
        UniqueConstraint(
            "empresa_id",
            "user_id",
            "conversa_id",
            "instancia_id",
            name="uq_pinned_emp_user_conv_inst",
        ),
        Index("ix_pinned_user_inst", "empresa_id", "user_id", "instancia_id"),
        Index("ix_pinned_conv_inst", "empresa_id", "conversa_id", "instancia_id"),
    )

    empresa_id = Column(
        Integer,
        ForeignKey("empresas.id", ondelete="CASCADE"),
        nullable=False,
        primary_key=True,
    )

    user_id = Column(
        Integer,
        ForeignKey("usuarios.id", ondelete="CASCADE"),
        nullable=False,
        primary_key=True,
    )

    conversa_id = Column(
        Integer,
        ForeignKey("clientes.id", ondelete="CASCADE"),
        nullable=False,
        primary_key=True,
    )

    instancia_id = Column(
        Integer,
        ForeignKey("empresas_instancias.id", ondelete="CASCADE"),
        nullable=False,
        primary_key=True,
    )

    pinned_at = Column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    atendimento_id = Column(
        Integer,
        ForeignKey("atendimentos.id", ondelete="SET NULL"),
        nullable=True,
    )

    empresa = relationship("Empresa")
    usuario = relationship("Usuario")
    conversa = relationship("Cliente")
    instancia = relationship("EmpresaInstancia")
    atendimento = relationship("Atendimento")

    def __repr__(self) -> str:
        return (
            f"<Pinned emp={self.empresa_id} user={self.user_id} "
            f"conv={self.conversa_id} inst={self.instancia_id}>"
        )


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

    usuario_id = Column(
        Integer,
        ForeignKey('usuarios.id', ondelete="SET NULL"),
        nullable=True,
        unique=True,
        index=True,
    )

    nome       = Column(String(60), nullable=False)
    email      = Column(String(120), nullable=False, unique=True)
    senha      = Column(String(200), nullable=False)
    telefone   = Column(String(20), nullable=True)
    cargo      = Column(String(50), nullable=True)

    avatar_data = Column(LargeBinary, nullable=True)
    avatar_mime = Column(String, nullable=True)

    empresa = relationship("Empresa", back_populates="colaboradores")
    setor   = relationship("Setor", back_populates="colaboradores")
    usuario = relationship("Usuario", back_populates="colaborador", foreign_keys=[usuario_id])

    hora_login_inicio = Column(String(5), nullable=True)
    hora_login_fim    = Column(String(5), nullable=True)
    horario_modo      = Column(String(20), nullable=True)

    login_token = Column(String(20), nullable=True)
    login_token_expires_at = Column(DateTime(timezone=True), nullable=True)

    # Última vez em que o colaborador acessou o próprio ZapsChat.
    # Não tem relação com presença/visto por último do WhatsApp.
    last_access_at = Column(TIMESTAMP(timezone=True), nullable=True)

    # Marca quando o guia inicial do ZapsChat já foi apresentado para este colaborador.
    onboarding_completed_at = Column(TIMESTAMP(timezone=True), nullable=True)

    permissoes = relationship(
        "Permissao",
        secondary="colaboradores_permissoes",
        back_populates="colaboradores",
        lazy="joined",
    )

    instancias_ver = Column(PG_ARRAY(Integer), nullable=True)

    # Define o escopo de conversas visíveis no atendimento.
    # 'todos' mantém o comportamento anterior; 'proprios' limita às conversas
    # iniciadas, assumidas, atribuídas ou atendidas pelo colaborador.
    visibilidade_atendimentos = Column(
        String(20),
        nullable=False,
        default="todos",
        server_default="todos",
    )

    atendimentos_operados = relationship(
        "Atendimento",
        foreign_keys="Atendimento.operador_id",
        back_populates="operador",
    )

    mensagens_enviadas = relationship(
        "Mensagem",
        foreign_keys="Mensagem.colaborador_id",
        back_populates="colaborador",
    )

    participacoes_atendimento = relationship(
        "AtendimentoParticipante",
        back_populates="colaborador",
        cascade="all, delete-orphan",
    )


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

    # Marca quando o guia inicial do ZapsChat já foi apresentado para este usuário.
    onboarding_completed_at = Column(TIMESTAMP(timezone=True), nullable=True)

    empresa      = relationship("Empresa", back_populates="usuarios")
    departamento = relationship("Departamento", back_populates="usuarios")

    colaborador = relationship(
        "Colaborador",
        back_populates="usuario",
        uselist=False,
        foreign_keys="Colaborador.usuario_id",
    )


# =========================
# Atendimentos
# =========================
class Atendimento(Base):
    __tablename__ = "atendimentos"
    __table_args__ = (
        Index("ix_atendimentos_empresa_status", "empresa_id", "status"),
        Index("ix_atendimentos_empresa_inst_status", "empresa_id", "instancia_id", "status"),
        Index("ix_atendimentos_empresa_dep_status", "empresa_id", "departamento_id", "status"),
        Index("ix_atendimentos_empresa_fila_status", "empresa_id", "fila_id", "status"),
        Index("ix_atendimentos_empresa_cli_inst", "empresa_id", "cliente_id", "instancia_id"),
        Index("ix_atendimentos_hist_emp_cli_inst_id", "empresa_id", "cliente_id", "instancia_id", "id"),
        Index("ix_atendimentos_operador", "operador_id"),
        Index("ix_atendimentos_fila", "fila_id"),
        Index(
            "uq_atendimentos_um_aberto_conversa",
            "empresa_id",
            "cliente_id",
            "instancia_id",
            unique=True,
            postgresql_where=text(
                "instancia_id IS NOT NULL AND "
                "status IN ('novo'::statusatendimento, 'aguardando'::statusatendimento, 'em_atendimento'::statusatendimento, 'pausado'::statusatendimento)"
            ),
        ),
    )

    id = Column(Integer, primary_key=True, index=True)

    empresa_id = Column(
        Integer,
        ForeignKey("empresas.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    cliente_id = Column(
        Integer,
        ForeignKey("clientes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    operador_id = Column(
        Integer,
        ForeignKey("colaboradores.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    departamento_id = Column(
        Integer,
        ForeignKey("departamentos.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    instancia_id = Column(
        Integer,
        ForeignKey("empresas_instancias.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    fila_id = Column(
        Integer,
        ForeignKey("filas_atendimento.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    fila_escolhida_em = Column(
        TIMESTAMP(timezone=True),
        nullable=True,
    )

    criado_em = Column(
        TIMESTAMP(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    atualizado_em = Column(
        TIMESTAMP(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=True,
    )

    aceito_em = Column(
        TIMESTAMP(timezone=True),
        nullable=True,
    )

    status = Column(
        SqlEnum(
            StatusAtendimento,
            name="statusatendimento",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
            native_enum=True,
        ),
        default=StatusAtendimento.NOVO,
        nullable=False,
    )

    empresa = relationship("Empresa", back_populates="atendimentos")
    cliente = relationship("Cliente", back_populates="atendimentos")
    departamento = relationship("Departamento", back_populates="atendimentos")
    instancia = relationship("EmpresaInstancia", back_populates="atendimentos")
    fila = relationship("FilaAtendimento", back_populates="atendimentos")
    operador = relationship("Colaborador", foreign_keys=[operador_id], back_populates="atendimentos_operados")

    mensagens = relationship(
        "Mensagem",
        back_populates="atendimento",
        lazy="selectin",
    )

    participantes = relationship(
        "AtendimentoParticipante",
        back_populates="atendimento",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"<Atendimento id={self.id} emp={self.empresa_id} cli={self.cliente_id} "
            f"dep={self.departamento_id} fila={self.fila_id} inst={self.instancia_id} "
            f"status={self.status} op={self.operador_id}>"
        )


# =========================
# Participantes do atendimento
# =========================
class AtendimentoParticipante(Base):
    __tablename__ = "atendimento_participantes"
    __table_args__ = (
        UniqueConstraint("empresa_id", "atendimento_id", "colaborador_id", name="uq_atd_participante"),
        Index("ix_atd_participante_atendimento", "empresa_id", "atendimento_id"),
        Index("ix_atd_participante_colaborador", "empresa_id", "colaborador_id"),
        Index("ix_atd_participante_ativo", "empresa_id", "is_ativo"),
        Index(
            "uq_atd_participante_um_responsavel_ativo",
            "empresa_id",
            "atendimento_id",
            unique=True,
            postgresql_where=text("is_ativo IS TRUE AND role = 'responsavel'"),
        ),
    )

    id = Column(Integer, primary_key=True, index=True)

    empresa_id = Column(
        Integer,
        ForeignKey("empresas.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    atendimento_id = Column(
        Integer,
        ForeignKey("atendimentos.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    colaborador_id = Column(
        Integer,
        ForeignKey("colaboradores.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    role = Column(String(20), nullable=False, server_default="participant")
    is_ativo = Column(Boolean, nullable=False, server_default="true")

    entrou_em = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
    saiu_em = Column(TIMESTAMP(timezone=True), nullable=True)
    ultimo_envio_em = Column(TIMESTAMP(timezone=True), nullable=True)

    criado_em = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
    atualizado_em = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    empresa = relationship("Empresa", back_populates="atendimento_participantes")
    atendimento = relationship("Atendimento", back_populates="participantes")
    colaborador = relationship("Colaborador", back_populates="participacoes_atendimento")

    def __repr__(self) -> str:
        return (
            f"<AtendimentoParticipante id={self.id} emp={self.empresa_id} "
            f"atd={self.atendimento_id} colab={self.colaborador_id} "
            f"role={self.role} ativo={self.is_ativo}>"
        )


# =========================
# Permissao
# =========================
class Permissao(Base):
    __tablename__ = "permissoes"

    id   = Column(String, primary_key=True)
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


class Disparo(Base):
    __tablename__ = "disparos"

    id = Column(Integer, primary_key=True)

    empresa_id = Column(
        Integer,
        ForeignKey("empresas.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

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

    usuario_id = Column(
        Integer,
        ForeignKey("usuarios.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    tipo_conteudo = Column(String(16), nullable=False, server_default="text")
    mensagem = Column(Text, nullable=True)

    midia_id = Column(
        Integer,
        ForeignKey("midias.id", ondelete="SET NULL"),
        nullable=True,
    )

    delay_segundos = Column(Integer, nullable=False, server_default="20")

    total_destinatarios = Column(Integer, nullable=False, server_default="0")
    enviados_sucesso    = Column(Integer, nullable=False, server_default="0")
    enviados_erro       = Column(Integer, nullable=False, server_default="0")

    status = Column(String(16), nullable=False, server_default="pendente")

    criado_em     = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    iniciado_em   = Column(TIMESTAMP(timezone=True), nullable=True)
    finalizado_em = Column(TIMESTAMP(timezone=True), nullable=True)

    meta = Column(JSONB, nullable=True)

    empresa     = relationship("Empresa", backref=backref("disparos", cascade="all, delete-orphan"))
    instancia   = relationship("EmpresaInstancia", backref=backref("disparos", cascade="all, delete-orphan"))
    colaborador = relationship("Colaborador", backref=backref("disparos", cascade="all, delete-orphan"))
    usuario     = relationship("Usuario")
    midia       = relationship("Midia")

    destinatarios = relationship(
        "DisparoDestinatario",
        back_populates="disparo",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return f"<Disparo id={self.id} emp={self.empresa_id} inst={self.instancia_id} status={self.status}>"


class DisparoDestinatario(Base):
    __tablename__ = "disparos_destinatarios"
    __table_args__ = (
        UniqueConstraint("disparo_id", "numero_normalizado", name="uq_disparo_destinatario"),
        Index("ix_disparo_dest_did", "disparo_id"),
        Index("ix_disparo_dest_num", "numero_normalizado"),
    )

    id = Column(Integer, primary_key=True)

    disparo_id = Column(
        Integer,
        ForeignKey("disparos.id", ondelete="CASCADE"),
        nullable=False,
    )

    numero_raw = Column(String(64), nullable=False)
    numero_normalizado = Column(String(32), nullable=False)

    nome = Column(String, nullable=True)

    status = Column(String(16), nullable=False, server_default="pendente")

    erro_msg = Column(Text, nullable=True)

    tentativas          = Column(Integer, nullable=False, server_default="0")
    ultima_tentativa_em = Column(TIMESTAMP(timezone=True), nullable=True)
    enviado_em          = Column(TIMESTAMP(timezone=True), nullable=True)

    criado_em = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)

    disparo = relationship("Disparo", back_populates="destinatarios")

    def __repr__(self) -> str:
        return f"<DisparoDestinatario id={self.id} disp={self.disparo_id} numero={self.numero_normalizado} status={self.status}>"


# =========================
# ChatbotConfig
# =========================
class ChatbotConfig(Base):
    __tablename__ = "chatbot_configs"

    id = Column(Integer, primary_key=True)

    empresa_id   = Column(
        Integer,
        ForeignKey("empresas.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    instancia_id = Column(
        Integer,
        ForeignKey("empresas_instancias.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    instancia_nome = Column(
        Text,
        nullable=True,
        index=True,
    )

    ativo = Column(Boolean, nullable=False, server_default="true")

    tz = Column(String(64), nullable=False, server_default="Etc/UTC")

    welcome_enabled = Column(Boolean, default=True)
    welcome_start   = Column(DateTime, nullable=True)
    welcome_end     = Column(DateTime, nullable=True)

    off_enabled     = Column(Boolean, default=False)
    off_start       = Column(DateTime, nullable=True)
    off_end         = Column(DateTime, nullable=True)

    config = Column(JSONB, default=dict)

    instancia = relationship(
        "EmpresaInstancia",
        back_populates="chatbot_configs",
    )

    empresa = relationship(
        "Empresa",
        backref=backref("chatbot_configs", cascade="all, delete-orphan"),
    )

    __table_args__ = (
        UniqueConstraint(
            "empresa_id",
            "instancia_id",
            name="uq_chatbot_conf_emp_inst",
        ),
        UniqueConstraint(
            "empresa_id",
            "instancia_nome",
            name="uq_chatbot_conf_emp_inst_nome",
        ),
    )


class ChatbotDispatchMarker(Base):
    """Marcador persistente de eventos enviados pelo chatbot.

    Evita usar o texto da mensagem como regra de negócio. O conteúdo do menu
    pode ser personalizado sem desativar a proteção contra reenvio.
    """

    __tablename__ = "chatbot_dispatch_markers"
    __table_args__ = (
        UniqueConstraint(
            "empresa_id",
            "instancia_id",
            "cliente_id",
            "event_key",
            name="uq_chatbot_dispatch_emp_inst_cli_event",
        ),
        Index(
            "ix_chatbot_dispatch_lookup",
            "empresa_id",
            "instancia_id",
            "cliente_id",
            "event_key",
            "sent_at",
        ),
    )

    id = Column(Integer, primary_key=True)
    empresa_id = Column(
        Integer,
        ForeignKey("empresas.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    instancia_id = Column(
        Integer,
        ForeignKey("empresas_instancias.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    cliente_id = Column(
        Integer,
        ForeignKey("clientes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    event_key = Column(String(64), nullable=False)
    sent_at = Column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    created_at = Column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


# =======================================================
# Chat Interno
# =======================================================
class ChatKind(str, enum.Enum):
    HEAD   = "head"
    MSG    = "msg"
    SYSTEM = "system"
    RENAME = "rename"
    JOIN   = "join"
    LEAVE  = "leave"


class ChatEvento(Base):
    __tablename__ = "chat_eventos"
    __table_args__ = (
        Index("idx_chat_eventos_emp_created", "empresa_id", "created_at"),
        Index("idx_chat_eventos_thread_created", "thread_id", "created_at"),
        Index("idx_chat_eventos_emp_thread_created", "empresa_id", "thread_id", "created_at"),
        Index("idx_chat_eventos_emp_kind_thread", "empresa_id", "kind", "thread_id"),
        Index("idx_chat_eventos_participantes", "participantes", postgresql_using="gin"),
    )

    id           = Column(BigInteger, primary_key=True)
    empresa_id   = Column(Integer, ForeignKey("empresas.id", ondelete="CASCADE"), nullable=False, index=True)
    thread_id    = Column(PG_UUID(as_uuid=False), nullable=False, index=True)
    kind         = Column(SqlEnum(ChatKind), nullable=False)
    autor_id     = Column(Integer, ForeignKey("colaboradores.id", ondelete="SET NULL"), nullable=True, index=True)

    participantes = Column(PG_ARRAY(Integer), nullable=True)

    texto       = Column(Text, nullable=True)
    titulo      = Column(String(200), nullable=True)

    created_at  = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False, index=True)
    deleted_at  = Column(TIMESTAMP(timezone=True), nullable=True)

    empresa = relationship("Empresa")
    autor   = relationship("Colaborador", foreign_keys=[autor_id])


class ChatReadState(Base):
    __tablename__ = "chat_read_state"
    __table_args__ = (
        UniqueConstraint("empresa_id", "thread_id", "user_id", name="pk_chat_read_state"),
        Index("idx_read_state_user", "empresa_id", "user_id"),
        Index("idx_read_state_thread_user", "empresa_id", "thread_id", "user_id"),
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
    colaborador_id  = Column(Integer, ForeignKey("colaboradores.id", ondelete="CASCADE"), nullable=False, index=True)
    role            = Column(String(32), nullable=False, server_default="member")
    is_primary      = Column(Boolean, nullable=False, server_default="false")

    departamento = relationship("Departamento", backref=backref("membros", cascade="all, delete-orphan"))
    colaborador = relationship("Colaborador", backref=backref("departamentos_membros", cascade="all, delete-orphan"))

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

    resource = Column(String(64), nullable=False)
    action   = Column(String(32), nullable=False)
    scope    = Column(String(32), nullable=False, server_default="own")
    effect   = Column(Boolean, nullable=False)

    departamento = relationship("Departamento", backref=backref("acls", cascade="all, delete-orphan"))

    __table_args__ = (
        UniqueConstraint("empresa_id", "departamento_id", "resource", "action", "scope", name="uq_dep_acl"),
    )

    def __repr__(self) -> str:
        ef = "ALLOW" if self.effect else "DENY"
        return f"<DepartamentoACL dep={self.departamento_id} {self.resource}.{self.action} {self.scope}={ef}>"


# ======================================================
# Módulo de E-mail
# ======================================================
class EmailAccount(Base):
    __tablename__ = "email_accounts"
    __table_args__ = (
        UniqueConstraint("empresa_id", "provider", "email_address", name="uq_email_account_emp_provider_email"),
        Index("ix_email_acc_emp", "empresa_id"),
        Index("ix_email_acc_emp_status", "empresa_id", "status"),
        Index("ix_email_acc_provider", "provider"),
        Index("ix_email_acc_email", "email_address"),
    )

    id             = Column(Integer, primary_key=True, index=True)
    empresa_id     = Column(Integer, ForeignKey("empresas.id", ondelete="CASCADE"), nullable=False, index=True)
    colaborador_id = Column(Integer, ForeignKey("colaboradores.id", ondelete="SET NULL"), nullable=True, index=True)

    provider       = Column(String(32), nullable=False, default="gmail")
    email_address  = Column(String(255), nullable=False)

    refresh_token_enc = Column(Text, nullable=False)
    access_token      = Column(Text, nullable=True)
    token_expiry      = Column(TIMESTAMP(timezone=True), nullable=True)

    storage_override_bytes = Column(Integer, nullable=True)

    status        = Column(String(32), nullable=False, default="active")
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)

    empresa       = relationship("Empresa", back_populates="email_accounts")
    colaborador   = relationship("Colaborador", foreign_keys=[colaborador_id])

    messages      = relationship("EmailMessage", back_populates="account", cascade="all, delete-orphan")

    def __repr__(self) -> str:
        return f"<EmailAccount id={self.id} emp={self.empresa_id} {self.provider}:{self.email_address}>"


class EmailMessage(Base):
    __tablename__ = "email_messages"
    __table_args__ = (
        UniqueConstraint("account_id", "external_id", name="uq_email_msg_external"),
        Index("ix_email_msg_emp_received", "empresa_id", "received_at"),
        Index("ix_email_msg_acc_received", "account_id", "received_at"),
        Index("ix_email_msg_from", "from_addr"),
        Index("ix_email_msg_subject", "subject"),
    )

    id            = Column(Integer, primary_key=True, index=True)
    empresa_id    = Column(Integer, ForeignKey("empresas.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id    = Column(Integer, ForeignKey("email_accounts.id", ondelete="CASCADE"), nullable=False, index=True)

    external_id   = Column(String(255), nullable=True)
    subject       = Column(Text, nullable=True)
    snippet       = Column(Text, nullable=True)

    from_addr     = Column(String(512), nullable=True)
    to_addrs      = Column(Text, nullable=True)
    cc_addrs      = Column(Text, nullable=True)
    bcc_addrs     = Column(Text, nullable=True)

    received_at   = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    size_bytes    = Column(Integer, nullable=False, server_default="0")

    has_attachments = Column(Boolean, nullable=False, server_default="false")

    body_text     = Column(Text, nullable=True)
    body_html     = Column(Text, nullable=True)

    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)

    empresa = relationship("Empresa", back_populates="email_messages")
    account = relationship("EmailAccount", back_populates="messages")
    attachments = relationship("EmailAttachment", back_populates="message", cascade="all, delete-orphan")


class EmailAttachment(Base):
    __tablename__ = "email_attachments"
    __table_args__ = (
        Index("ix_email_att_msg", "message_id"),
        Index("ix_email_att_emp", "empresa_id"),
        Index("ix_email_att_mime", "mimetype"),
    )

    id          = Column(Integer, primary_key=True, index=True)
    empresa_id  = Column(Integer, ForeignKey("empresas.id", ondelete="CASCADE"), nullable=False, index=True)
    message_id  = Column(Integer, ForeignKey("email_messages.id", ondelete="CASCADE"), nullable=False, index=True)

    filename    = Column(String(512), nullable=True)
    mimetype    = Column(String(256), nullable=True)

    size_bytes  = Column(Integer, nullable=False, server_default="0")
    storage_url = Column(Text, nullable=True)
    data        = Column(LargeBinary, nullable=True)

    created_at  = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)

    empresa = relationship("Empresa", back_populates="email_attachments")
    message = relationship("EmailMessage", back_populates="attachments")


# =========================
# Billing / Asaas - Eventos de Webhook
# =========================
class BillingAsaasEvent(Base):
    __tablename__ = "billing_asaas_events"
    __table_args__ = (
        UniqueConstraint("event_id", name="uq_billing_asaas_event_id"),
        Index("ix_billing_asaas_events_empresa", "empresa_id"),
        Index("ix_billing_asaas_events_payment", "payment_id"),
        Index("ix_billing_asaas_events_subscription", "subscription_id"),
    )

    id = Column(Integer, primary_key=True, index=True)

    event_id = Column(String(180), nullable=False)

    empresa_id = Column(
        Integer,
        ForeignKey("empresas.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    event = Column(String(80), nullable=True)
    payment_id = Column(String(120), nullable=True)
    subscription_id = Column(String(120), nullable=True)

    payload = Column(JSONB, nullable=False)

    created_at = Column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    empresa = relationship("Empresa", back_populates="billing_asaas_events")

    def __repr__(self) -> str:
        return (
            f"<BillingAsaasEvent id={self.id} emp={self.empresa_id} "
            f"event={self.event!r} payment={self.payment_id!r}>"
        )

# =========================
# Configurações - Relatos de suporte
# =========================
class RelatoSuporte(Base):
    __tablename__ = "relatos_suporte"
    __table_args__ = (
        Index("ix_relatos_suporte_empresa_created", "empresa_id", "created_at"),
        Index("ix_relatos_suporte_status", "status"),
    )

    id = Column(Integer, primary_key=True, index=True)
    empresa_id = Column(
        Integer,
        ForeignKey("empresas.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    usuario_id = Column(
        Integer,
        ForeignKey("usuarios.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    colaborador_id = Column(
        Integer,
        ForeignKey("colaboradores.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    tipo = Column(String(20), nullable=False, server_default="bug")
    titulo = Column(String(120), nullable=False)
    descricao = Column(Text, nullable=False)
    pagina = Column(String(255), nullable=True)
    status = Column(String(20), nullable=False, server_default="aberto")

    created_at = Column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at = Column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

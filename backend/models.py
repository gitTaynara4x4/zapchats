from __future__ import annotations

import enum
from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, String, Text, DateTime, TIMESTAMP, func,
    ForeignKey, UniqueConstraint, Boolean, LargeBinary, Index, BigInteger, text
)
from sqlalchemy.schema import FetchedValue
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

    # Plano atual selecionado (pago ou FREE)
    assinatura = Column(String, nullable=False, server_default=PLAN_FREE)

    # Trial opcional (START / BUSINESS / ENTERPRISE)
    trial_tier       = Column(String, nullable=True)
    trial_expires_at = Column(TIMESTAMP(timezone=True), nullable=True)

    # Validade do plano PAGO (se estiver setado e no futuro, o pago prevalece)
    plano_expira_em  = Column(TIMESTAMP(timezone=True), nullable=True)

    quantidade_instancias = Column(Integer, nullable=False, server_default="0")

    avatar_url    = Column(Text)
    status_numero = Column(String)
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now())
    nome_adm      = Column(String, nullable=True, default=None)

    cnpj_cpf = Column(String, nullable=True, index=True)

    # Flag global da empresa pra exigir 2º fator (token) no login dos colaboradores
    requer_token_login = Column(Boolean, nullable=False, server_default="false")

    # =========================
    # Módulo de E-mail (cotas independentes)
    # =========================
    # Plano PAGO de E-mail
    email_assinatura       = Column(String, nullable=True)
    email_plano_expira_em  = Column(TIMESTAMP(timezone=True), nullable=True)

    # Trial de E-mail (opcional)
    email_trial_tier       = Column(String, nullable=True)
    email_trial_expires_at = Column(TIMESTAMP(timezone=True), nullable=True)

    # Override: quantidade máxima de contas (caixas) de e-mail
    # NULL => usa plano/trial; 0 => bloqueia geral.
    max_email_accounts_override = Column(Integer, nullable=True)

    # Override: limite de armazenamento total de e-mails (bytes) da EMPRESA
    email_storage_override_bytes = Column(Integer, nullable=True)

    # =========================
    # Relacionamentos
    # =========================
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

    # Contas de e-mail conectadas (módulo E-mail)
    email_accounts = relationship(
        "EmailAccount",
        back_populates="empresa",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    # navegar pelas mensagens/anexos de e-mail
    email_messages    = relationship("EmailMessage",    back_populates="empresa", cascade="all, delete-orphan")
    email_attachments = relationship("EmailAttachment", back_populates="empresa", cascade="all, delete-orphan")

    # ---------- Helpers de plano (WhatsApp/instâncias) ----------
    @property
    def plano(self) -> str:
        """Alias para compat: lê o campo `assinatura`."""
        return normalize_plan(self.assinatura or PLAN_FREE)

    @plano.setter
    def plano(self, value: str) -> None:
        """Alias para compat: escreve no campo `assinatura`."""
        self.assinatura = normalize_plan(value or PLAN_FREE)

    @property
    def trial_active(self) -> bool:
        return plan_is_trial_active(self)

    @property
    def paid_active(self) -> bool:
        """Ativo se assinatura != FREE e (sem expiração ou não expirado)."""
        return plan_is_paid_active(self)

    @property
    def effective_tier(self) -> str:
        """Prioridade: PAGO > TRIAL > FREE"""
        return resolve_effective_plan(self)

    # ---------- Helpers do Módulo de E-mail ----------
    @property
    def email_paid_active(self) -> bool:
        """Plano PAGO de e-mail está ativo?"""
        if not self.email_assinatura:
            return False
        if not self.email_plano_expira_em:
            return True
        return datetime.now(timezone.utc) < self.email_plano_expira_em

    @property
    def email_trial_active(self) -> bool:
        """Trial de e-mail ativo?"""
        if not (self.email_trial_tier and self.email_trial_expires_at):
            return False
        return datetime.now(timezone.utc) < self.email_trial_expires_at

    @property
    def email_quota_effective(self) -> int:
        """
        Cota efetiva de caixas de e-mail:
        override -> plano pago -> trial -> 0.

        Mantive compatibilidade com tiers legados também.
        """
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

            # compat legado eventual
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
# EmpresaInstancia (multi-whatsapp por empresa)
# =========================
class EmpresaInstancia(Base):
    __tablename__ = "empresas_instancias"

    id = Column(Integer, primary_key=True)
    empresa_id = Column(Integer, ForeignKey("empresas.id", ondelete="CASCADE"), nullable=False)

    # identificador/slug interno da instância no Evolution
    instance_name = Column(String, nullable=False, index=True, unique=True)

    apelido = Column(String, nullable=True)
    numero_instancia = Column(String, nullable=True)

    connected = Column(Boolean, nullable=False, server_default="false")
    last_seen = Column(TIMESTAMP(timezone=True), nullable=True)

    # =========================
    # Saúde do Número
    # =========================
    # NULL = ainda não analisado
    score = Column(Integer, nullable=True, index=True)

    # ex.: "boa" | "atencao" | "alto_risco" | "critico"
    score_status = Column(String(30), nullable=True, index=True)

    # ex.: "Boa" | "Atenção" | "Alto risco" | "Crítico"
    score_label = Column(String(50), nullable=True)

    # resumo curto para exibir no modal/tela
    score_resumo = Column(Text, nullable=True)

    # listas e métricas salvas da última análise
    score_motivos = Column(JSONB, nullable=True)
    score_metricas = Column(JSONB, nullable=True)
    score_recomendacoes = Column(JSONB, nullable=True)

    # quando foi feita a última análise
    score_atualizado_em = Column(TIMESTAMP(timezone=True), nullable=True)

    # preferências de histórico: "none" | "24h" | "7d"
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

    def __repr__(self) -> str:
        return (
            f"<EmpresaInstancia id={self.id} emp={self.empresa_id} "
            f"inst={self.instance_name!r} connected={self.connected} "
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

    telefone_norm = Column(
        String,
        nullable=False,
        server_default=FetchedValue(),
        server_onupdate=FetchedValue(),
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

    empresa   = relationship("Empresa", back_populates="clientes")
    mensagens = relationship("Mensagem", back_populates="cliente", cascade="all, delete-orphan")
    midias    = relationship("Midia", back_populates="cliente", cascade="all, delete-orphan")

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
        Index("ix_mensagens_msg_id", "msg_id"),
        Index("ix_mensagens_empresa_cliente_ts", "empresa_id", "cliente_id", "timestamp"),
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

    conteudo  = Column(Text,   nullable=False)
    tipo      = Column(String, nullable=False)  # 'entrada' | 'saida'
    lida      = Column(Boolean, default=False)
    timestamp = Column(TIMESTAMP(timezone=True), server_default=func.now())

    msg_id = Column(String, index=True)
    ack    = Column(Integer, default=0)

    cliente     = relationship("Cliente", back_populates="mensagens")
    instancia   = relationship("EmpresaInstancia", back_populates="mensagens")
    atendimento = relationship("Atendimento", back_populates="mensagens")

    apagada_cliente = Column(Boolean, nullable=False, default=False)
    apagada_usuario = Column(Boolean, nullable=False, default=False)

    def __repr__(self) -> str:
        return f"<Mensagem id={self.id} cli={self.cliente_id} inst={self.instancia_id} atd={self.atendimento_id} tipo={self.tipo} ts={self.timestamp}>"


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
    )

    id            = Column(Integer, primary_key=True, index=True)
    empresa_id    = Column(Integer, ForeignKey("empresas.id"))
    cliente_id    = Column(Integer, ForeignKey("clientes.id"))
    grupo_id      = Column(BigInteger, ForeignKey("grupos.id"), nullable=True, index=True)
    mensagem_id   = Column(Integer, ForeignKey("mensagens.id"))
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


class AtendimentoPinnedConversa(Base):
    __tablename__ = "atendimento_pinned_conversas"
    __table_args__ = (
        UniqueConstraint("empresa_id", "user_id", "conversa_id", name="pk_pinned_emp_user_conv"),
        Index("ix_pinned_user", "empresa_id", "user_id"),
        Index("ix_pinned_conv", "empresa_id", "conversa_id"),
    )

    empresa_id  = Column(Integer, ForeignKey("empresas.id",  ondelete="CASCADE"), nullable=False, primary_key=True)
    user_id     = Column(Integer, ForeignKey("usuarios.id",  ondelete="CASCADE"), nullable=False, primary_key=True)
    conversa_id = Column(Integer, ForeignKey("clientes.id",  ondelete="CASCADE"), nullable=False, primary_key=True)

    pinned_at   = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    empresa  = relationship("Empresa")
    usuario  = relationship("Usuario")
    conversa = relationship("Cliente")

    atendimento_id = Column(Integer, ForeignKey("atendimentos.id"), nullable=True)

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
    usuario_id = Column(Integer, ForeignKey('usuarios.id'), nullable=True)

    nome       = Column(String(60), nullable=False)
    email      = Column(String(120), nullable=False, unique=True)
    senha      = Column(String(200), nullable=False)
    telefone   = Column(String(20), nullable=True)
    cargo      = Column(String(50), nullable=True)

    avatar_data = Column(LargeBinary, nullable=True)
    avatar_mime = Column(String, nullable=True)

    empresa = relationship("Empresa", back_populates="colaboradores")
    setor   = relationship("Setor", back_populates="colaboradores")
    usuario = relationship("Usuario")

    hora_login_inicio = Column(String(5), nullable=True)
    hora_login_fim    = Column(String(5), nullable=True)

    login_token = Column(String(20), nullable=True)
    login_token_expires_at = Column(DateTime(timezone=True), nullable=True)

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

    id          = Column(Integer, primary_key=True)
    cliente_id  = Column(Integer, index=True)
    operador_id = Column(Integer, index=True)

    instancia_id = Column(
        Integer,
        ForeignKey("empresas_instancias.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    criado_em = Column(
        TIMESTAMP(timezone=True),
        server_default=func.now(),
    )

    atualizado_em = Column(
        TIMESTAMP(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
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

    mensagens = relationship(
        "Mensagem",
        back_populates="atendimento",
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return f"<Atendimento id={self.id} cli={self.cliente_id} inst={self.instancia_id} status={self.status}>"


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
# ChatbotConfig (por instancia_id)
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


# =======================================================
# Chat Interno — MODELO (1 tabela + estado de leitura)
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
    colaborador_id  = Column(Integer, nullable=False, index=True)
    role            = Column(String(32), nullable=False, server_default="member")
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
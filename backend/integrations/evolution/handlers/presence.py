"""Presença de contatos do WhatsApp desativada.

A Evolution usada pelo ZapsChat não fornece de forma confiável os eventos de
online, digitando, gravando áudio ou visto por último. Este módulo permanece
intencionalmente sem registrar handler de PRESENCE_UPDATE.

Os ACKs/status das mensagens (enviado, entregue e lido) são tratados por outros
handlers e não são afetados por esta desativação.
"""

__all__: list[str] = []

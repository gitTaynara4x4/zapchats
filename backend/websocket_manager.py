# backend/websocket_manager.py
from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Dict, Mapping, List
from fastapi import WebSocket


class WebSocketManager:
    def __init__(self) -> None:
        # Mapa: nome_do_grupo -> { ws_id: WebSocket }
        self.grupos: Dict[str, Dict[int, WebSocket]] = defaultdict(dict)
        self._lock = asyncio.Lock()

    # --- compat: alguns códigos antigos iteravam sobre .active_connections ---
    @property
    def active_connections(self) -> Mapping[str, Dict[int, WebSocket]]:
        # apenas leitura; usa o mesmo dicionário interno
        return self.grupos

    async def connect(self, websocket: WebSocket, grupo: str) -> None:
        """Aceita a conexão e registra o socket no grupo."""
        await websocket.accept()
        wsid = id(websocket)
        async with self._lock:
            self.grupos[grupo][wsid] = websocket

    async def disconnect(self, websocket: WebSocket, grupo: str) -> None:
        """Remove o socket do grupo (se existir). Erros são silenciosos."""
        wsid = id(websocket)
        async with self._lock:
            bucket = self.grupos.get(grupo)
            if bucket and wsid in bucket:
                bucket.pop(wsid, None)
                if not bucket:
                    self.grupos.pop(grupo, None)
        try:
            await websocket.close()
        except Exception:
            pass

    async def send_message(self, grupo: str, data) -> None:
        """
        Envia JSON para todos os sockets do grupo.
        Faz snapshot sob lock e envia fora para evitar deadlocks.
        Remove conexões quebradas.
        """
        async with self._lock:
            targets = list(self.grupos.get(grupo, {}).values())

        for ws in targets:
            try:
                await ws.send_json(data)
            except Exception:
                try:
                    await self.disconnect(ws, grupo)
                except Exception:
                    pass

    async def broadcast_all(self, data) -> None:
        """
        Envia JSON para **todos** os grupos.
        Útil para eventos gerais (ex.: /broadcast).
        """
        async with self._lock:
            grupos = list(self.grupos.keys())

        for g in grupos:
            await self.send_message(g, data)

    async def broadcast(self, grupo: str, data) -> None:
        """
        Alias compatível para códigos que chamam `conexoes_ativas.broadcast(grupo, data)`.
        """
        await self.send_message(grupo, data)

    def list_groups(self) -> List[str]:
        """Retorna os nomes dos grupos atuais (apenas para debug/inspeção)."""
        return list(self.grupos.keys())


# Instância global usada pelo app
conexoes_ativas = WebSocketManager()

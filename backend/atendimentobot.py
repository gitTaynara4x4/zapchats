from datetime import datetime
import pytz
from backend import models
import requests
from fastapi import HTTPException
from dotenv import load_dotenv
import os

load_dotenv()

# Configurações da Evolution API
EVOLUTION_URL = os.getenv("EVOLUTION_URL")
EVOLUTION_APIKEY = os.getenv("EVOLUTION_APIKEY")
HEADERS = {"apikey": EVOLUTION_APIKEY, "Content-Type": "application/json"} if EVOLUTION_APIKEY else {}


MENU_SETORES = "*Atendimento ZapChats 🤖*\nDigite o número do setor desejado:\n\n"

async def enviar_menu_se_novo_ou_24h(db, empresa, cliente, conexoes_ativas, HEADERS, EVOLUTION_URL):
    agora = datetime.now(pytz.timezone("America/Sao_Paulo"))
    
    # Verificar se é a primeira mensagem do cliente
    ultima_entrada = db.query(models.Mensagem).filter_by(cliente_id=cliente.id, tipo="entrada").order_by(models.Mensagem.timestamp.desc()).first()
    
    if not ultima_entrada:  # Primeira mensagem do cliente
        # Buscar setores da empresa
        setores = db.query(models.Setor).filter_by(empresa_id=empresa.id).all()
        
        if not setores:
            return "Nenhum setor cadastrado para esta empresa."
        
        # Montar menu dinâmico de setores
        menu_seletor = MENU_SETORES
        for index, setor in enumerate(setores, 1):
            menu_seletor += f"{index}️⃣ {setor.nome}\n"
        
        # Salvar mensagem no banco
        msg = models.Mensagem(
            empresa_id=empresa.id,
            cliente_id=cliente.id,
            conteudo=menu_seletor,
            tipo="saida",
            lida=True,
            timestamp=agora.replace(tzinfo=None)
        )
        db.add(msg)
        db.commit()

        # Enviar para o Evolution (API)
        if empresa.instance_name and HEADERS:
            try:
                r = requests.post(
                    f"{EVOLUTION_URL}/message/sendText/{empresa.instance_name}",
                    json={"number": cliente.telefone, "text": menu_seletor},
                    headers=HEADERS, timeout=10
                )
                print("[BOT] Enviado via Evolution:", r.status_code)
            except Exception as e:
                print("[BOT] Falha no envio Evolution:", e)

        # Enviar a mensagem para o painel do atendente via WebSocket
        await conexoes_ativas.send_message(
            f"emp:{empresa.id}",
            {
                "empresa_id": empresa.id,
                "cliente_id": cliente.id,
                "telefone": cliente.telefone,
                "avatar_url": cliente.avatar_url,
                "mensagem": menu_seletor,
                "tipo": "saida",
                "origem": "bot",
                "timestamp": msg.timestamp.isoformat()
            }
        )


# Função que processa a resposta do cliente e redireciona para o atendente
async def redirecionar_para_atendente(db, empresa, cliente, setor_id, conexoes_ativas):
    # Buscar setor escolhido
    setor = db.query(models.Setor).filter_by(id=setor_id, empresa_id=empresa.id).first()
    
    if not setor:
        raise HTTPException(status_code=404, detail="Setor não encontrado")
    
    # Buscar o colaborador responsável pelo setor
    colaborador = db.query(models.Colaborador).filter_by(setor_id=setor.id).first()
    
    if not colaborador:
        raise HTTPException(status_code=404, detail="Colaborador não encontrado para o setor.")
    
    # Redirecionar a conversa para o colaborador
    msg = models.Mensagem(
        empresa_id=empresa.id,
        cliente_id=cliente.id,
        conteudo=f"Você foi redirecionado para o setor {setor.nome}, atendido por {colaborador.nome}.",
        tipo="saida",
        lida=True,
        timestamp=datetime.now(pytz.timezone("America/Sao_Paulo")).replace(tzinfo=None)
    )
    db.add(msg)
    db.commit()

    # Enviar para o Evolution (API) ou painel de atendimento
    if empresa.instance_name and HEADERS:
        try:
            r = requests.post(
                f"{EVOLUTION_URL}/message/sendText/{empresa.instance_name}",
                json={"number": cliente.telefone, "text": msg.conteudo},
                headers=HEADERS, timeout=10
            )
            print("[BOT] Enviado via Evolution:", r.status_code)
        except Exception as e:
            print("[BOT] Falha no envio Evolution:", e)

    # Enviar a mensagem para o painel do atendente via WebSocket
    await conexoes_ativas.send_message(
        f"emp:{empresa.id}",
        {
            "empresa_id": empresa.id,
            "cliente_id": cliente.id,
            "telefone": cliente.telefone,
            "avatar_url": cliente.avatar_url,
            "mensagem": msg.conteudo,
            "tipo": "saida",
            "origem": "bot",
            "timestamp": msg.timestamp.isoformat()
        }
    )
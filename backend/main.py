from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import os
import json

import time
import os
from dotenv import load_dotenv

# Carrega as variáveis do arquivo .env
load_dotenv()

# Puxa a senha (se não achar o arquivo, joga um erro pra você não rodar o server desprotegido)
BOT_SECRET_TOKEN = os.getenv("BOT_SECRET_TOKEN")
if not BOT_SECRET_TOKEN:
    raise ValueError("⚠️ Faltou a BOT_SECRET_TOKEN no arquivo .env!")

ADMIN_SECRET_TOKEN = os.getenv("ADMIN_SECRET_TOKEN")
if not ADMIN_SECRET_TOKEN:
    raise ValueError("⚠️ Faltou a ADMIN_SECRET_TOKEN no arquivo .env!")

ADMIN_USERNAME = os.getenv("ADMIN_USERNAME")

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []
        self.chat_history: list[dict] = []
        
        # --- A ALMA DO SERVIDOR (Vamos poder editar isso via painel depois!) ---
        self.server_config = {
            "tab_name": "SuppaTalk",
            "server_name": "LocalHost Server",
            "text_channels": ["geral", "comandos-bot"],
            "voice_channels": ["Geral"]
        }

        self.voice_states = {}
        self.online_users = {}

        # --- NOVO: Escudo Anti-Flood (Rate Limiting) ---
        self.message_rate = {} # Guarda os horários das mensagens de cada um
        self.RATE_LIMIT_MAX = 5     # Máximo de mensagens permitidas
        self.RATE_LIMIT_WINDOW = 2.0  # Dentro dessa janela de tempo (em segundos)
        self.TIMEOUT_PENALTY = 10.0 # Segundos de silêncio absoluto!
        self.muted_until = {}       # Guarda quem está na cadeia e até quando

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        
        # 1. Envia as configurações do servidor para o navegador montar a tela
        await websocket.send_json({
            "type": "server_init",
            "config": self.server_config
        })

        # 2. Depois envia as mensagens antigas
        for msg in self.chat_history:
            await websocket.send_json(msg)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast_json(self, message: dict, sender: WebSocket = None):

        # --- INTERCEPTADOR DO ARO VERDE ---
        if message.get("type") == "speaking":
            sender = None # Força a retransmitir para os outros navegadores

        # --- NOVO: IDENTIFICAÇÃO DE USUÁRIO (AUTENTICAÇÃO ZERO TRUST) ---
        # --- IDENTIFICAÇÃO DE USUÁRIO (ZERO TRUST TUNADO) ---
        if message.get("type") == "identify":
            user_name = message.get("user", "Sem Nome").strip()
            token = message.get("token", "")
            role = "user"

            # 1. Verifica se é o Bot VIP
            if token == BOT_SECRET_TOKEN:
                role = "bot"
                user_name = "TrindasBot (MVP)"
            
            # 2. Verifica se é o Mago (Admin)
            elif token == ADMIN_SECRET_TOKEN:
                role = "admin"
                user_name = ADMIN_USERNAME
            
            # 3. É um mero mortal. Vamos checar se ele tá tentando dar golpe!
            else:
                if "bot" in user_name.lower() or "trindas" in user_name.lower():
                    user_name = f"Fake_{user_name}"
                elif user_name.lower() == ADMIN_USERNAME.lower():
                    user_name = f"Impostor_{user_name}" # Tentou roubar seu nome!

            # Salva a Ficha
            self.online_users[sender] = {
                "username": user_name,
                "avatar": message.get("avatar"),
                "role": role
            }
            
            message = {"type": "member_list", "members": list(self.online_users.values())}
            sender = None

        # --- INTERCEPTADOR DO RADAR DE VOZ ---
        if message.get("type") == "join_voice":
            user = message.get("user")
            self.voice_states[user] = {
                "channel": message.get("channel"),
                "avatar": message.get("avatar")
            }
            # Muta a mensagem pra avisar todo mundo do novo radar
            message = {"type": "voice_update", "states": self.voice_states}
            sender = None 
            
        elif message.get("type") == "leave_voice":
            user = message.get("user")
            if user in self.voice_states:
                del self.voice_states[user]
            message = {"type": "voice_update", "states": self.voice_states}
            sender = None
        
        # --- INTERCEPTADOR DE NOVOS CANAIS ---
        if message.get("type") == "create_channel":
            c_type = message.get("channel_type")
            c_name = message.get("name")
            
            # Adiciona na memória do Python (se já não existir)
            if c_type == "text" and c_name not in self.server_config["text_channels"]:
                self.server_config["text_channels"].append(c_name)
            elif c_type == "voice" and c_name not in self.server_config["voice_channels"]:
                self.server_config["voice_channels"].append(c_name)
            
            # Muta a mensagem para virar um "Aviso de Atualização"
            message = {
                "type": "server_update", 
                "config": self.server_config
            }
            # Forçamos o sender a ser None para que o Python mande essa atualização 
            # de volta para VOCÊ também, pra sua tela atualizar na hora!
            sender = None 

        elif message.get("type") == "update_server":
            # ZERO TRUST: Só o Admin pode mudar o nome do servidor!
            user_data = self.online_users.get(sender)
            if not user_data or user_data["role"] != "admin":
                return # Ignora o ataque silenciosamente
            
            self.server_config["server_name"] = message.get("server_name")
            self.server_config["tab_name"] = message.get("tab_name")
            
            message = {"type": "server_update", "config": self.server_config}
            sender = None
            
        # --- Lógica normal de chat (BLINDADA E ANTI-FLOOD) ---
        elif message.get("type") == "chat":
            if sender in self.online_users:
                user_data = self.online_users[sender]
                message["author"] = user_data["username"]
                message["avatar"] = user_data["avatar"]
                message["role"] = user_data["role"]
            else:
                return # Invasor fantasma

            # --- ESCUDO ANTI-FLOOD (COM PRISÃO) ---
            if user_data["role"] != "bot" and sender:
                now = time.time()
                
                if sender in self.muted_until:
                    if now < self.muted_until[sender]:
                        return 
                    else:
                        del self.muted_until[sender]
                        self.message_rate[sender] = []

                if sender not in self.message_rate:
                    self.message_rate[sender] = []
                    
                self.message_rate[sender] = [t for t in self.message_rate[sender] if now - t < self.RATE_LIMIT_WINDOW]
                
                if len(self.message_rate[sender]) >= self.RATE_LIMIT_MAX:
                    self.muted_until[sender] = now + self.TIMEOUT_PENALTY
                    aviso = {
                        "type": "chat", "id": f"sys-{now}", "channel": message.get("channel", "geral"),
                        "author": "🛡️ Sistema Anti-Flood", "avatar": "https://api.dicebear.com/7.x/bottts/svg?seed=Shield&backgroundColor=da373c",
                        "text": f"🚨 O martelo bateu! Você foi silenciado por {int(self.TIMEOUT_PENALTY)} segundos por flood.",
                        "role": "bot"
                    }
                    await sender.send_json(aviso)
                    return 
                
                self.message_rate[sender].append(now)

            # SALVA NO HISTÓRICO APENAS UMA ÚNICA VEZ!
            self.chat_history.append(message)
            
        elif message.get("type") == "delete":
            user_data = self.online_users.get(sender)
            if not user_data:
                return 

            msg_id_to_delete = message.get("id")
            msg_to_delete = next((m for m in self.chat_history if m.get("id") == msg_id_to_delete), None)
            
            if not msg_to_delete:
                return 
                
            if user_data["username"] == msg_to_delete["author"] or user_data["role"] == "admin":
                self.chat_history = [msg for msg in self.chat_history if msg.get("id") != msg_id_to_delete]
            else:
                return 

        # Dispara pros navegadores (O ECO)
        for connection in self.active_connections:
            await connection.send_json(message)

manager = ConnectionManager()

@app.get("/")
async def get():
    with open(os.path.join("static", "index.html"), "r") as f:
        return HTMLResponse(f.read())

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            await manager.broadcast_json(data, sender=websocket)
    except WebSocketDisconnect:
        manager.disconnect(websocket)
        # Limpa da lista de online
        if websocket in manager.online_users:
            del manager.online_users[websocket]
            await manager.broadcast_json({
                "type": "member_list", 
                "members": list(manager.online_users.values())
            }, sender=None)
        
        # Limpa do escudo Anti-Flood pra não gastar RAM à toa!
        if websocket in manager.message_rate:
            del manager.message_rate[websocket]
        if websocket in manager.muted_until:
            del manager.muted_until[websocket]
    except json.JSONDecodeError:
        print("Recebeu algo que não é JSON. Ignorando...")

#      ______ _   _____             _  __                                  
#     |  ____| | |  __ \           | |/ /                                  
#     | |__  | | | |__) |__ _   _  | ' / ___  _ __   __ _ _ __ ___   ___   
#     |  __| | | |  ___/ __| | | | |  < / _ \| '_ \ / _` | '__/ _ \ / _ \  
#     | |____| | | |   \__ \ |_| | | . \ (_) | | | | (_| | | | (_) | (_) | 
#     |______|_| |_|   |___/\__, | |_|\_\___/|_| |_|\__, |_|  \___/ \___(_)
#                            __/ |                   __/ |                 
#                           |___/                   |___/                  
#by SuppaHackaD
        

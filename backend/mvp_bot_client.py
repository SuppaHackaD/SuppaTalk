import asyncio
import websockets
import json
import random
import os
import av
import fractions

from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStreamTrack
from aiortc.contrib.media import MediaPlayer, MediaRelay
from aiortc.sdp import candidate_from_sdp

import os
from dotenv import load_dotenv

load_dotenv()
BOT_SECRET_TOKEN = os.getenv("BOT_SECRET_TOKEN")

MVP_URI = os.getenv("MVP_URI", "ws://api_server:8000/ws")
BOT_NAME = "TrindasBot (MVP)"
BOT_AVATAR = "https://api.dicebear.com/7.x/bottts/svg?seed=TrindasBot&backgroundColor=5865f2"

PASTA_MUSICAS = os.path.join(".", "musicas")
PASTA_PLAYLISTS = os.path.join(".", "playlists")

fila_musicas = []
historico_musicas = []

# --- O NOVO MOTOR MULTIPLAYER (A TORRE DE RÁDIO) ---
pcs = set()             # Agora guarda 1, 2 ou 100 conexões de usuários!
active_rtc_sessions = {}
relay = MediaRelay()    # O clonador de sinal
motor_track_global = None # A fita central que todos vão escutar

bot_ready = False       
card_id = None          
nome_faixa_atual = "Nenhuma fita"
status_atual = "Aguardando conexão..."
loop_mode = "off"
voltando_faixa = False

def gerar_id(): return str(random.randint(100000, 999999))

async def enviar_mensagem(ws, texto, reply_to=None):
    msg_data = {"type": "chat", "id": "msg-bot-" + gerar_id(), "channel": "comandos-bot", "author": BOT_NAME, "avatar": BOT_AVATAR, "text": texto}
    if reply_to: msg_data["replyTo"] = reply_to
    await ws.send(json.dumps(msg_data))

async def atualizar_interface(ws):
    global card_id, motor_track_global, fila_musicas, nome_faixa_atual, status_atual, loop_mode
    
    fila_texto = f"Músicas na fila: {len(fila_musicas)}" if fila_musicas else "Fila vazia"
    is_paused = motor_track_global.pausado if motor_track_global else False
    
    if is_paused:
        btn_play_pause = "<button onclick='sendHiddenCommand(\"!resume\")' style='background: #248046; border: none; padding: 6px 10px; border-radius: 4px; color: white; cursor: pointer; font-size: 12px; transition: 0.2s;'>▶️ Retomar</button>"
    else:
        btn_play_pause = "<button onclick='sendHiddenCommand(\"!pause\")' style='background: #e3a01b; border: none; padding: 6px 10px; border-radius: 4px; color: white; cursor: pointer; font-size: 12px; transition: 0.2s;'>⏸️ Pausar</button>"

    if loop_mode == "off":
        btn_loop = "<button onclick='sendHiddenCommand(\"!loop\")' style='background: #4f545c; border: none; padding: 6px 10px; border-radius: 4px; color: white; cursor: pointer; font-size: 12px; transition: 0.2s;'>🔁 Off</button>"
    elif loop_mode == "queue":
        btn_loop = "<button onclick='sendHiddenCommand(\"!loop\")' style='background: #248046; border: none; padding: 6px 10px; border-radius: 4px; color: white; cursor: pointer; font-size: 12px; transition: 0.2s;'>🔁 Fila</button>"
    else:
        btn_loop = "<button onclick='sendHiddenCommand(\"!loop\")' style='background: #248046; border: none; padding: 6px 10px; border-radius: 4px; color: white; cursor: pointer; font-size: 12px; transition: 0.2s;'>🔂 Música</button>"

    html = f"""
    <div style='background-color: #2b2d31; border-left: 4px solid #5865f2; padding: 12px; border-radius: 4px; margin-top: 5px; width: 320px; box-shadow: 0 4px 6px rgba(0,0,0,0.3);'>
        <div style='display: flex; align-items: center; gap: 8px; margin-bottom: 5px;'>
            <span style='font-size: 16px;'>🎧</span>
            <h4 style='margin: 0; color: #5865f2; font-family: sans-serif;'>Trindas Player</h4>
        </div>
        <span style='color: #dbdee1; font-weight: bold; font-size: 14px; word-break: break-all;'>{nome_faixa_atual}</span><br>
        <span style='font-size: 11px; color: #2ecc71; font-weight: bold;'>{status_atual}</span><br>
        <span style='font-size: 11px; color: #949ba4; margin-bottom: 10px; display: block;'>{fila_texto}</span>
        
        <div style='display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;'>
            <button onclick='sendHiddenCommand("!previous")' style='background: #4f545c; border: none; padding: 6px 10px; border-radius: 4px; color: white; cursor: pointer; font-size: 12px; transition: 0.2s;'>⏪ Voltar</button>
            {btn_play_pause}
            <button onclick='sendHiddenCommand("!skip")' style='background: #4f545c; border: none; padding: 6px 10px; border-radius: 4px; color: white; cursor: pointer; font-size: 12px; transition: 0.2s;'>⏭️ Pular</button>
            <button onclick='sendHiddenCommand("!stop")' style='background: #da373c; border: none; padding: 6px 10px; border-radius: 4px; color: white; cursor: pointer; font-size: 12px; transition: 0.2s;'>⏹️ Parar</button>
            {btn_loop}
            <button onclick='sendHiddenCommand("!shuffle")' style='background: #4f545c; border: none; padding: 6px 10px; border-radius: 4px; color: white; cursor: pointer; font-size: 12px; transition: 0.2s;'>🔀 Mix</button>
        </div>
    </div>
    """

    if card_id is None:
        card_id = "msg-bot-" + gerar_id()
        msg_data = {"type": "chat", "id": card_id, "channel": "comandos-bot", "author": BOT_NAME, "avatar": BOT_AVATAR, "text": html}
        await ws.send(json.dumps(msg_data))
    else:
        msg_data = {"type": "edit", "id": card_id, "text": html}
        await ws.send(json.dumps(msg_data))


class MotorAudioTrack(MediaStreamTrack):
    kind = "audio"
    def __init__(self, ws):
        super().__init__()
        self.ws = ws
        self.player_atual = None
        self.pts = 0  
        self.pausado = False

    async def _gerar_silencio(self):
        await asyncio.sleep(0.02)
        frame = av.AudioFrame(format='s16', layout='stereo', samples=960)
        frame.sample_rate = 48000
        for p in frame.planes: p.update(bytes(p.buffer_size))
        frame.time_base = fractions.Fraction(1, 48000)
        return frame

    async def _pegar_proximo_frame(self):
        if self.pausado: return await self._gerar_silencio()

        if self.player_atual:
            try: return await self.player_atual.audio.recv()
            except Exception: self.player_atual = None

        if fila_musicas:
            global nome_faixa_atual, status_atual, loop_mode, historico_musicas, voltando_faixa
            
            if nome_faixa_atual != "Nenhuma fita" and not voltando_faixa:
                historico_musicas.append(nome_faixa_atual)
                if len(historico_musicas) > 50: historico_musicas.pop(0)
            
            voltando_faixa = False
            proxima = fila_musicas.pop(0)
            
            if loop_mode == "queue": fila_musicas.append(proxima)
            elif loop_mode == "song": fila_musicas.insert(0, proxima)

            caminho = os.path.join(PASTA_MUSICAS, proxima)
            if os.path.exists(caminho):
                self.player_atual = MediaPlayer(caminho)
                nome_faixa_atual = proxima
                status_atual = "▶️ Tocando Áudio"
                asyncio.create_task(atualizar_interface(self.ws))
                return await self._pegar_proximo_frame()

        return await self._gerar_silencio()

    async def recv(self):
        frame = await self._pegar_proximo_frame()
        frame.pts = self.pts
        self.pts += frame.samples
        return frame


async def processar_comando(ws, comando, dados_msg):
    global fila_musicas, historico_musicas, motor_track_global, status_atual, nome_faixa_atual, loop_mode, voltando_faixa
    if not bot_ready: return
    
    partes = comando.split(" ")
    cmd = partes[0].lower()
    argumentos = " ".join(partes[1:])

    if cmd == "!playl":
        if not argumentos: return await enviar_mensagem(ws, "❌ Diga o nome da música!")
        
        # BLINDAGEM: os.path.basename() arranca caminhos relativos (../)
        nome_seguro = os.path.basename(argumentos) 
        nome_arquivo = nome_seguro + ".mp3" if not nome_seguro.endswith(".mp3") else nome_seguro
        
        if not os.path.exists(os.path.join(PASTA_MUSICAS, nome_arquivo)):
            return await enviar_mensagem(ws, f"❌ Não achei `{nome_arquivo}` na pasta.")
        
        if not motor_track_global: status_atual = "⚠️ Ligue a call de voz para tocar!"
        fila_musicas.append(nome_arquivo)
        status_atual = f"✅ Adicionado: {nome_arquivo}"
        await atualizar_interface(ws)

    elif cmd == "!playlistl":
        if not argumentos: return await enviar_mensagem(ws, "❌ Diga o nome da playlist!")
        nome_seguro = os.path.basename(argumentos)
        nome_pl = nome_seguro + ".m3u" if not nome_seguro.endswith(".m3u") else nome_seguro
        caminho_pl = os.path.join(PASTA_PLAYLISTS, nome_pl)
        if not os.path.exists(caminho_pl): return await enviar_mensagem(ws, f"❌ Playlist não encontrada.")
        
        adicionadas = 0
        with open(caminho_pl, 'r', encoding='utf-8') as f:
            for linha in f:
                linha = linha.strip()
                if linha and not linha.startswith('#'):
                    fila_musicas.append(os.path.basename(linha))
                    adicionadas += 1
        
        if not motor_track_global: status_atual = "⚠️ Ligue a call de voz para tocar!"
        status_atual = f"✅ Playlist carregada ({adicionadas} sons)!"
        await atualizar_interface(ws)

    elif cmd == "!shuffle":
        if len(fila_musicas) > 1:
            random.shuffle(fila_musicas)
            status_atual = "🔀 Fila embaralhada!"
        else: status_atual = "⚠️ Fila pequena demais."
        await atualizar_interface(ws)

    elif cmd == "!loop":
        if loop_mode == "off": loop_mode = "queue"; status_atual = "🔁 Repetição de Fila"
        elif loop_mode == "queue": loop_mode = "song"; status_atual = "🔂 Repetição de Música"
        else: loop_mode = "off"; status_atual = "➡️ Repetição Desativada"
        await atualizar_interface(ws)

    elif cmd == "!stop":
        fila_musicas.clear()
        historico_musicas.clear()
        if motor_track_global and motor_track_global.player_atual:
            motor_track_global.player_atual = None
            motor_track_global.pausado = False
        nome_faixa_atual = "Nenhuma fita"
        status_atual = "⏹️ Som parado."
        await atualizar_interface(ws)

    elif cmd == "!skipto":
        if not argumentos.isdigit(): return await enviar_mensagem(ws, "❌ Digite a posição!")
        idx = int(argumentos) - 1
        if 0 <= idx < len(fila_musicas):
            fila_musicas = fila_musicas[idx:]
            if motor_track_global and motor_track_global.player_atual: motor_track_global.player_atual = None
            status_atual = f"⏭️ Pulando pra música {idx+1}..."
            await atualizar_interface(ws)

    elif cmd == "!remove":
        if not argumentos.isdigit(): return await enviar_mensagem(ws, "❌ Digite a posição!")
        idx = int(argumentos) - 1
        if 0 <= idx < len(fila_musicas):
            removida = fila_musicas.pop(idx)
            status_atual = f"🗑️ Removida: {removida}"
            await atualizar_interface(ws)

    elif cmd == "!queue":
        if not fila_musicas: await enviar_mensagem(ws, "A fila está vazia no momento.")
        else:
            limite = min(15, len(fila_musicas))
            texto_fila = f"🎵 **Fila Atual ({limite} de {len(fila_musicas)}):**\n" + "\n".join([f"{i+1}. {m}" for i, m in enumerate(fila_musicas[:limite])])
            await enviar_mensagem(ws, texto_fila)
            
    elif cmd in ["!previous", "!back"]:
        if not historico_musicas:
            status_atual = "⚠️ Não há músicas no histórico."
            await atualizar_interface(ws)
        else:
            voltando_faixa = True
            musica_anterior = historico_musicas.pop()
            
            if motor_track_global and motor_track_global.player_atual and nome_faixa_atual != "Nenhuma fita":
                if not (loop_mode == "song" and fila_musicas and fila_musicas[0] == nome_faixa_atual):
                    fila_musicas.insert(0, nome_faixa_atual)
                    
            fila_musicas.insert(0, musica_anterior)
            
            if motor_track_global and motor_track_global.player_atual:
                motor_track_global.player_atual = None
                motor_track_global.pausado = False
            status_atual = "⏪ Voltando faixa..."
            await atualizar_interface(ws)

    elif cmd == "!skip":
        if motor_track_global and motor_track_global.player_atual:
            motor_track_global.player_atual = None
            motor_track_global.pausado = False
            if loop_mode == "song" and fila_musicas: fila_musicas.pop(0)
            status_atual = "⏭️ Pulando..."
            await atualizar_interface(ws)

    elif cmd == "!pause":
        if motor_track_global and not motor_track_global.pausado:
            motor_track_global.pausado = True
            status_atual = "⏸️ Pausado"
            await atualizar_interface(ws)

    elif cmd in ["!resume", "!play"]:
        if motor_track_global and motor_track_global.pausado:
            motor_track_global.pausado = False
            status_atual = "▶️ Retomado"
            await atualizar_interface(ws)


async def lidar_com_sinalizacao(ws, data):
    global active_rtc_sessions, motor_track_global, relay
    
    # 1. Checa quem está batendo na porta
    client_id = data.get("client_id")
    if not client_id: return 
    
    if data["type"] == "offer":
        canal_alvo = data.get("channel", "Geral")
        
        pc = RTCPeerConnection()
        active_rtc_sessions[client_id] = pc # Guarda a conexão amarrada ao Crachá
        
        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            if pc.connectionState in ["failed", "closed"]:
                active_rtc_sessions.pop(client_id, None) # Limpa a memória se o cara fechar a aba
        
        pc.addTrack(relay.subscribe(motor_track_global))
        
        oferta = RTCSessionDescription(sdp=data["offer"]["sdp"], type=data["offer"]["type"])
        await pc.setRemoteDescription(oferta)
        resposta = await pc.createAnswer()
        await pc.setLocalDescription(resposta)
        
        # 2. RESPONDE EXATAMENTE PARA O ALVO (target_id)
        await ws.send(json.dumps({
            "type": "answer", 
            "answer": {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type},
            "target_id": client_id
        }))
        
        await ws.send(json.dumps({
            "type": "join_voice",
            "channel": canal_alvo,
            "user": BOT_NAME,
            "avatar": BOT_AVATAR
        }))
        
        asyncio.create_task(atualizar_interface(ws))
        
    elif data["type"] == "ice":
        # 3. Direciona a rota de rede SÓ para a conexão daquela aba específica!
        if client_id in active_rtc_sessions:
            pc = active_rtc_sessions[client_id]
            try:
                cand_str = data["candidate"]["candidate"]
                if cand_str.startswith("candidate:"): cand_str = cand_str.split(":", 1)[1]
                await pc.addIceCandidate(candidate_from_sdp(cand_str, sdpMid=data["candidate"]["sdpMid"], sdpMLineIndex=data["candidate"]["sdpMLineIndex"]))
            except Exception:
                pass


async def desbloquear_bot():
    global bot_ready
    await asyncio.sleep(1) 
    bot_ready = True

async def rodar_bot():
    global motor_track_global
    
    # LOOP INFINITO DE RECONEXÃO: Se o servidor cair ou demorar, o bot não desiste!
    while True:
        print(f"[{BOT_NAME}] Conectando...")
        try:
            async with websockets.connect(MVP_URI) as ws:
                print(f"[{BOT_NAME}] ✅ Bot Ativo!")

                # O APERTO DE MÃO VIP
                await ws.send(json.dumps({
                    "type": "identify",
                    "user": BOT_NAME,
                    "avatar": BOT_AVATAR,
                    "token": BOT_SECRET_TOKEN
                }))
                
                motor_track_global = MotorAudioTrack(ws)
                asyncio.create_task(desbloquear_bot())
                
                # Loop interno ouvindo as mensagens
                while True:
                    mensagem_raw = await ws.recv()
                    try:
                        data = json.loads(mensagem_raw)
                        if (data.get("type") == "chat" and data.get("channel") == "comandos-bot" and data.get("author") != BOT_NAME and data.get("text", "").startswith("!")):
                            await processar_comando(ws, data["text"], data)
                        elif data.get("type") in ["offer", "ice"]:
                            if "candidate" in data and not data["candidate"]: continue
                            await lidar_com_sinalizacao(ws, data)
                    except json.JSONDecodeError: pass

        except Exception as e: 
            print(f"❌ Erro de conexão ({e}). Tentando de novo em 3 segundos...")
            await asyncio.sleep(3)

if __name__ == "__main__":
    asyncio.run(rodar_bot())
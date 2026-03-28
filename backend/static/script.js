// Verifica se já existe um usuário salvo no navegador
let currentUser = localStorage.getItem("mvp_username") || "";
let currentAvatar = localStorage.getItem("mvp_avatar") || "";
let currentToken = localStorage.getItem("mvp_token") || "";
let ws;
let replyingTo = null;

const mySessionId = "tab-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9);

let peerConnections = {};
let localStream;
const config = { 'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}] };

let currentChannel = "geral";
let allMessages = [];

let currentVoiceChannel = null;

// Executa assim que a página carrega
window.addEventListener('DOMContentLoaded', () => {
    if (currentUser && currentAvatar) {
        // Se já tem conta salva, esconde o login, atualiza a interface e conecta direto
        document.getElementById("loginOverlay").style.display = "none";
        showUserPanel();
        connectWebSocket();
    } else {
        // Se não tem conta, mostra a tela preta
        document.getElementById("loginOverlay").style.display = "flex";
    }
});

function doLogin(event) {
    event.preventDefault();
    const username = document.getElementById("usernameInput").value.trim();
    if (!username) return;

    currentUser = username;
    currentAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`;
    
    // Salva na memória do navegador para não pedir mais!
    localStorage.setItem("mvp_username", currentUser);
    localStorage.setItem("mvp_avatar", currentAvatar);

    document.getElementById("loginOverlay").style.display = "none";
    showUserPanel();
    connectWebSocket();
}

function doLogout() {
    // Limpa a memória do navegador
    localStorage.removeItem("mvp_username");
    localStorage.removeItem("mvp_avatar");
    // Dá um F5 forçado na página para voltar pra tela de login
    location.reload();
}

function showUserPanel() {
    // Atualiza a foto e o nome no canto inferior esquerdo
    document.getElementById("myAvatarDisplay").src = currentAvatar;
    document.getElementById("myUsernameDisplay").innerText = currentUser;
    document.getElementById("userPanel").style.display = "flex";
    
}

// --- LÓGICA DE CANAIS ---
function switchChannel(channelName) {
    currentChannel = channelName;
    
    // 1. Atualiza o visual da Barra Lateral e do Cabeçalho
    document.querySelectorAll('.channel').forEach(c => c.classList.remove('active'));
    document.getElementById('nav-' + channelName).classList.add('active');
    document.getElementById('chatHeader').innerText = "# " + channelName;
    document.getElementById('messageText').placeholder = "Conversar em #" + channelName;

    // 2. Limpa o chat atual da tela
    const messagesUl = document.getElementById('messages');
    messagesUl.innerHTML = '';
    
    // 3. Puxa da memória só as mensagens do canal novo e desenha na tela
    allMessages.forEach(msg => {
        if (msg.channel === currentChannel) {
            appendMessage(msg.id, msg.author, msg.avatar, msg.text, msg.replyTo);
        }
    });
}

// 2. Conexão e Chat
function connectWebSocket() {
    var ws_scheme = window.location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(ws_scheme + "://" + window.location.host + "/ws");

    ws.onopen = function() {
        //console.log("Conectado ao Templo da Magia!");
    
        // Grita pro servidor quem você é na mesma hora que logar!
        ws.send(JSON.stringify({
            type: "identify",
            user: currentUser,
            avatar: currentAvatar,
            token: currentToken
        }));
    };

    ws.onmessage = async function(event) {
        const data = JSON.parse(event.data);

        if (data.type === "server_init" || data.type === "server_update") {
            renderServerSettings(data.config);
            return; 
        }

        if (data.type === "voice_update") {
            renderVoiceUsers(data.states);
            return;
        }

        if (data.type === "speaking") {
            updateSpeakingRing(data.user, data.status);
            return;
        }

        if (data.type === "member_list") {
            renderMemberList(data.members);
            return;
        }
        
        if (data.type === "chat") {
            allMessages.push(data);
            // Só desenha se a mensagem não tiver a flag oculta e for pro canal certo
            if (data.channel === currentChannel && !data.hidden) {
                appendMessage(data.id, data.author, data.avatar, data.text, data.replyTo);
            }
        } 
        else if (data.type === "edit") {
            // O BOT MANDOU ATUALIZAR O CARD!
            // Atualiza na memória
            const msgObj = allMessages.find(m => m.id === data.id);
            if (msgObj) msgObj.text = data.text;
            
            // Atualiza na tela ao vivo
            const msgElement = document.getElementById(data.id);
            if (msgElement) {
                const contentSpan = msgElement.querySelector('.msg-content');
                if (contentSpan) contentSpan.innerHTML = data.text;
            }
        }
        else if (data.type === "delete") {
            allMessages = allMessages.filter(msg => msg.id !== data.id);
            const msgElement = document.getElementById(data.id);
            if (msgElement) msgElement.remove();
        }
        // --- Eventos do WebRTC (Malha P2P) ---
        else if (data.type === "offer") {
            // Se um amigo me ligar, eu atendo
            if (data.target === currentUser) {
                handleReceiveOffer(data.sender, data.offer);
            }
        }
        else if (data.type === "answer") {
            // O Bot responde usando target_id
            if (data.target_id === mySessionId && peerConnections["TrindasBot (MVP)"]) {
                peerConnections["TrindasBot (MVP)"].setRemoteDescription(new RTCSessionDescription(data.answer)).catch(()=>{});
            } 
            // Os amigos respondem usando target
            else if (data.target === currentUser && peerConnections[data.sender]) {
                peerConnections[data.sender].setRemoteDescription(new RTCSessionDescription(data.answer)).catch(()=>{});
            }
        }
        else if (data.type === "ice") {
            // Recebendo IPs/Portas (STUN) dos amigos
            if (data.target === currentUser && peerConnections[data.sender]) {
                peerConnections[data.sender].addIceCandidate(new RTCIceCandidate(data.candidate)).catch(()=>{});
            }
        }
}}

function startReply(msgId, author) {
    // Procura o texto da mensagem no ecrã para criar a citação
    const msgElement = document.querySelector(`#${msgId} .msg-content`);
    const textPreview = msgElement ? msgElement.innerText : "Mensagem original...";
    
    replyingTo = { id: msgId, author: author, text: textPreview };
    
    document.getElementById("replyTargetName").innerText = "@" + author;
    document.getElementById("replyIndicator").style.display = "flex";
    document.getElementById("messageText").focus();
}

function cancelReply() {
    replyingTo = null;
    document.getElementById("replyIndicator").style.display = "none";
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function sendMessage(event) {
    event.preventDefault();
    var input = document.getElementById("messageText");
    if (input.value.trim() !== "") {
        const msgData = {
            type: "chat",
            id: "msg-" + generateId(),
            channel: currentChannel, // <- NOVO: Avisa pro servidor em qual canal estamos
            author: currentUser,
            avatar: currentAvatar,
            text: input.value,
            replyTo: replyingTo
        };
        
        // Envia pro Python
        ws.send(JSON.stringify(msgData));
        
        input.value = '';
        if (typeof cancelReply === "function") cancelReply();
    }
}

function appendMessage(msgId, author, avatarUrl, text, replyTo = null) {
    // BLINDAGEM XSS: Se a mensagem não veio do nosso Bot oficial, neutraliza o HTML!
    let safeText = text;
    if (author !== "TrindasBot (MVP)") {
        safeText = escapeHTML(text);
    }
    var messages = document.getElementById('messages');
    var li = document.createElement('li');
    li.className = "msg-wrapper";
    li.id = msgId || "msg-" + generateId(); 
    
    const safeAuthor = author || "Misterioso";
    const safeAvatar = avatarUrl || "https://api.dicebear.com/7.x/bottts/svg?seed=Misterioso";
    const now = new Date();
    const timeString = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');

    // Botões de Ação: O Responder aparece para todos, o Eliminar apenas para as tuas mensagens
    let actionsHtml = `
    <div class="msg-actions">
        <button class="btn-action" title="Responder" onclick="startReply('${li.id}', '${safeAuthor}')">↩️</button>
        ${(safeAuthor === currentUser || currentToken !== "") ? `<button class="btn-action delete" title="Eliminar" onclick="deleteMessage('${li.id}')">🗑️</button>` : ""}
    </div>`;

    // Bloco da Citação Visual (só é renderizado se existir a variável replyTo)
    let replyHtml = "";
    if (replyTo) {
        replyHtml = `
        <div class="reply-preview" title="Ir para a mensagem" onclick="document.getElementById('${replyTo.id}')?.scrollIntoView({behavior: 'smooth', block: 'center'})">
            <span class="reply-author">@${replyTo.author}</span>
            <span class="reply-text">${replyTo.text}</span>
        </div>`;
    }

    li.innerHTML = `
        ${actionsHtml}
        <div style="display: flex; flex-direction: column; width: 100%;">
            ${replyHtml}
            <div style="display: flex; flex-direction: row; gap: 15px;">
                <div class="msg-avatar">
                    <img src="${safeAvatar}" alt="Avatar">
                </div>
                <div class="msg-body">
                    <div class="msg-header">
                        <span class="msg-author">${safeAuthor}</span>
                        <span class="msg-time">Hoje às ${timeString}</span>
                    </div>
                    <span class="msg-content">${safeText}</span>
                </div>
            </div>
        </div>
    `;
    messages.appendChild(li);
    messages.scrollTop = messages.scrollHeight;
}

function deleteMessage(msgId) {
    ws.send(JSON.stringify({ type: "delete", id: msgId }));
}

// --- 3. O MOTOR DA REDE MESH P2P ---

// Cria a conexão base que serve para qualquer amigo
function createBasePC(targetUser) {
    const pc = new RTCPeerConnection(config);
    peerConnections[targetUser] = pc;

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.ontrack = function(event) {
        // Cria uma caixa de som (audio tag) invisível exclusiva para esse usuário na hora!
        let audioEl = document.getElementById('audio-' + targetUser);
        if (!audioEl) {
            audioEl = document.createElement('audio');
            audioEl.id = 'audio-' + targetUser;
            audioEl.autoplay = true;
            document.body.appendChild(audioEl);
        }
        
        if (audioEl.srcObject !== event.streams[0]) {
            audioEl.srcObject = event.streams[0];
            let savedVol = localStorage.getItem('vol_' + targetUser);
            audioEl.volume = savedVol !== null ? savedVol : 1.0;
            audioEl.play().catch(e => console.error("Chrome bloqueou áudio de " + targetUser, e));
            monitorAudioStream(event.streams[0], targetUser);
        }
    };

    pc.onicecandidate = function(event) {
        if (event.candidate) {
            ws.send(JSON.stringify({ type: "ice", sender: currentUser, target: targetUser, candidate: event.candidate }));
        }
    };
    return pc;
}

// Quando você liga para um amigo que já estava na sala
async function initiateP2PConnection(targetUser) {
    const pc = createBasePC(targetUser);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: "offer", sender: currentUser, target: targetUser, offer: offer }));
}

// Quando um amigo entra na sala e liga para você
// Quando um amigo entra na sala e liga para você
async function handleReceiveOffer(senderUser, offer) {
    // Se a conexão não existe, cria. Se já existe, reaproveita!
    let pc = peerConnections[senderUser];
    if (!pc) {
        pc = createBasePC(senderUser);
    }
    
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: "answer", sender: currentUser, target: senderUser, answer: answer }));
}

// A conexão blindada VIP só para o Bot
async function connectToBot(channelName) {
    const pc = new RTCPeerConnection(config);
    peerConnections["TrindasBot (MVP)"] = pc;

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.ontrack = function(event) {
        const remoteAudio = document.getElementById('remoteAudio');
        if (remoteAudio.srcObject !== event.streams[0]) {
            remoteAudio.srcObject = event.streams[0];
            let savedVol = localStorage.getItem('vol_TrindasBot (MVP)');
            remoteAudio.volume = savedVol !== null ? savedVol : 1.0;
            remoteAudio.play().catch(e => console.error("Erro no Bot:", e));
            monitorAudioStream(event.streams[0], "TrindasBot (MVP)");
        }
    };

    pc.onicecandidate = function(event) {
        if (event.candidate) {
            ws.send(JSON.stringify({ type: "ice", client_id: mySessionId, candidate: event.candidate }));
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: "offer", offer: offer, channel: channelName, client_id: mySessionId }));
}



// --- FUNÇÕES DE CONFIGURAÇÃO (SETTINGS) ---

// --- CONFIGURAÇÕES DO PERFIL DO USUÁRIO (A engrenagem lá embaixo) ---
function openSettings() {
    document.getElementById('inputUsername').value = currentUser;
    
    // Deixa o campo limpo se for o avatar padrão do Dicebear
    const currentAv = currentAvatar.includes('dicebear') ? '' : currentAvatar;
    document.getElementById('inputAvatar').value = currentAv;
    
    // Puxa o token do cache pra preencher (escondido pelos asteriscos do input password)
    document.getElementById('inputToken').value = localStorage.getItem('discord_token') || "";
    
    document.getElementById('userSettingsModal').style.display = 'flex';
}

function closeSettings() {
    document.getElementById('userSettingsModal').style.display = 'none';
}

function saveSettings() {
    const newName = document.getElementById('inputUsername').value.trim();
    const newAvatar = document.getElementById('inputAvatar').value.trim();
    const newToken = document.getElementById('inputToken').value.trim();

    // 1. Salva o Nome no cache correto
    if (newName !== "") {
        currentUser = newName;
        localStorage.setItem('mvp_username', currentUser);
        document.getElementById('myUsernameDisplay').innerText = currentUser;
    }

    // 2. Salva o Avatar (Foto) no cache correto
    if (newAvatar !== "") {
        currentAvatar = newAvatar;
    } else {
        currentAvatar = `https://api.dicebear.com/7.x/identicon/svg?seed=${currentUser}&backgroundColor=313338`;
    }
    localStorage.setItem('mvp_avatar', currentAvatar);
    document.getElementById('myAvatarDisplay').src = currentAvatar;
    
    // 3. Salva a Chave VIP no cofre correto
    currentToken = newToken;
    localStorage.setItem('mvp_token', currentToken);

    // 4. Grita pro servidor as suas credenciais novas!
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "identify",
            user: currentUser,
            avatar: currentAvatar,
            token: currentToken
        }));
    }

    closeSettings();
}



// Função para os botões do Card enviarem comandos direto no chat
function sendCommand(cmdText) {
    const msgData = {
        type: "chat",
        id: "msg-" + generateId(),
        channel: currentChannel, // Envia no canal que você estiver olhando
        author: currentUser,
        avatar: currentAvatar,
        text: cmdText
    };
    
    // Manda pro servidor Python
    ws.send(JSON.stringify(msgData));
    
}

// Envia o comando pro servidor sem desenhar na sua tela
function sendHiddenCommand(cmdText) {
    const msgData = {
        type: "chat",
        id: "msg-" + generateId(),
        channel: currentChannel,
        author: currentUser,
        avatar: currentAvatar,
        text: cmdText,
        hidden: true // A FLAG MÁGICA
    };
    ws.send(JSON.stringify(msgData));
}

async function joinVoiceChannel(channelName) {
    if (currentVoiceChannel === channelName) return; // Se já está no canal, ignora

    try {
        // 1. Pede permissão e liga o microfone
        if (!localStream) {
            const audioConstraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };
            localStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
        }

        monitorAudioStream(localStream, currentUser);

        currentVoiceChannel = channelName;

        // 2. Atualiza o visual da interface (deixa o canal selecionado e mostra o painel verde)
        document.querySelectorAll('.voice-channel').forEach(c => c.classList.remove('active'));
        const safeId = channelName.replace(/\s+/g, '-').toLowerCase();
        document.getElementById('voice-' + safeId).classList.add('active');
        
        document.getElementById('currentVoiceChannelName').innerText = channelName + " / LocalHost";
        document.getElementById('voiceConnectedPanel').style.display = "flex";

        // AVISA O SERVIDOR QUE VOCÊ ENTROU
        ws.send(JSON.stringify({
            type: "join_voice",
            channel: channelName,
            user: currentUser,
            avatar: currentAvatar
        }));

        // 3. Dispara a chamada informando o seu crachá:
        await connectToBot(channelName);

    } catch (err) {
        console.error("Erro no Mic:", err);
        alert("Não conseguimos acessar seu microfone. Verifique as permissões do navegador.");
    }
}

function disconnectVoice() {

    isMuted = false;
    const btnMute = document.getElementById('btnMute');
    if (btnMute) {
        btnMute.innerText = "🎤";
        btnMute.style.color = "#b5bac1";
    }
    // 1. Desliga o hardware do microfone
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    currentVoiceChannel = null;

    // 2. Limpa o visual
    document.querySelectorAll('.voice-channel').forEach(c => c.classList.remove('active'));
    document.getElementById('voiceConnectedPanel').style.display = "none";

    // 3. Desliga TODOS os motores do WebRTC da Malha (Inclusive o do Bot)
    for (let user in peerConnections) {
        if (peerConnections[user]) {
            peerConnections[user].close();
        }
    }
    peerConnections = {}; // Zera o dicionário
    document.querySelectorAll('audio[id^="audio-"]').forEach(a => a.remove()); // Apaga as caixas de som invisíveis

    // 4. AVISA O SERVIDOR QUE VOCÊ SAIU
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "leave_voice",
            user: currentUser
        }));
    }
}

let isMuted = false;

function toggleMute() {
    // 1. Verifica se o hardware do microfone está ativo
    if (localStream) {
        // 2. Pega a trilha de áudio física
        const audioTrack = localStream.getAudioTracks()[0];
        
        if (audioTrack) {
            isMuted = !isMuted; // Inverte o status
            audioTrack.enabled = !isMuted; // Corta ou libera o som direto no WebRTC
            
            // 3. Atualiza o visual do botão
            const btnMute = document.getElementById('btnMute');
            if (isMuted) {
                btnMute.innerText = "🔇";
                btnMute.style.color = "#da373c"; // Fica vermelho igual no Discord
            } else {
                btnMute.innerText = "🎤";
                btnMute.style.color = "#b5bac1"; // Volta pra cor normal cinza
            }
        }
    }
}

// Função para renderizar as configurações que vieram do Python
function renderServerSettings(config) {
    // 1. Muda o nome da Aba e do Servidor
    document.title = config.tab_name;
    document.getElementById("serverNameDisplay").innerText = config.server_name;
    
    // 2. Monta os canais de texto
    const textList = document.getElementById("textChannelsList");
    textList.innerHTML = "";
    config.text_channels.forEach(ch => {
        const isActive = ch === currentChannel ? " active" : "";
        textList.innerHTML += `<div id="nav-${ch}" class="channel${isActive}" onclick="switchChannel('${ch}')"><span>#</span> ${ch}</div>`;
    });

    // 3. Monta os canais de voz
    const voiceList = document.getElementById("voiceChannelsList");
    voiceList.innerHTML = "";
    config.voice_channels.forEach(ch => {
        const isActive = ch === currentVoiceChannel ? " active" : "";
        // Formata IDs para não dar erro com espaços
        const safeId = ch.replace(/\s+/g, '-').toLowerCase();
        voiceList.innerHTML += `<div id="voice-${safeId}" class="channel voice-channel${isActive}" onclick="joinVoiceChannel('${ch}')"><span>🔊</span> ${ch}</div>`;
    });
}

// --- CRIAÇÃO DE CANAIS ---
function createNewChannel(type) {
    const channelName = prompt(type === 'text' ? "Nome do novo canal de TEXTO:" : "Nome do novo canal de VOZ:");
    
    // Se a pessoa cancelar ou não digitar nada, a gente ignora
    if (!channelName || channelName.trim() === "") return;
    
    // Limpeza de nome: se for de texto, tira os espaços e bota traço (padrão Discord)
    let formattedName = channelName.trim();
    if (type === 'text') {
        formattedName = formattedName.toLowerCase().replace(/\s+/g, '-');
    }

    // Pede pro Python criar
    ws.send(JSON.stringify({
        type: "create_channel",
        channel_type: type,
        name: formattedName
    }));
}

// --- CONFIGURAÇÕES DO SERVIDOR ---
function openServerSettings() {
    // Puxa os nomes atuais da tela e joga pra dentro dos inputs
    document.getElementById('inputServerName').value = document.getElementById('serverNameDisplay').innerText;
    document.getElementById('inputTabName').value = document.title;
    
    // Abre a janela
    document.getElementById('serverSettingsModal').style.display = 'flex';
}

function closeServerSettings() {
    document.getElementById('serverSettingsModal').style.display = 'none';
}

function saveServerSettings() {
    const newServerName = document.getElementById('inputServerName').value.trim();
    const newTabName = document.getElementById('inputTabName').value.trim();

    if (!newServerName || !newTabName) {
        alert("Os nomes não podem ficar vazios, Mago!");
        return;
    }

    // Manda o feitiço de alteração pro Python
    ws.send(JSON.stringify({
        type: "update_server",
        server_name: newServerName,
        tab_name: newTabName
    }));

    closeServerSettings();
}

// --- RENDERIZA O RADAR DE VOZ ---
function renderVoiceUsers(states) {
    // 1. Limpa todas as listas de usuários velhas
    document.querySelectorAll('.voice-user-list').forEach(el => el.remove());

    // 2. Desenha os novos usuários embaixo dos canais corretos
    for (const [username, info] of Object.entries(states)) {
        const safeId = info.channel.replace(/\s+/g, '-').toLowerCase();
        const channelDiv = document.getElementById('voice-' + safeId);
        
        if (channelDiv) {
            // Cria a caixinha se ainda não existir embaixo deste canal
            let listContainer = channelDiv.nextElementSibling;
            if (!listContainer || !listContainer.classList.contains('voice-user-list')) {
                listContainer = document.createElement('div');
                listContainer.className = 'voice-user-list';
                // Insere logo depois da div do canal
                channelDiv.parentNode.insertBefore(listContainer, channelDiv.nextSibling);
            }
            
            // Adiciona a sua fotinha!
            listContainer.innerHTML += `
                <div class="voice-user-item">
                    <img src="${info.avatar}" class="voice-user-avatar">
                    <span class="voice-user-name">${username}</span>
                </div>
            `;
        }

        if (currentVoiceChannel) {
            for (const [username, info] of Object.entries(states)) {
                if (info.channel === currentVoiceChannel && username !== currentUser && username !== "TrindasBot (MVP)") {
                    if (!peerConnections[username]) {
                        // A REGRA DE OURO: Só liga quem tiver o nome maior na ordem alfabética!
                        // Isso impede a "Colisão de Telefones" (Glare Condition).
                        if (currentUser > username) {
                            initiateP2PConnection(username);
                        }
                    }
                }
            }
        // Limpa a conexão de quem saiu da sala
        for (const connectedUser of Object.keys(peerConnections)) {
            if (connectedUser !== "TrindasBot (MVP)" && (!states[connectedUser] || states[connectedUser].channel !== currentVoiceChannel)) {
                peerConnections[connectedUser].close();
                delete peerConnections[connectedUser];
                const audioTag = document.getElementById('audio-' + connectedUser);
                if (audioTag) audioTag.remove();
            }
        }
    }
    }
}



// --- MENU DE CONTEXTO E VOLUME INDIVIDUAL ---
let targetContextUser = null;

// Oculta o menu se o usuário clicar em qualquer lugar fora dele
document.addEventListener('click', (e) => {
    const menu = document.getElementById('userContextMenu');
    if (menu.style.display === 'block' && !menu.contains(e.target)) {
        menu.style.display = 'none';
    }
});

// Ouve o CLIQUE DIREITO em toda a tela, mas só age se for num usuário da voz
document.addEventListener('contextmenu', (e) => {
    const userItem = e.target.closest('.voice-user-item');
    if (userItem) {
        e.preventDefault(); // Impede o menu feião do Windows/Chrome de aparecer!
        
        // Descobre quem foi clicado
        const userName = userItem.querySelector('.voice-user-name').innerText;
        targetContextUser = userName;

        const menu = document.getElementById('userContextMenu');
        document.getElementById('contextMenuUserName').innerText = userName;

        // Busca o volume salvo EXCLUSIVO desse usuário no cache
        let savedVol = localStorage.getItem('vol_' + userName);
        if (savedVol === null) savedVol = 1.0; // Padrão 100%
        
        const slider = document.getElementById('contextVolumeSlider');
        slider.value = savedVol;
        document.getElementById('contextVolPercentage').innerText = Math.round(savedVol * 100) + '%';

        // Desenha o menu exatamente na ponta do seu mouse
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
        menu.style.display = 'block';
    }
});

// Quando arrastar o slider do menu de contexto
// Quando arrastar o slider do menu de contexto
document.getElementById('contextVolumeSlider').addEventListener('input', function() {
    if (!targetContextUser) return;
    
    const vol = this.value;
    document.getElementById('contextVolPercentage').innerText = Math.round(vol * 100) + '%';
    
    // Salva no cache com a chave única do usuário
    localStorage.setItem('vol_' + targetContextUser, vol);
    
    // Aplica o volume no alvo correto (O Bot tem um ID fixo, Humanos têm IDs dinâmicos)
    if (targetContextUser === "TrindasBot (MVP)") {
        const botAudio = document.getElementById('remoteAudio');
        if (botAudio) botAudio.volume = vol;
    } else {
        const humanAudio = document.getElementById(`audio-${targetContextUser}`);
        if (humanAudio) humanAudio.volume = vol;
    }
});

// --- RENDERIZA A LISTA DE MEMBROS ---
function renderMemberList(members) {
    const list = document.getElementById('membersList');
    document.getElementById('onlineCount').innerText = members.length;
    list.innerHTML = "";
    
    members.forEach(m => {
        list.innerHTML += `
            <div class="member-item">
                <img src="${m.avatar}" class="member-avatar">
                <span class="member-name">${m.username}</span>
            </div>
        `;
    });
}

// Oculta/Mostra a aba direita
function toggleMemberList() {
    const sidebar = document.getElementById('membersSidebar');
    if (sidebar.style.display === 'none') {
        sidebar.style.display = 'flex';
    } else {
        sidebar.style.display = 'none';
    }
}

let audioContext;

function monitorAudioStream(stream, username) {
    try {
        // 1. Cria o motor de áudio
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        // 2. A CHAVE MESTRA: Força o navegador a acordar o motor de áudio!
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }

        const analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        analyser.fftSize = 256; // Menor para focar nas frequências da voz

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        let currentlySpeaking = false;

        function checkLevel() {
            if (!currentVoiceChannel) return; // Se saiu da call, desliga o radar
            
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for(let i = 0; i < dataArray.length; i++) sum += dataArray[i];
            let average = sum / dataArray.length;

            // Limite de detecção (2 é mais sensível, pega qualquer sussurro ou batida de música)
            let isSpeaking = average > 1; 

            if (isSpeaking !== currentlySpeaking) {
                currentlySpeaking = isSpeaking;
                updateSpeakingRing(username, isSpeaking);
                
                // Manda o aviso na rede pros amigos verem
                if (username === currentUser) {
                    ws.send(JSON.stringify({ type: "speaking", user: currentUser, status: isSpeaking }));
                }
            }
            requestAnimationFrame(checkLevel);
        }
        checkLevel();
    } catch (e) {
        console.error("Erro no Radar de Áudio para o usuário " + username + ": ", e);
    }
}

function updateSpeakingRing(username, isSpeaking) {
    document.querySelectorAll('.voice-user-item').forEach(item => {
        const nameElement = item.querySelector('.voice-user-name');
        
        // O .trim() salva vidas! Tira qualquer espaço invisível antes de comparar
        if (nameElement && nameElement.innerText.trim() === username.trim()) {
            const img = item.querySelector('.voice-user-avatar');
            if (isSpeaking) {
                img.classList.add('speaking');
            } else {
                img.classList.remove('speaking');
            }
        }
    });
}

// --- BLINDAGEM CONTRA XSS ---
function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/[&<>'"]/g, function(tag) {
        const charsToReplace = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        };
        return charsToReplace[tag] || tag;
    });
}
# SuppaTalk 🎧

> Um servidor de chat de voz e texto P2P (WebRTC), Self-Hosted e construído do zero com Python, FastAPI e WebSockets.

O **SuppaTalk** é uma alternativa leve e descentralizada para comunicação em grupo. Diferente de plataformas comerciais que roteiam todo o seu áudio por um servidor central (SFU), o SuppaTalk utiliza uma arquitetura **WebRTC Mesh P2P** no frontend. O servidor atua apenas como um "sinaleiro" (Signaling Server) de texto, enquanto a voz viaja de forma criptografada (DTLS/SRTP) diretamente de ponto a ponto entre os navegadores dos usuários.

O projeto inclui um **Bot de Música Nativo** rodando no backend via `aiortc`, injetando áudio diretamente na chamada WebRTC.

## 🚀 Arquitetura e Tecnologias

* **Backend / Signaling:** Python 3.11, FastAPI, Uvicorn (WebSockets).
* **Frontend:** Vanilla JavaScript, HTML5, CSS3.
* **Motor de Voz:** WebRTC (Rede Mesh P2P nativa do navegador).
* **Bot de Áudio:** `aiortc` e `PyAV` (Processamento de mídia).
* **Infraestrutura:** 100% Dockerizado.

## ✨ Funcionalidades (MVP 1.0)

- [x] Chat de texto em tempo real com suporte a múltiplos canais.
- [x] Canais de voz com latência ultrabaixa (P2P Mesh).
- [x] Detecção automática de voz (Voice Activity Detection) com UI reativa.
- [x] Privacidade total: o áudio não passa pelo servidor backend.
- [x] **TrindasBot integrado:** Um DJ virtual que entra na chamada e toca arquivos de áudio locais.
- [x] Controle individual de volume P2P via menu de contexto.
- [x] Mute local de microfone direto no hardware.

## 🛠️ Como rodar (Deploy com Docker)

### 1. Clone o repositório
```bash
git clone https://github.com/SuppaHackaD/SuppaTalk.git
cd SuppaTalk
```

### 2. Configure o ambiente
Copie o arquivo de exemplo e edite com o seu IP da rede local ou domínio (necessário para o WebRTC escapar da rede virtual do Docker):
```bash
cp backend/.env.example backend/.env
```
*Edite a variável `MVP_URI` no arquivo `.env` para apontar para o IP onde o servidor será hospedado.*

### 3. Inicie o servidor
```bash
docker compose up -d --build
```

### 4. Acesse
Abra `http://localhost:19191` no seu navegador. 
*(Nota: Para testar o microfone em dispositivos fora do `localhost`, é obrigatório o uso de HTTPS / Proxy Reverso devido às rigorosas políticas de segurança dos navegadores para a API de mídia).*

## ⚠️ Known Issues (Para futuros PRs)
* **Desconexão abrupta:** Fechar a aba no "X" do navegador (sem clicar no botão de desconectar) pode, em cenários específicos de falha na rede TCP, deixar um "usuário fantasma" preso na contagem da sala de voz até o servidor ser reiniciado. 
* **Escalabilidade P2P:** Por usar uma malha Mesh, o tráfego de upload multiplica a cada novo usuário na mesma chamada. Projetado para otimização em grupos pequenos (2 a 8 pessoas).

## 🤝 Como contribuir
Pull Requests são extremamente bem-vindos! Se você é um Engenheiro DevOps ou Dev Python e quer ajudar a transformar a rede P2P num servidor SFU centralizado no backend, sinta-se em casa para abrir uma *issue* e debater a arquitetura.

## 🔒 Licença
Distribuído sob a licença AGPLv3. Veja o arquivo `LICENSE` para mais detalhes.

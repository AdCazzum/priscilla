# WebSocket Mode - Guida Completa

## 📖 Panoramica

L'EventClient supporta **due modalità operative**:

1. **File-based** (default): Legge eventi da `iexec_in/events.json` tramite polling
2. **WebSocket**: Riceve eventi in tempo reale da un server WebSocket

## 🚀 Quick Start - Modalità WebSocket

### 1. Configurazione

Modifica il file `.env`:

```bash
# Abilita modalità WebSocket
USE_WEBSOCKET=true

# URL del server WebSocket
WEBSOCKET_URL=ws://localhost:8080

# Configurazioni opzionali
WEBSOCKET_RECONNECT_INTERVAL=5000  # Tempo tra i tentativi di riconnessione (ms)
WEBSOCKET_MAX_RECONNECT_ATTEMPTS=10  # Numero massimo di tentativi di riconnessione

# Output (uguale per entrambe le modalità)
EVENT_OUTPUT_PATH=iexec_out/responses.json
```

### 2. Avvia il Server WebSocket di Test

```bash
node websocket-test-server.mjs
```

Output:
```
🌐 WebSocket Server listening on ws://localhost:8080
📋 Commands:
  - Press Ctrl+C to stop the server
⏳ Waiting for connections...
```

### 3. Avvia l'Agent

```bash
npm start
```

### 4. Osserva il Flusso

**Server WebSocket:**
```
✅ New client connected
🔐 Client authenticated with agentId: <uuid>
📤 Sending 3 sample events...
📤 Sending event: ws-event-001
✅ Event ws-event-001 processed
📥 Response received for ws-event-001:
   Response: Hello! I'm an iExec intern...
```

**Agent Logs:**
```
🚀 EventClientWebSocket.start() called
🔌 Connecting to WebSocket: ws://localhost:8080
✅ WebSocket connected to ws://localhost:8080
📨 WebSocket message received: {"id":"ws-event-001"...}
📥 Processing new event: ws-event-001
Generating AI response for event ws-event-001...
✅ Generated AI response for event ws-event-001
```

## 📡 Protocollo WebSocket

### Messaggi Client → Server

#### 1. Autenticazione (inviato all'apertura connessione)
```json
{
  "type": "auth",
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": 1700000000000
}
```

#### 2. Acknowledgment di Processamento
```json
{
  "type": "ack",
  "eventId": "event-001",
  "status": "processed",  // o "error"
  "error": "Error message if any",
  "timestamp": 1700000000000
}
```

#### 3. Risposta AI Generata
```json
{
  "type": "response",
  "queryId": "event-001",
  "response": "AI generated response text...",
  "timestamp": 1700000000000,
  "agentId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Messaggi Server → Client

#### 1. Evento da Processare
```json
{
  "id": "event-001",
  "query": "What is iExec?",
  "timestamp": 1700000000000,
  "metadata": {
    "userId": "user-123",
    "priority": "high",
    "source": "api"
  }
}
```

#### 2. Conferma Autenticazione (opzionale)
```json
{
  "type": "auth_success",
  "message": "Authentication successful",
  "timestamp": 1700000000000
}
```

## 🔧 Implementazione Custom Server

### Esempio Server Node.js + Express + ws

```javascript
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Connessioni attive
const clients = new Map();

wss.on('connection', (ws) => {
  let agentId = null;
  
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    
    if (message.type === 'auth') {
      agentId = message.agentId;
      clients.set(agentId, ws);
      console.log(`Agent ${agentId} connected`);
    }
    
    if (message.type === 'response') {
      // Salva risposta nel database, invia ad API, etc.
      console.log(`Response from ${agentId}: ${message.response}`);
    }
  });
  
  ws.on('close', () => {
    if (agentId) {
      clients.delete(agentId);
      console.log(`Agent ${agentId} disconnected`);
    }
  });
});

// REST API endpoint per inviare eventi all'agent
app.post('/api/query', express.json(), (req, res) => {
  const { query, userId } = req.body;
  
  const event = {
    id: `event-${Date.now()}`,
    query,
    timestamp: Date.now(),
    metadata: { userId }
  };
  
  // Invia a tutti gli agent connessi (o a uno specifico)
  clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  });
  
  res.json({ success: true, eventId: event.id });
});

server.listen(8080, () => {
  console.log('Server listening on port 8080');
});
```

## 🔄 Riconnessione Automatica

Il client gestisce automaticamente le disconnessioni:

1. **Tentativo di riconnessione** ogni `WEBSOCKET_RECONNECT_INTERVAL` ms
2. **Massimo tentativi**: `WEBSOCKET_MAX_RECONNECT_ATTEMPTS`
3. **Backoff esponenziale** (opzionale, da implementare se necessario)

**Log di riconnessione:**
```
❌ WebSocket connection closed. Code: 1006, Reason: 
🔄 Reconnecting in 5000ms (attempt 1/10)...
🔌 Connecting to WebSocket: ws://localhost:8080
✅ WebSocket connected to ws://localhost:8080
```

## 🔐 Autenticazione e Sicurezza

### Token-based Authentication

Modifica `eventClientWebSocket.ts`:

```typescript
// Nel metodo connect(), dopo "open":
this.ws.on("open", () => {
  const token = process.env.WEBSOCKET_AUTH_TOKEN;
  this.ws?.send(JSON.stringify({
    type: "auth",
    agentId: this.runtime.agentId,
    token: token,  // 👈 Aggiungi token
    timestamp: Date.now()
  }));
});
```

### WSS (WebSocket Secure)

Per connessioni sicure, usa `wss://` invece di `ws://`:

```bash
WEBSOCKET_URL=wss://your-domain.com/agent-websocket
```

Server con TLS:

```javascript
import https from 'https';
import fs from 'fs';

const options = {
  cert: fs.readFileSync('/path/to/cert.pem'),
  key: fs.readFileSync('/path/to/key.pem')
};

const server = https.createServer(options, app);
const wss = new WebSocketServer({ server });
```

## 📊 Confronto File vs WebSocket

| Caratteristica | File-based | WebSocket |
|----------------|------------|-----------|
| **Latenza** | 5s (polling) | < 100ms (real-time) |
| **Scalabilità** | Limitata (I/O disco) | Alta (connessioni concorrenti) |
| **Affidabilità** | Alta (persistenza) | Media (richiede reconnect) |
| **Complessità** | Bassa | Media |
| **Use Case** | Batch processing | Real-time interactions |

## 🧪 Testing

### Test con `websocat` (CLI tool)

```bash
# Installa websocat
brew install websocat  # macOS
# o sudo apt install websocat  # Linux

# Connetti al server
websocat ws://localhost:8080

# Invia evento manualmente
{"id":"test-001","query":"What is iExec?","timestamp":1700000000000}
```

### Test con Postman

1. Crea nuova **WebSocket Request**
2. URL: `ws://localhost:8080`
3. Invia messaggi JSON come sopra

## 🐛 Troubleshooting

### Agent non si connette

**Problema:** `Error connecting to WebSocket: ECONNREFUSED`

**Soluzione:**
1. Verifica che il server WebSocket sia avviato
2. Controlla che l'URL sia corretto nel `.env`
3. Verifica firewall/network

### Eventi duplicati

**Problema:** Lo stesso evento viene processato più volte

**Soluzione:**
```typescript
// Il Set `processedEvents` previene duplicati
// Ma non persiste tra restart - implementa cache se necessario
```

### Riconnessione infinita

**Problema:** Il client continua a riconnettersi senza successo

**Soluzione:**
- Aumenta `WEBSOCKET_RECONNECT_INTERVAL`
- Riduci `WEBSOCKET_MAX_RECONNECT_ATTEMPTS`
- Verifica logs del server per errori

## 📦 Deploy in Produzione

### Docker Compose con WebSocket Server

```yaml
version: '3.8'
services:
  websocket-server:
    build: ./websocket-server
    ports:
      - "8080:8080"
    environment:
      - NODE_ENV=production
  
  iexec-agent:
    build: .
    depends_on:
      - websocket-server
    environment:
      - USE_WEBSOCKET=true
      - WEBSOCKET_URL=ws://websocket-server:8080
    volumes:
      - ./iexec_out:/app/iexec_out
```

### Kubernetes

```yaml
apiVersion: v1
kind: Service
metadata:
  name: websocket-service
spec:
  selector:
    app: websocket-server
  ports:
    - protocol: TCP
      port: 8080
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: iexec-agent
spec:
  template:
    spec:
      containers:
      - name: agent
        env:
        - name: USE_WEBSOCKET
          value: "true"
        - name: WEBSOCKET_URL
          value: "ws://websocket-service:8080"
```

## 🎯 Next Steps

1. **Implementa persistenza eventi** - Salva eventi ricevuti prima di processarli
2. **Aggiungi metriche** - Tempo di risposta, eventi processati, etc.
3. **Load balancing** - Distribuisci eventi tra più agent
4. **Queue system** - Integra con RabbitMQ/Redis per affidabilità

## 📚 Risorse

- [ws library documentation](https://github.com/websockets/ws)
- [WebSocket Protocol RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455)
- [ElizaOS Documentation](https://github.com/elizaos/eliza)

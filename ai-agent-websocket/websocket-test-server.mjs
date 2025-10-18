#!/usr/bin/env node

/**
 * WebSocket Test Server per EventClientWebSocket
 * 
 * Questo server simula un sistema che invia eventi all'agent tramite WebSocket
 * e riceve le risposte elaborate.
 * 
 * Uso:
 *   node websocket-test-server.js
 * 
 * Poi avvia l'agent con USE_WEBSOCKET=true nel .env
 */

import WebSocket, { WebSocketServer } from 'ws';

const PORT = 8081;

// Crea il WebSocket server
const wss = new WebSocketServer({ port: PORT });

console.log(`🌐 WebSocket Server listening on ws://localhost:${PORT}`);

// Eventi di esempio da inviare
const sampleEvents = [
  {
    id: "ws-event-001",
    query: "What is iExec and how does it enable confidential computing?",
    timestamp: Date.now(),
    metadata: {
      userId: "websocket-user-1",
      priority: "high",
      source: "websocket"
    }
  },
  {
    id: "ws-event-002",
    query: "How can I use DataProtector to monetize my data?",
    timestamp: Date.now() + 1000,
    metadata: {
      userId: "websocket-user-2",
      source: "websocket"
    }
  },
  {
    id: "ws-event-003",
    query: "Explain the iExec Voucher system and how it works",
    timestamp: Date.now() + 2000,
    metadata: {
      userId: "websocket-user-3",
      category: "tokenomics"
    }
  }
];

// Gestione connessioni
wss.on('connection', (ws) => {
  console.log('✅ New client connected');
  
  // Gestione messaggi dal client
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(`📨 Received from client:`, message);
      
      // Gestisci diversi tipi di messaggio
      switch (message.type) {
        case 'auth':
          console.log(`🔐 Client authenticated with agentId: ${message.agentId}`);
          // Invia conferma autenticazione
          ws.send(JSON.stringify({
            type: 'auth_success',
            message: 'Authentication successful',
            timestamp: Date.now()
          }));
          
          // Invia eventi di esempio dopo 2 secondi
          setTimeout(() => {
            console.log(`📤 Sending ${sampleEvents.length} sample events...`);
            sampleEvents.forEach((event, index) => {
              setTimeout(() => {
                console.log(`📤 Sending event: ${event.id}`);
                ws.send(JSON.stringify(event));
              }, index * 5000); // Invia un evento ogni 5 secondi
            });
          }, 2000);
          break;
          
        case 'ack':
          console.log(`✅ Event ${message.eventId} ${message.status}`);
          if (message.error) {
            console.error(`❌ Error processing event: ${message.error}`);
          }
          break;
          
        case 'response':
          console.log(`📥 Response received for ${message.queryId}:`);
          console.log(`   Response: ${message.response.substring(0, 100)}...`);
          console.log(`   Agent ID: ${message.agentId}`);
          break;
          
        default:
          console.log(`⚠️  Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error('❌ Error parsing message:', error);
    }
  });
  
  // Gestione chiusura connessione
  ws.on('close', (code, reason) => {
    console.log(`❌ Client disconnected. Code: ${code}, Reason: ${reason}`);
  });
  
  // Gestione errori
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
  
  // Keepalive ping ogni 30 secondi
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);
  
  ws.on('close', () => {
    clearInterval(pingInterval);
  });
});

// Gestione shutdown gracefully
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down WebSocket server...');
  wss.clients.forEach((client) => {
    client.close(1000, 'Server shutting down');
  });
  wss.close(() => {
    console.log('✅ WebSocket server closed');
    process.exit(0);
  });
});

console.log('\n📋 Commands:');
console.log('  - Press Ctrl+C to stop the server');
console.log('\n💡 To test with the agent:');
console.log('  1. Set USE_WEBSOCKET=true in .env');
console.log('  2. Set WEBSOCKET_URL=ws://localhost:8080 in .env');
console.log('  3. Start the agent: npm start');
console.log('\n⏳ Waiting for connections...\n');

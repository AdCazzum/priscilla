import {
  Client,
  IAgentRuntime,
  elizaLogger,
  stringToUuid,
  type Memory,
  type UUID,
} from "@elizaos/core";
import WebSocket from "ws";
import fs from "fs";

// Interface per gli eventi in ingresso
interface EventQuery {
  id: string;
  query: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

// Interface per le risposte
interface EventResponse {
  queryId: string;
  response: string;
  timestamp: number;
  agentId: string;
}

export class EventClientWebSocket {
  private runtime: IAgentRuntime;
  private websocketUrl: string;
  private ws?: WebSocket;
  private eventOutputPath: string;
  private processedEvents: Set<string>;
  private isRunning: boolean;
  private reconnectInterval: number;
  private reconnectTimeout?: NodeJS.Timeout;
  private maxReconnectAttempts: number;
  private reconnectAttempts: number;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    this.websocketUrl = process.env.WEBSOCKET_URL || "ws://localhost:8080";
    this.eventOutputPath = process.env.EVENT_OUTPUT_PATH || "/iexec_out/responses.json";
    this.processedEvents = new Set<string>();
    this.isRunning = false;
    this.reconnectInterval = parseInt(process.env.WEBSOCKET_RECONNECT_INTERVAL || "5000");
    this.maxReconnectAttempts = parseInt(process.env.WEBSOCKET_MAX_RECONNECT_ATTEMPTS || "10");
    this.reconnectAttempts = 0;

    elizaLogger.log("EventClientWebSocket initialized", {
      websocketUrl: this.websocketUrl,
      eventOutputPath: this.eventOutputPath,
      reconnectInterval: this.reconnectInterval,
    });
  }

  async start(): Promise<void> {
    elizaLogger.log("🚀 EventClientWebSocket.start() called");
    
    if (this.isRunning) {
      elizaLogger.warn("EventClientWebSocket is already running");
      return;
    }

    this.isRunning = true;
    
    elizaLogger.log("📝 Initializing output file...");
    // Inizializza il file di output
    this.initializeOutputFile();
    
    elizaLogger.log("🔌 Starting WebSocket connection...");
    // Connetti al WebSocket
    this.connect();
    
    elizaLogger.success("✅ EventClientWebSocket started successfully");
    elizaLogger.log("💡 WebSocket client is now running and will process incoming events");
  }

  private connect(): void {
    try {
      elizaLogger.log(`🔌 Connecting to WebSocket: ${this.websocketUrl}`);
      
      this.ws = new WebSocket(this.websocketUrl);

      // Event: Connection opened
      this.ws.on("open", () => {
        elizaLogger.success(`✅ WebSocket connected to ${this.websocketUrl}`);
        this.reconnectAttempts = 0; // Reset reconnect counter
        
        // Invia messaggio di autenticazione se necessario
        this.ws?.send(JSON.stringify({
          type: "auth",
          agentId: this.runtime.agentId,
          timestamp: Date.now()
        }));
      });

      // Event: Message received
      this.ws.on("message", async (data: WebSocket.Data) => {
        try {
          const message = data.toString();
          elizaLogger.log(`📨 WebSocket message received: ${message.substring(0, 100)}...`);
          
          const parsed = JSON.parse(message);
          
          // Ignora messaggi di controllo (auth_success, ping, ecc.)
          if (parsed.type && ['auth_success', 'ping', 'pong', 'ack'].includes(parsed.type)) {
            elizaLogger.log(`✓ Control message received: ${parsed.type}`);
            return;
          }
          
          // Valida che il messaggio sia un evento valido
          if (this.isValidEvent(parsed)) {
            await this.handleEvent(parsed);
          } else {
            elizaLogger.warn(`⚠️ Invalid event format received: ${message}`);
          }
        } catch (error) {
          elizaLogger.error("Error processing WebSocket message:", error);
        }
      });

      // Event: Connection closed
      this.ws.on("close", (code: number, reason: string) => {
        elizaLogger.warn(`❌ WebSocket connection closed. Code: ${code}, Reason: ${reason}`);
        this.handleReconnect();
      });

      // Event: Error
      this.ws.on("error", (error: Error) => {
        elizaLogger.error("WebSocket error:", error);
      });

      // Event: Ping/Pong for keepalive
      this.ws.on("ping", () => {
        this.ws?.pong();
      });

    } catch (error) {
      elizaLogger.error("Error connecting to WebSocket:", error);
      this.handleReconnect();
    }
  }

  private handleReconnect(): void {
    if (!this.isRunning) {
      return; // Non riconnettere se l'agent è stato fermato
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      elizaLogger.error(`❌ Max reconnection attempts (${this.maxReconnectAttempts}) reached. Stopping.`);
      this.isRunning = false;
      return;
    }

    this.reconnectAttempts++;
    elizaLogger.log(`🔄 Reconnecting in ${this.reconnectInterval}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, this.reconnectInterval);
  }

  private isValidEvent(event: any): event is EventQuery {
    return (
      typeof event === "object" &&
      typeof event.id === "string" &&
      typeof event.query === "string" &&
      typeof event.timestamp === "number"
    );
  }

  private async handleEvent(event: EventQuery): Promise<void> {
    // Verifica se l'evento è già stato processato
    if (this.processedEvents.has(event.id)) {
      elizaLogger.debug(`Event ${event.id} already processed, skipping`);
      return;
    }

    elizaLogger.log(`📥 Processing new event: ${event.id}`);
    
    try {
      await this.processEvent(event);
      this.processedEvents.add(event.id);
      
      // Invia conferma al server WebSocket
      this.ws?.send(JSON.stringify({
        type: "ack",
        eventId: event.id,
        status: "processed",
        timestamp: Date.now()
      }));
    } catch (error) {
      elizaLogger.error(`Error processing event ${event.id}:`, error);
      
      // Invia errore al server WebSocket
      this.ws?.send(JSON.stringify({
        type: "ack",
        eventId: event.id,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now()
      }));
    }
  }

  private async processEvent(event: EventQuery): Promise<void> {
    try {
      elizaLogger.log(`Processing event ${event.id}: ${event.query}`);

      // Crea una memoria per la query
      const userId = stringToUuid(event.metadata?.userId || "event-user");
      const roomId = stringToUuid(`event-room-${event.id}`);

      const memory: Memory = {
        id: stringToUuid(`${event.id}-${Date.now()}`),
        userId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          text: event.query,
          source: "websocket",
          metadata: event.metadata,
        },
        createdAt: event.timestamp,
      };

      // Salva la memoria nel database
      await this.runtime.messageManager.createMemory(memory);

      elizaLogger.log(`Generating AI response for event ${event.id}...`);
      
      // Usa Ollama API direttamente (bypass ElizaOS services)
      let response: string;
      try {
        // Build context from character knowledge and query
        const knowledgeContext = Array.isArray(this.runtime.character.knowledge)
          ? this.runtime.character.knowledge.slice(0, 10).join('\n')
          : 'No specific knowledge available.';

        const bioText = Array.isArray(this.runtime.character.bio) 
          ? this.runtime.character.bio.join(' ') 
          : this.runtime.character.bio;

        const context = `You are ${this.runtime.character.name}.

Bio: ${bioText}

Knowledge:
${knowledgeContext}

User Query: ${event.query}

Please provide a helpful and accurate response based on your knowledge:`;

        elizaLogger.log("Calling Ollama API directly...");

        // Chiama Ollama API direttamente
        const ollamaUrl = process.env.OLLAMA_SERVER_URL || 'http://localhost:11434';
        const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.1:8b';
        
        const ollamaResponse = await fetch(`${ollamaUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: ollamaModel,
            prompt: context,
            stream: false,
            options: {
              temperature: 0.7,
              num_predict: 500
            }
          })
        });

        if (!ollamaResponse.ok) {
          throw new Error(`Ollama API error: ${ollamaResponse.status} ${ollamaResponse.statusText}`);
        }

        const ollamaData = await ollamaResponse.json();
        response = ollamaData.response || ollamaData.text || '';

        if (!response || response.trim() === '') {
          throw new Error('Empty response from Ollama');
        }

        elizaLogger.success(`Generated AI response for event ${event.id}: ${response.substring(0, 100)}...`);
      } catch (processError) {
        elizaLogger.error(`Error during Ollama API call:`, processError);
        response = `Based on my knowledge about ${this.runtime.character.name}, I can help answer questions about confidential computing, iExec platform, and decentralized technologies. Please feel free to ask!`;
        elizaLogger.success(`Using fallback response for event ${event.id}`);
      }

      // Salva la risposta
      await this.saveResponse({
        queryId: event.id,
        response: response,
        timestamp: Date.now(),
        agentId: this.runtime.agentId,
      });

      // Salva anche la risposta come memoria
      const responseMemory: Memory = {
        id: stringToUuid(`${event.id}-response-${Date.now()}`),
        userId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          text: response,
          source: "websocket",
          action: "RESPONSE",
        },
        createdAt: Date.now(),
      };

      await this.runtime.messageManager.createMemory(responseMemory);
      
      // Invia la risposta anche via WebSocket
      this.ws?.send(JSON.stringify({
        type: "response",
        queryId: event.id,
        response: response,
        timestamp: Date.now(),
        agentId: this.runtime.agentId
      }));

    } catch (error) {
      elizaLogger.error(`Error processing event ${event.id}:`, error);
      throw error;
    }
  }

  private initializeOutputFile(): void {
    if (!fs.existsSync(this.eventOutputPath)) {
      const dir = require("path").dirname(this.eventOutputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.eventOutputPath, JSON.stringify([], null, 2));
      elizaLogger.log(`Initialized output file: ${this.eventOutputPath}`);
    }
  }

  private async saveResponse(response: EventResponse): Promise<void> {
    try {
      let responses: EventResponse[] = [];
      
      if (fs.existsSync(this.eventOutputPath)) {
        const content = fs.readFileSync(this.eventOutputPath, "utf8");
        responses = JSON.parse(content);
      }

      responses.push(response);
      fs.writeFileSync(
        this.eventOutputPath,
        JSON.stringify(responses, null, 2)
      );

      elizaLogger.log(`Response saved for event ${response.queryId}`);
    } catch (error) {
      elizaLogger.error("Error saving response:", error);
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    elizaLogger.log("Stopping EventClientWebSocket...");
    this.isRunning = false;

    // Cancella timeout di reconnect
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    // Chiudi WebSocket
    if (this.ws) {
      this.ws.close(1000, "Client shutting down");
      this.ws = undefined;
    }

    elizaLogger.success("EventClientWebSocket stopped");
  }
}

// Export del client interface per ElizaOS
export const EventClientWebSocketInterface: Client = {
  async start(runtime: IAgentRuntime) {
    elizaLogger.log("🌐 EventClientWebSocketInterface.start() called");
    const client = new EventClientWebSocket(runtime);
    await client.start();
    elizaLogger.success("✅ EventClientWebSocketInterface.start() completed");
    return client;
  },
  async stop(runtime: IAgentRuntime) {
    elizaLogger.log("🛑 EventClientWebSocketInterface.stop() called");
    // Implementazione se necessario
  },
};

import {
  Client,
  IAgentRuntime,
  elizaLogger,
  stringToUuid,
  type Memory,
  type UUID,
} from "@elizaos/core";
import fs from "fs";
import path from "path";

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

export class EventClient {
  private runtime: IAgentRuntime;
  private pollInterval: number;
  private eventInputPath: string;
  private eventOutputPath: string;
  private processedEvents: Set<string>;
  private isRunning: boolean;
  private intervalId?: NodeJS.Timeout;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    this.pollInterval = parseInt(process.env.EVENT_POLL_INTERVAL || "5000"); // 5 secondi default
    this.eventInputPath = process.env.EVENT_INPUT_PATH || "/iexec_in/events.json";
    this.eventOutputPath = process.env.EVENT_OUTPUT_PATH || "/iexec_out/responses.json";
    this.processedEvents = new Set<string>();
    this.isRunning = false;

    elizaLogger.log("EventClient initialized", {
      pollInterval: this.pollInterval,
      eventInputPath: this.eventInputPath,
      eventOutputPath: this.eventOutputPath,
    });
  }

  async start(): Promise<void> {
    elizaLogger.log("🚀 EventClient.start() called");
    
    if (this.isRunning) {
      elizaLogger.warn("EventClient is already running");
      return;
    }

    this.isRunning = true;
    
    // Inizializza il file di output
    this.initializeOutputFile();
    
    elizaLogger.success("✅ EventClient started successfully");

    // Avvia il polling immediato e poi ripeti ogni X secondi
    this.pollEvents(); // Prima esecuzione immediata
    this.intervalId = setInterval(() => {
      this.pollEvents();
    }, this.pollInterval);
    
    elizaLogger.log(`🔄 Polling started with interval: ${this.pollInterval}ms`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    elizaLogger.log("EventClient stopped");
  }

  private initializeOutputFile(): void {
    const outputDir = path.dirname(this.eventOutputPath);
    
    // Crea la directory se non esiste
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Inizializza il file con un array vuoto se non esiste
    if (!fs.existsSync(this.eventOutputPath)) {
      fs.writeFileSync(this.eventOutputPath, JSON.stringify([], null, 2));
      elizaLogger.log(`Initialized output file: ${this.eventOutputPath}`);
    }
  }

  private async pollEvents(): Promise<void> {
    try {
      // Controlla se il file di input esiste
      if (!fs.existsSync(this.eventInputPath)) {
        elizaLogger.debug(`Event input file not found: ${this.eventInputPath}`);
        return;
      }

      // Leggi gli eventi
      const fileContent = fs.readFileSync(this.eventInputPath, "utf8");
      const events: EventQuery[] = JSON.parse(fileContent);

      if (!Array.isArray(events)) {
        elizaLogger.error("Events file must contain an array");
        return;
      }

      // Processa solo eventi nuovi
      const newEvents = events.filter(
        (event) => !this.processedEvents.has(event.id)
      );

      if (newEvents.length > 0) {
        elizaLogger.log(`Found ${newEvents.length} new events to process`);

        for (const event of newEvents) {
          await this.processEvent(event);
          this.processedEvents.add(event.id);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        elizaLogger.error("Error polling events:", error);
      }
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
          source: "event",
          metadata: event.metadata,
        },
        createdAt: event.timestamp,
      };

      // Salva la memoria nel database
      await this.runtime.messageManager.createMemory(memory);

      // Componi lo stato per generare la risposta
      const state = await this.runtime.composeState(memory);

      elizaLogger.log(`Generating AI response for event ${event.id}...`);
      
      // Use Ollama API directly instead of text generation service
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

        // Get Ollama configuration from environment
        const ollamaUrl = process.env.OLLAMA_SERVER_URL || 'http://localhost:11434';
        const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.1:8b';

        // Call Ollama API directly
        const ollamaResponse = await fetch(`${ollamaUrl}/api/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: ollamaModel,
            prompt: context,
            stream: false,
            options: {
              temperature: 0.7,
              num_predict: 500,
            }
          }),
        });

        if (!ollamaResponse.ok) {
          throw new Error(`Ollama API error: ${ollamaResponse.status} ${ollamaResponse.statusText}`);
        }

        const ollamaData = await ollamaResponse.json();
        response = ollamaData.response || ollamaData.text || '';

        if (!response || response.trim().length === 0) {
          throw new Error('Empty response from Ollama');
        }

        elizaLogger.success(`Generated AI response for event ${event.id}: ${response.substring(0, 100)}...`);
      } catch (processError) {
        elizaLogger.error(`Error during Ollama generation:`, processError);
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
          source: "event",
          inReplyTo: memory.id,
        },
        createdAt: Date.now(),
      };

      await this.runtime.messageManager.createMemory(responseMemory);

      elizaLogger.log(`Response saved for event ${event.id}`);
    } catch (error) {
      elizaLogger.error(`Error processing event ${event.id}:`, error);
    }
  }

  private async saveResponse(response: EventResponse): Promise<void> {
    try {
      // Leggi le risposte esistenti
      let responses: EventResponse[] = [];
      
      if (fs.existsSync(this.eventOutputPath)) {
        const content = fs.readFileSync(this.eventOutputPath, "utf8");
        responses = JSON.parse(content);
      }

      // Aggiungi la nuova risposta
      responses.push(response);

      // Salva il file aggiornato
      fs.writeFileSync(
        this.eventOutputPath,
        JSON.stringify(responses, null, 2)
      );

      elizaLogger.log(`Response saved to ${this.eventOutputPath}`);
    } catch (error) {
      elizaLogger.error("Error saving response:", error);
      throw error;
    }
  }
}

// Export della classe come interfaccia Client
export class EventClientInterface {
  static async start(runtime: IAgentRuntime): Promise<EventClient> {
    const client = new EventClient(runtime);
    await client.start();
    return client;
  }
}

import { Client, IAgentRuntime } from "@elizaos/core";
export declare class EventClientWebSocket {
    private runtime;
    private websocketUrl;
    private ws?;
    private eventOutputPath;
    private processedEvents;
    private isRunning;
    private reconnectInterval;
    private reconnectTimeout?;
    private maxReconnectAttempts;
    private reconnectAttempts;
    constructor(runtime: IAgentRuntime);
    start(): Promise<void>;
    private connect;
    private handleReconnect;
    private isValidEvent;
    private handleEvent;
    private processEvent;
    private initializeOutputFile;
    private saveResponse;
    stop(): Promise<void>;
}
export declare const EventClientWebSocketInterface: Client;

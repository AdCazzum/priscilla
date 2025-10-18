import { IAgentRuntime } from "@elizaos/core";
export declare class EventClient {
    private runtime;
    private pollInterval;
    private eventInputPath;
    private eventOutputPath;
    private processedEvents;
    private isRunning;
    private intervalId?;
    constructor(runtime: IAgentRuntime);
    start(): Promise<void>;
    stop(): Promise<void>;
    private initializeOutputFile;
    private pollEvents;
    private processEvent;
    private saveResponse;
}
export declare class EventClientInterface {
    static start(runtime: IAgentRuntime): Promise<EventClient>;
}

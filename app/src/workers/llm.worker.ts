import { MLCEngine, MLCEngineWorkerHandler } from '@mlc-ai/web-llm';

const engine = new MLCEngine();
const handler = new MLCEngineWorkerHandler(engine);

self.onmessage = (event) => {
  handler.onmessage(event);
};

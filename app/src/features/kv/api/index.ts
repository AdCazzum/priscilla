import { AbiClient, AbiEvent } from '../../../api/AbiClient';
import { CalimeroApp } from '@calimero-network/calimero-client';

export { AbiClient };
export type { AbiEvent };

export type ApiResult<T> =
  | { data: T; error: null }
  | { data: null; error: { code: number; message: string } };

export function isOk<T>(
  result: ApiResult<T>,
): result is { data: T; error: null } {
  return result.error === null;
}

export async function createKvClient(app: CalimeroApp): Promise<AbiClient> {
  console.log('Creating KV client');
  let contexts = await app.fetchContexts();
  let context = contexts[0];

  if (!context) {
    console.log('No existing contexts found, creating a new one');
    await app.createContext();

    contexts = await app.fetchContexts();
    context = contexts[0];
  }

  if (!context) {
    throw new Error('Failed to resolve a context for the application');
  }

  return new AbiClient(app, context);
}

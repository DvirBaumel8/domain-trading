import dgram from 'node:dgram';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

export const mswServer = setupServer();

beforeAll(() => {
  vi.spyOn(dgram, 'createSocket').mockImplementation(() => { throw new Error('UDP blocked in tests'); });
});
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

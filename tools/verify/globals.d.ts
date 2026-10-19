// Dev/test adapter installed by apps/game/src/testapi.ts; typed loosely on the Node side.
export {};
declare global {
  interface Window {
    __HELSINKI_GAME__?: unknown;
    __HELSINKI_ERROR__?: string;
  }
}

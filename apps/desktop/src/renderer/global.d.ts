import type { FreeCordBridge } from "../shared/bridge";

declare global {
  interface Window {
    freecord: FreeCordBridge;
  }
}

export {};

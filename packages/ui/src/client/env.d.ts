import type { CoverseDesktopBridge } from "../shared/types.js";

declare global {
  interface Window {
    coverse: CoverseDesktopBridge;
  }
}

export {};

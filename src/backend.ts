import { invoke } from "@tauri-apps/api/core";

// In a plain `vite dev` browser there is no Tauri runtime, so backend calls are
// served by a fake scanner. The condition is statically false in production
// builds, which drops the mock module from the bundle.
const mockMode = import.meta.env.DEV && !("__TAURI_INTERNALS__" in window);

export const isMockMode = mockMode;

export async function callBackend<T = string>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (mockMode) {
    const { mockInvoke } = await import("./mockScan");
    return mockInvoke(cmd, args) as Promise<T>;
  }
  return invoke<T>(cmd, args);
}

import { ENV_CONSTANTS } from "./env";

export const DEBUG_ENABLED = ENV_CONSTANTS.DEBUG_ENABLED === "true"
export const DEBUG_LEVEL2 = ENV_CONSTANTS.DEBUG_LEVEL2 === "true"

export function debugLog(...args: any) {
  if (!DEBUG_ENABLED && !DEBUG_LEVEL2) return;
  console.log(...args)
}

export function debugTable(...args: any) {
  if (!DEBUG_ENABLED && !DEBUG_LEVEL2) return;
  console.table(...args)
}
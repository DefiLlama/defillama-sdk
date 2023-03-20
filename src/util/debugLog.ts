

export const DEBUG_ENABLED = process.env.SDK_DEBUG === "true"  || process.env.LLAMA_DEBUG_MODE

export function debugLog(...args: any) {
  if (!DEBUG_ENABLED) return;
  console.log(...args)
}

export function debugTable(...args: any) {
  if (!DEBUG_ENABLED) return;
  console.table(...args)
}
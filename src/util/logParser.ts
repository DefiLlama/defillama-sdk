import { Interface, ethers } from "ethers"

export function parseRawLogs(logs: any[], iface?: Interface) {
  if (!iface) return logs
  return logs.map((log: any) => {
    if (Array.isArray(log.topics) && log.topics.length) {
      const parsedLog = iface.parseLog(log)
      return {
        ...log,
        args: parsedLog?.args
      }
    }
    const topics = [log.topic0, log.topic1, log.topic2, log.topic3]
      .filter(t => t !== '' && t !== null && t !== undefined)
      .map((i: string) => i.startsWith('0x') ? i : `0x${i}`)
      .map((i: string) => ethers.zeroPadValue(i, 32))
    const parsedLog = iface.parseLog({
      data: log.data,
      topics
    })
    return {
      ...log,
      args: parsedLog?.args
    }
  })
}

import { Interface, ethers } from "ethers"

export function parseRawLogs(logs: any[], iface?: Interface) {
  if (!iface) return logs
  return logs.map((log: any) => {
    const topics = [log.topic0, log.topic1, log.topic2, log.topic3]
      .filter(t => t !== '' && t !== null && t !== undefined)
      .map(i => i.startsWith('0x') ? i : `0x${i}`)
      .map(i => ethers.zeroPadValue(i, 32))
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

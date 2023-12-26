
export const blockscoutEndpoints: any = {
  celo: 'https://explorer.celo.org',
  kava: 'https://explorer.kava.io',
  onus: 'https://explorer.onuschain.io',
  base: 'https://base.blockscout.com',
  scroll: 'https://blockscout.scroll.io',
}

export async function getBlockscoutBlock(timestamp: number, chain: string) {

  const api = `${blockscoutEndpoints[chain]}/api?module=block&action=getblocknobytime&timestamp=${timestamp}&closest=before`
  const res = await fetch(api)
  const data = await res.json()
  if (data.status !== '1')
    throw new Error(data.message)
  return {
    timestamp,
    block: +data.result.blockNumber,
    number: +data.result.blockNumber,
  }
}
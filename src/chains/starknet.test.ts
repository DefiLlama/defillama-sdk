import * as starknet from "./starknet";

const {
  getSelectorFromName, starknetKeccak, addAddressPadding, validateAndParseAddress, isStarknetAddress,
  encodeCalldata, decodeOutput, parseUint256, feltToShortString, shortStringToFelt, feltArrToStr,
  toHex, toBigInt, formCallBody, parseOutput, toBlockId, erc20Abis, erc20AbisCairo1,
} = starknet

const ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7'
const USDC = '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8'

// selectors hardcoded in server/defi/l2/utils.ts
const TOTAL_SUPPLY_SELECTOR = '0x1557182e4359a1f0c6301278e8f5b35a776ab58d39892581e357578fb287836'
const AGGREGATE_SELECTOR = '0x23ce8154ba7968a9d040577a2140e30474cee3aad4ba52d26bc483e648643f4'

const uint256Struct: starknet.AbiEntry = {
  name: 'Uint256',
  type: 'struct',
  size: 2,
  members: [{ name: 'low', type: 'felt', offset: 0 }, { name: 'high', type: 'felt', offset: 1 }],
}

describe('chains.starknet codec (offline)', () => {
  test('selectors match starknet.js / hardcoded literals', () => {
    expect(getSelectorFromName('balanceOf')).toBe('0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e')
    expect(getSelectorFromName('total_supply')).toBe(TOTAL_SUPPLY_SELECTOR)
    expect(getSelectorFromName('aggregate')).toBe(AGGREGATE_SELECTOR)
    expect(typeof starknetKeccak('balanceOf')).toBe('bigint')
    expect(toHex(starknetKeccak('balanceOf'))).toBe(getSelectorFromName('balanceOf'))
  })

  test('addAddressPadding pads to 66 chars', () => {
    const padded = addAddressPadding('0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7')
    expect(padded).toHaveLength(66)
    expect(padded).toBe(ETH)
    expect(addAddressPadding(1)).toBe('0x' + '0'.repeat(63) + '1')
  })

  test('validateAndParseAddress accepts valid addresses and rejects garbage', () => {
    expect(validateAndParseAddress('0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7')).toBe(ETH)
    expect(validateAndParseAddress(BigInt(5))).toBe('0x' + '0'.repeat(63) + '5')
    expect(() => validateAndParseAddress('garbage')).toThrow()
    expect(() => validateAndParseAddress('0xzz')).toThrow()
    expect(() => validateAndParseAddress('0x' + 'f'.repeat(64))).toThrow(/out of range/)
    expect(() => validateAndParseAddress(-1)).toThrow(/out of range/)
  })

  test('isStarknetAddress', () => {
    expect(isStarknetAddress(ETH)).toBe(true)
    expect(isStarknetAddress('0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7')).toBe(true)
    expect(isStarknetAddress('0xdac17f958d2ee523a2206206994597c13d831ec7')).toBe(false) // EVM shape
    expect(isStarknetAddress('0x0')).toBe(false)
    expect(isStarknetAddress('hello')).toBe(false)
    expect(isStarknetAddress(123)).toBe(false)
  })

  test('toHex / toBigInt', () => {
    expect(toHex(255)).toBe('0xff')
    expect(toHex('255')).toBe('0xff')
    expect(toHex('0xff')).toBe('0xff')
    expect(toBigInt(' 10 ')).toBe(BigInt(10))
    expect(toBigInt(true)).toBe(BigInt(1))
    expect(starknet.number.hexToDecimalString('0xff')).toBe('255')
  })

  test('encodeCalldata splits Uint256 into low/high', () => {
    const abi: starknet.AbiEntry = { name: 'transfer', type: 'function', inputs: [{ name: 'to', type: 'felt' }, { name: 'amount', type: 'Uint256' }] }
    const big = (BigInt(1) << BigInt(128)) + BigInt(7)
    // bare Uint256 (no struct definition)
    expect(encodeCalldata(abi, ['0x1', big])).toEqual(['0x1', '0x7', '0x1'])
    // with struct definition
    expect(encodeCalldata(abi, ['0x1', big], [uint256Struct])).toEqual(['0x1', '0x7', '0x1'])
    // object form
    expect(encodeCalldata(abi, ['0x1', { low: 5, high: 2 }], [uint256Struct])).toEqual(['0x1', '0x5', '0x2'])
    // Cairo 1 u256
    const abi1: starknet.AbiEntry = { name: 'transfer', type: 'function', inputs: [{ name: 'amount', type: 'core::integer::u256' }] }
    expect(encodeCalldata(abi1, [big])).toEqual(['0x7', '0x1'])
    // inputs array form
    expect(encodeCalldata(abi.inputs!, ['0x1', 3])).toEqual(['0x1', '0x3', '0x0'])
  })

  test('encodeCalldata handles felt, arrays, short strings and Cairo 0 _len', () => {
    const abi: starknet.AbiEntry = {
      name: 'f', type: 'function',
      inputs: [{ name: 'a', type: 'felt' }, { name: 'b_len', type: 'felt' }, { name: 'b', type: 'felt*' }, { name: 's', type: 'felt' }],
    }
    expect(encodeCalldata(abi, ['0x10', [1, 2, 3], 'ETH'])).toEqual(['0x10', '0x3', '0x1', '0x2', '0x3', '0x455448'])
    const abi1: starknet.AbiEntry = { name: 'f', type: 'function', inputs: [{ name: 'a', type: 'core::array::Array::<core::felt252>' }] }
    expect(encodeCalldata(abi1, [[9, 8]])).toEqual(['0x2', '0x9', '0x8'])
    expect(() => encodeCalldata(abi1, [])).toThrow(/missing parameter/)
  })

  test('decodeOutput felt / Uint256 / felt* arrays', () => {
    const feltAbi: starknet.AbiEntry = { name: 'decimals', type: 'function', inputs: [], outputs: [{ name: 'decimals', type: 'felt' }] }
    expect(decodeOutput(feltAbi, ['0x12'])).toEqual({ decimals: BigInt(18) })

    // bare Uint256 without struct definition decodes as ONE felt (starknet.js v5 parity)
    const u256Abi: starknet.AbiEntry = { name: 'totalSupply', type: 'function', inputs: [], outputs: [{ name: 'totalSupply', type: 'Uint256' }] }
    expect(decodeOutput(u256Abi, ['0x5', '0x0'])).toEqual({ totalSupply: BigInt(5) })
    // with the struct definition it decodes to { low, high }
    expect(decodeOutput(u256Abi, ['0x5', '0x2'], [uint256Struct])).toEqual({ totalSupply: { low: BigInt(5), high: BigInt(2) } })

    // Cairo 1 u256 -> single bigint, single unnamed output is returned directly
    const u256Abi1: starknet.AbiEntry = { name: 'total_supply', type: 'function', inputs: [], outputs: [{ type: 'core::integer::u256' }] }
    expect(decodeOutput(u256Abi1, ['0x5', '0x2'])).toBe((BigInt(2) << BigInt(128)) + BigInt(5))

    // Cairo 0 felt* with _len prefix
    const arrAbi: starknet.AbiEntry = { name: 'list', type: 'function', inputs: [], outputs: [{ name: 'items_len', type: 'felt' }, { name: 'items', type: 'felt*' }] }
    expect(decodeOutput(arrAbi, ['0x3', '0xa', '0xb', '0xc'])).toEqual({ items: [BigInt(10), BigInt(11), BigInt(12)] })

    // Cairo 1 Array / Span
    const arrAbi1: starknet.AbiEntry = { name: 'list', type: 'function', inputs: [], outputs: [{ type: 'core::array::Span::<core::felt252>' }] }
    expect(decodeOutput(arrAbi1, ['0x2', '0xa', '0xb'])).toEqual([BigInt(10), BigInt(11)])

    // bool, multiple outputs, outputs array form
    const multi: starknet.AbiEntry = { name: 'm', type: 'function', inputs: [], outputs: [{ name: 'ok', type: 'core::bool' }, { name: 'n', type: 'core::integer::u64' }] }
    expect(decodeOutput(multi, ['0x1', '0x2a'])).toEqual({ ok: true, n: BigInt(42) })
    expect(decodeOutput(multi.outputs!, ['0x0', '0x1'])).toEqual({ ok: false, n: BigInt(1) })
    expect(() => decodeOutput(multi, ['0x1'])).toThrow(/too short/)
  })

  test('decodeOutput structs, tuples, enums', () => {
    const pointStruct: starknet.AbiEntry = { name: 'Point', type: 'struct', members: [{ name: 'x', type: 'felt' }, { name: 'y', type: 'felt' }] }
    const abi: starknet.AbiEntry = { name: 'p', type: 'function', inputs: [], outputs: [{ name: 'p', type: 'Point' }] }
    expect(decodeOutput(abi, ['0x1', '0x2'], [pointStruct])).toEqual({ p: { x: BigInt(1), y: BigInt(2) } })

    const tupleAbi: starknet.AbiEntry = { name: 't', type: 'function', inputs: [], outputs: [{ type: '(core::felt252, core::integer::u256)' }] }
    expect(decodeOutput(tupleAbi, ['0x1', '0x2', '0x0'])).toEqual({ 0: BigInt(1), 1: BigInt(2) })

    const optionEnum: starknet.AbiEntry = {
      name: 'core::option::Option::<core::felt252>', type: 'enum',
      variants: [{ name: 'Some', type: 'core::felt252' }, { name: 'None', type: '()' }],
    }
    const optAbi: starknet.AbiEntry = { name: 'o', type: 'function', inputs: [], outputs: [{ type: 'core::option::Option::<core::felt252>' }] }
    expect(decodeOutput(optAbi, ['0x0', '0x7'], [optionEnum])).toBe(BigInt(7))
    expect(decodeOutput(optAbi, ['0x1'], [optionEnum])).toBeUndefined()
  })

  test('parseUint256', () => {
    const big = (BigInt(3) << BigInt(128)) + BigInt(9)
    expect(parseUint256({ low: 9, high: 3 })).toBe(big)
    expect(parseUint256(['0x9', '0x3'])).toBe(big)
    expect(parseUint256({ low: '9', high: '0' })).toBe(BigInt(9))
    expect(parseUint256(BigInt(12))).toBe(BigInt(12))
    expect(() => parseUint256(['0x1'])).toThrow()
  })

  test('short strings round trip', () => {
    expect(shortStringToFelt('ETH')).toBe('0x455448')
    expect(feltToShortString('0x455448')).toBe('ETH')
    expect(feltToShortString(BigInt('0x455448'))).toBe('ETH')
    expect(feltToShortString(shortStringToFelt('Wrapped Ether'))).toBe('Wrapped Ether')
    expect(feltToShortString(0)).toBe('')
    expect(feltArrToStr([BigInt('0x4142'), '0x43', 0x44])).toBe('ABCD')
    expect(() => shortStringToFelt('a'.repeat(32))).toThrow(/too long/)
  })

  test('formCallBody', () => {
    const body = formCallBody({ abi: erc20Abis.balanceOf, target: ETH.toUpperCase().replace('0X', '0x'), params: '0x123' }, 7)
    expect(body.method).toBe('starknet_call')
    expect(body.id).toBe(7)
    expect(body.params[1]).toBe('latest')
    const req = body.params[0] as starknet.StarknetCallRequest
    expect(req.contract_address).toBe(ETH)
    expect(req.entry_point_selector).toBe(getSelectorFromName('balanceOf'))
    expect(req.calldata).toEqual(['0x123'])
    // customInput 'address' passes params through; decimal felts get normalized to hex
    const body2 = formCallBody({ abi: erc20Abis.balanceOf, target: ETH, params: ['291'], block: 1000 })
    expect((body2.params[0] as starknet.StarknetCallRequest).calldata).toEqual(['0x123'])
    expect(body2.params[1]).toEqual({ block_number: 1000 })
    // encoded path
    const body3 = formCallBody({ abi: erc20AbisCairo1.balanceOf, target: ETH, params: [USDC] })
    expect((body3.params[0] as starknet.StarknetCallRequest).calldata).toEqual([toHex(USDC)])
    expect(() => formCallBody({ abi: erc20Abis.decimals, target: '' })).toThrow(/missing target/)
  })

  test('toBlockId', () => {
    expect(toBlockId()).toBe('latest')
    expect(toBlockId('pending')).toBe('pending')
    expect(toBlockId(12)).toEqual({ block_number: 12 })
    expect(toBlockId('12')).toEqual({ block_number: 12 })
    expect(toBlockId('0xabc')).toEqual({ block_hash: '0xabc' })
    expect(toBlockId({ block_hash: '0x1' })).toEqual({ block_hash: '0x1' })
    expect(() => toBlockId('nope')).toThrow()
  })

  test('parseOutput post-processing', () => {
    expect(parseOutput(['0x12'], erc20Abis.decimals)).toBe(18)
    expect(parseOutput(['0x12'], erc20AbisCairo1.decimals)).toBe(18)
    expect(parseOutput(['0x5', '0x0'], erc20Abis.totalSupply)).toBe(5)
    expect(parseOutput(['0x5', '0x2'], erc20AbisCairo1.totalSupply)).toBe(((BigInt(2) << BigInt(128)) + BigInt(5)).toString())
    expect(parseOutput(['0x455448'], erc20Abis.symbol)).toBe(String(BigInt('0x455448')))
    const addrAbi: starknet.AbiEntry = { name: 'token0', type: 'function', inputs: [], outputs: [{ name: 'token', type: 'felt' }], customType: 'address' }
    expect(parseOutput(['0x1'], addrAbi)).toBe('0x' + '0'.repeat(63) + '1')
    // multiple outputs -> object of strings
    const multi: starknet.AbiEntry = { name: 'r', type: 'function', inputs: [], outputs: [{ name: 'a', type: 'felt' }, { name: 'b', type: 'felt' }] }
    expect(parseOutput(['0x1', '0x2'], multi)).toEqual({ a: '1', b: '2' })
    // failures
    expect(parseOutput(undefined, erc20Abis.decimals, [], { permitFailure: true })).toBeNull()
    expect(() => parseOutput(undefined, erc20Abis.decimals, [], { error: { message: 'boom', data: { revert_error: 'reverted' } } })).toThrow(/boom: reverted/)
  })

  test('config', () => {
    expect(starknet.getEndpoints().length).toBeGreaterThan(0)
    expect(starknet.getMulticallAddress()).toBe(starknet.DEFAULT_MULTICALL_ADDRESS)
    expect(starknet.cairoErc20Abis).toBe(erc20AbisCairo1)
    expect(Object.keys(erc20Abis).sort()).toEqual(['allowance', 'balanceOf', 'decimals', 'name', 'symbol', 'totalSupply'])
  })
})

describe('chains.starknet live', () => {
  test('call: ETH decimals === 18', async () => {
    const decimals = await starknet.call({ abi: erc20Abis.decimals, target: ETH })
    expect(decimals).toBe(18)
  })

  test('multiCall decimals via aggregator and batched', async () => {
    const calls = [ETH, USDC]
    const viaAggregator = await starknet.multiCall({ abi: erc20Abis.decimals, calls })
    expect(viaAggregator).toEqual([18, 6])
    const viaBatch = await starknet.multiCall({ abi: erc20Abis.decimals, calls, useAggregator: false })
    expect(viaBatch).toEqual([18, 6])
  })

  test('multiCall with target + params, mixed abis, permitFailure', async () => {
    const res = await starknet.multiCall({
      calls: [
        { target: ETH, abi: erc20Abis.decimals },
        { target: USDC, abi: erc20AbisCairo1.decimals },
        { target: ETH, abi: erc20Abis.balanceOf, params: [USDC] },
      ],
    })
    expect(res[0]).toBe(18)
    expect(res[1]).toBe(6)
    expect(typeof res[2]).toBe('number')
    // a bogus entrypoint reverts: aggregator falls back to batched, permitFailure yields null
    const bogus: starknet.AbiEntry = { name: 'no_such_entrypoint_xyz', type: 'function', inputs: [], outputs: [{ name: 'x', type: 'felt' }] }
    const res2 = await starknet.multiCall({ calls: [{ target: ETH, abi: erc20Abis.decimals }, { target: ETH, abi: bogus }], permitFailure: true })
    expect(res2).toEqual([18, null])
    await expect(starknet.call({ abi: bogus, target: ETH })).rejects.toThrow(/failed/)
  })

  test('getBlockNumber > 0 and getBlock', async () => {
    const n = await starknet.getBlockNumber()
    expect(n).toBeGreaterThan(0)
    const block = await starknet.getBlock({ blockNumber: n - 5 })
    expect(block.number).toBe(n - 5)
    expect(block.timestamp).toBeGreaterThan(1_600_000_000)
  })

  test('getLogs on a small recent range returns an array', async () => {
    const latest = await starknet.getBlockNumber()
    const logs = await starknet.getLogs({ target: ETH, fromBlock: latest - 3, toBlock: latest, topics: [getSelectorFromName('Transfer')] })
    expect(Array.isArray(logs)).toBe(true)
    // an oversized page size is shrunk and retried rather than failing
    const logs2 = await starknet.getLogs({ target: ETH, fromBlock: latest - 1, toBlock: latest, topics: [getSelectorFromName('Transfer')], chunkSize: 5000 })
    expect(Array.isArray(logs2)).toBe(true)
    expect(logs2.length).toBeLessThanOrEqual(logs.length)
    if (logs.length) {
      // nodes return unpadded addresses
      expect(addAddressPadding(logs[0].from_address)).toBe(ETH)
      expect(toHex(logs[0].keys[0])).toBe(getSelectorFromName('Transfer'))
      expect(Array.isArray(logs[0].keys)).toBe(true)
      expect(Array.isArray(logs[0].data)).toBe(true)
    }
  })
})

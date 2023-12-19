import { call, multiCall, fetchList, } from "./abi2";
import { ChainApi } from "../ChainApi";
import { debugLog } from "../util/debugLog";

test("getBlock failure: echelon", async () => {
  const api = new ChainApi({ chain: "echelon", timestamp: Math.floor(Date.now() / 1000) })
  try {
    await api.getBlock()
    expect(true).toEqual(false)     // automatically fail if we get here
  } catch (e: any) {
    debugLog(e.message)
    expect(e.message).toContain("Failed to")
  }
});

test("getBlock failure: kekchain", async () => {
  const api = new ChainApi({ chain: "kekchain", timestamp: Math.floor(Date.now() / 1000) })
  try {
    await api.getBlock()
    expect(true).toEqual(false)     // automatically fail if we get here
  } catch (e: any) {
    debugLog(e.message)
    expect(e.message).toContain("Failed to")
  }
});


test("multicall failure: kekchain", async () => {
  const api = new ChainApi({ chain: "kekchain" })
  try {
    await api.fetchList({ target: '0xfe0139503a1B97F7f6c2b72f4020df7A6c1EE399', lengthAbi: 'uint256:allPairsLength', itemAbi: 'function allPairs(uint256) view returns (address)' })
    expect(true).toEqual(false)     // automatically fail if we get here
  } catch (e: any) {
    debugLog(e.message)
    expect(e.message).toContain("Failed to")
    expect(e.message).toContain("host:")
  }
});


test("bad fetchlist failure: ethereum", async () => {
  const api = new ChainApi({  })
  try {
    await api.fetchList({ target: '0x96FF042f8c6757fCE515d171F194b5816CAFEe11', lengthAbi: 'uint256:allPairsLength', itemAbi: 'function allPairs(uint256) view returns (address)' })
    await api.fetchList({ target: '0xfe0139503a1B97F7f6c2b72f4020df7A6c1EE399', lengthAbi: 'uint256:allPairsLength', itemAbi: 'function allPairs(uint256) view returns (address)' })
    expect(true).toEqual(false)     // automatically fail if we get here
  } catch (e: any) {
    debugLog(e.message)
    expect(e.message).toContain("Failed to")
    expect(e.message).toContain("0xfe0139503a1B97F7f6c2b72f4020df7A6c1EE399")
  }
});

test("bad call failure: ethereum", async () => {
  const api = new ChainApi({  })
  try {
    await api.call({ target: '0x96FF042f8c6757fCE515d171F194b5816CAFEe11', abi: 'uint256:allPairsLength'})
    await api.call({ target: '0xfe0139503a1B97F7f6c2b72f4020df7A6c1EE399', abi: 'uint256:allPairsLength' })
    expect(true).toEqual(false)     // automatically fail if we get here
  } catch (e: any) {
    debugLog(e.message)
    expect(e.message).toContain("Failed to")
    expect(e.message).toContain("0xfe0139503a1B97F7f6c2b72f4020df7A6c1EE399")
  }
});


test("bad multicall failure: ethereum", async () => {
  const api = new ChainApi({  })
  try {
    await api.multiCall({ calls: [
      '0x96FF042f8c6757fCE515d171F194b5816CAFEe11',
      '0x96FF042f8c6757fCE515d171F194b5816CAFEe11',
      '0x96FF042f8c6757fCE515d171F194b5816CAFEe11',
    ], abi: 'uint256:allPairsLength'})
    await api.multiCall({ calls: [
      '0xfe0139503a1B97F7f6c2b72f4020df7A6c1EE399',
      '0xfe0139503a1B97F7f6c2b72f4020df7A6c1EE399',
      '0xfe0139503a1B97F7f6c2b72f4020df7A6c1EE399',
    ], abi: 'uint256:allPairsLength'})
    expect(true).toEqual(false)     // automatically fail if we get here
  } catch (e: any) {
    debugLog(e.message)
    expect(e.message).toContain("Multicall failed!")
    expect(e.message).toContain("0xfe0139503a1B97F7f6c2b72f4020df7A6c1EE399")
  }
});

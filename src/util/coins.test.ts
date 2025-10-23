import { getPrices, getMcaps } from "./coins";

test("coinsApi - mcaps", async () => {
    const res = await getMcaps(["coingecko:tether"], "now");
    expect(res["coingecko:tether"].mcap).toBeGreaterThan(100_000);
    expect(res["coingecko:tether"].mcap).toBeLessThan(1_000_000_000_000);
    expect(res["coingecko:tether"].timestamp).toBeGreaterThan(Math.floor(Date.now() / 1e3 - 3600));
    expect(Object.keys(res).length).toBe(1);
})

test("coinsApi - prices", async () => {
    const res = await getPrices(["coingecko:tether", "ethereum:0xDAc17f958d2ee523a2206206994597c13d831ec7", "solana:So11111111111111111111111111111111111111112"], "now");
    const res2 = await getPrices(["coingecko:tether", "ethereum:0xDAc17f958d2ee523a2206206994597c13d831ec7", "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7", "solana:So11111111111111111111111111111111111111112"], "now");
    expect(res["coingecko:tether"].price).toBe(1);
    expect(res["ethereum:0xDAc17f958d2ee523a2206206994597c13d831ec7"].symbol).toBe("USDT");
    expect(res2["ethereum:0xDAc17f958d2ee523a2206206994597c13d831ec7"].decimals).toBe(6);
    expect(res2["ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7"].decimals).toBe(6);
    expect(Object.keys(res).length).toBe(3);
    expect(res["solana:So11111111111111111111111111111111111111112"].timestamp).toBeGreaterThan(Math.floor(Date.now() / 1e3 - 3600));
})

test("coinsApi - prices with timestamp", async () => {
    const timestamp = Math.floor(Date.now() / 1e3)
    const res = await getPrices(["coingecko:ethereum"], timestamp - 7200);
    expect(res["coingecko:ethereum"].price).toBeGreaterThan(1000);
    expect(res["coingecko:ethereum"].timestamp).toBeLessThanOrEqual(timestamp - 7200 + 3600); // within an hour of requested timestamp
    expect(Object.keys(res).length).toBe(1);
})
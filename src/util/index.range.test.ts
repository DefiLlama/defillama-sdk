import { getLogs } from './index';

jest.mock('../general', () => ({ getProvider: jest.fn() }));
jest.mock('./common', () => ({
  formError: (error: unknown) => error,
  getProviderUrl: () => 'mock://log-range',
  sumSingleBalance: jest.fn(),
}));

test('getLogs fetches an inclusive single-block range', async () => {
  const provider = {
    getLogs: jest.fn(async () => [{ blockNumber: 42, index: 0, topics: [] }]),
  };
  const { output } = await getLogs({
    fromBlock: 42, toBlock: 42, topic: 'Transfer(address,address,uint256)',
    keys: [], chain: 'ethereum', provider: provider as any,
  });

  expect(provider.getLogs).toHaveBeenCalledTimes(1);
  expect(provider.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 42, toBlock: 42 }));
  expect(output).toHaveLength(1);
});

test('getLogs splits inclusive ranges without repeating boundary blocks', async () => {
  const provider = {
    getLogs: jest.fn(async ({ fromBlock, toBlock }: { fromBlock: number, toBlock: number }) => {
      if (toBlock - fromBlock + 1 > 1000) throw new Error('range too large');
      return Array.from({ length: toBlock - fromBlock + 1 }, (_, i) => ({
        blockNumber: fromBlock + i, index: 0, topics: [],
      }));
    }),
  };
  const { output } = await getLogs({
    fromBlock: 0, toBlock: 2001, topic: 'Transfer(address,address,uint256)',
    keys: [], chain: 'ethereum', provider: provider as any,
  });

  expect(output.map(log => log.blockNumber)).toEqual(Array.from({ length: 2002 }, (_, i) => i));
});

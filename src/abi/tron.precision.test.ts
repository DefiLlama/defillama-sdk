import { getBalance, getBalances } from './tron';
import { postJson } from '../util/common';

jest.mock('../util/common', () => ({
  ...jest.requireActual('../util/common'),
  postJson: jest.fn(),
  sleepRandom: jest.fn().mockResolvedValue(undefined),
}));

const post = postJson as jest.MockedFunction<typeof postJson>;
let fixtureId = 0;

beforeEach(() => {
  post.mockReset();
});

test.each([
  {
    name: 'sum of safe integer components above MAX_SAFE_INTEGER',
    account: {
      frozenV2: [{ amount: 8_852_507_928_866_978 }],
      account_resource: { delegated_frozenV2_balance_for_energy: 886_449_393_565_759 },
    },
    expected: '9738957322432737',
  },
  {
    name: 'large integer strings from an account response',
    account: { balance: '9007199254740993', frozenV2: [{ amount: '2' }] },
    expected: '9007199254740995',
  },
  {
    name: 'all included components contribute to the exact sum',
    account: {
      balance: Number.MAX_SAFE_INTEGER,
      frozen: [{ frozen_balance: 1 }],
      frozenV2: [{ amount: 1 }, { type: 'TRON_POWER' }],
      delegated_frozenV2_balance_for_bandwidth: 1,
      account_resource: { delegated_frozenV2_balance_for_energy: 1 },
    },
    expected: '9007199254740995',
  },
  { name: 'empty account', account: {}, expected: '0' },
  {
    name: 'omitted legacy frozen balances contribute zero',
    account: {
      balance: 7,
      frozen: [{}, { expire_time: 1_700_000_000_000 }, { frozen_balance: 0 }, { frozen_balance: '0' }],
    },
    expected: '7',
  },
  {
    name: 'omitted legacy entries preserve an exact nonzero balance',
    account: {
      balance: Number.MAX_SAFE_INTEGER,
      frozen: [{ expire_time: 1_700_000_000_000 }, { frozen_balance: 2 }, {}],
    },
    expected: '9007199254740993',
  },
  {
    name: 'ordinary free, frozen and delegated balances',
    account: {
      balance: 100,
      frozen: [{ frozen_balance: 5 }, { frozen_balance: 7 }],
      frozenV2: [{ amount: 10 }, { amount: 3 }, { type: 'TRON_POWER' }],
      delegated_frozenV2_balance_for_bandwidth: 20,
      account_resource: { delegated_frozenV2_balance_for_energy: 30 },
    },
    expected: '175',
  },
  {
    name: 'received delegation is excluded from owned TRX',
    account: {
      balance: 7,
      frozenV2: [{ amount: 17 }],
      acquired_delegated_frozenV2_balance_for_bandwidth: 1000,
      account_resource: { acquired_delegated_frozenV2_balance_for_energy: 2000 },
    },
    expected: '24',
  },
])('TRON raw balance: $name', async ({ account, expected }) => {
  post.mockResolvedValue(account);
  expect(await getBalance({ target: `precision-fixture-${fixtureId++}` })).toEqual({ output: expected });
});

test('TRON raw balance rejects invalid legacy integer strings', async () => {
  post.mockResolvedValue({ balance: 7, frozen: [{ frozen_balance: 'invalid' }] });
  await expect(getBalance({ target: `precision-fixture-${fixtureId++}` })).rejects.toThrow(SyntaxError);
});

test('TRON balance keeps decimal formatting for ordinary values', async () => {
  post.mockResolvedValue({ balance: 1_000_000, frozenV2: [{ amount: 500_000 }] });
  expect(await getBalance({ target: `precision-fixture-${fixtureId++}`, decimals: 6 })).toEqual({ output: '1.5' });
});

test('TRON batch balances preserve exact strings and target order', async () => {
  const targets = [`precision-fixture-${fixtureId++}`, `precision-fixture-${fixtureId++}`];
  post.mockResolvedValueOnce({ balance: Number.MAX_SAFE_INTEGER, frozenV2: [{ amount: 2 }] });
  post.mockResolvedValueOnce({ balance: 5 });
  expect(await getBalances({ targets })).toEqual({
    output: [{ target: targets[0], balance: '9007199254740993' }, { target: targets[1], balance: '5' }],
  });
});

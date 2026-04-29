import {
  isRPCQuarantined,
  recordRPCFailure,
  recordRPCSuccess,
  _resetRPCQuarantineForTests,
} from './LlamaProvider'

beforeEach(() => {
  _resetRPCQuarantineForTests()
})

test("RPC is not quarantined by default", () => {
  expect(isRPCQuarantined('https://fresh.example')).toBe(false)
})

test("RPC is quarantined after threshold consecutive failures", () => {
  const url = 'https://dead.example'
  // Default threshold is 5; record 5 failures.
  for (let i = 0; i < 5; i++) recordRPCFailure(url)
  expect(isRPCQuarantined(url)).toBe(true)
})

test("a single success below threshold resets the failure counter", () => {
  const url = 'https://flaky.example'
  for (let i = 0; i < 4; i++) recordRPCFailure(url)
  expect(isRPCQuarantined(url)).toBe(false)
  recordRPCSuccess(url)
  // After success, even 4 more failures should not quarantine (counter reset)
  for (let i = 0; i < 4; i++) recordRPCFailure(url)
  expect(isRPCQuarantined(url)).toBe(false)
})

test("quarantine expires after the configured duration", () => {
  const url = 'https://dead2.example'
  const realNow = Date.now
  let now = 1_700_000_000_000
  Date.now = () => now

  try {
    for (let i = 0; i < 5; i++) recordRPCFailure(url)
    expect(isRPCQuarantined(url)).toBe(true)

    // advance past default 10-minute quarantine
    now += 10 * 60 * 1000 + 1
    expect(isRPCQuarantined(url)).toBe(false)
  } finally {
    Date.now = realNow
  }
})

test("quarantine does not double-extend on further failures during the window", () => {
  const url = 'https://dead3.example'
  const realNow = Date.now
  let now = 1_700_000_000_000
  Date.now = () => now

  try {
    for (let i = 0; i < 5; i++) recordRPCFailure(url)
    expect(isRPCQuarantined(url)).toBe(true)

    // more failures during quarantine should not push the deadline further out
    for (let i = 0; i < 10; i++) recordRPCFailure(url)

    now += 10 * 60 * 1000 + 1
    expect(isRPCQuarantined(url)).toBe(false)
  } finally {
    Date.now = realNow
  }
})

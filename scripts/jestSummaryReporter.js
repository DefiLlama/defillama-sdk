// Custom jest reporter: prints failed tests (with their messages) first, then a
// per-suite table of passed / failed / skipped counts and a totals row.
// Wired in via jest.config.js `reporters`; jest `silent: true` swallows console.* from tests.
const path = require('path')

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
const color = (c, s) => process.stdout.isTTY ? `${c}${s}${RESET}` : String(s)

class SummaryReporter {
  constructor(globalConfig) {
    this.rootDir = globalConfig.rootDir
  }

  onTestResult(_test, result) {
    const suite = path.relative(this.rootDir, result.testFilePath)
    const status = result.numFailingTests || result.testExecError ? color(RED, 'FAIL') : color(GREEN, 'PASS')
    process.stdout.write(`${status} ${suite} ${color(DIM, `(${(result.perfStats.runtime / 1000).toFixed(1)}s)`)}\n`)
  }

  onRunComplete(_contexts, results) {
    const rows = results.testResults.map(r => ({
      suite: path.relative(this.rootDir, r.testFilePath),
      passed: r.numPassingTests,
      failed: r.numFailingTests + (r.testExecError ? 1 : 0),
      skipped: r.numPendingTests + r.numTodoTests,
      time: (r.perfStats.runtime / 1000).toFixed(1) + 's',
      failures: [
        ...(r.testExecError ? [{ name: '(suite failed to run)', message: r.failureMessage || String(r.testExecError.message || r.testExecError) }] : []),
        ...r.testResults.filter(t => t.status === 'failed').map(t => ({ name: t.fullName, message: failureMessage(t) })),
      ],
    }))

    const failed = rows.filter(r => r.failures.length)
    if (failed.length) {
      process.stdout.write(`\n${color(BOLD + RED, 'Failed tests')}\n`)
      for (const row of failed) {
        for (const f of row.failures) {
          process.stdout.write(`\n${color(RED, '●')} ${row.suite} › ${f.name}\n`)
          process.stdout.write(indent(stripAnsiIfNotTty(f.message)) + '\n')
        }
      }
    }

    const totals = rows.reduce((t, r) => ({ passed: t.passed + r.passed, failed: t.failed + r.failed, skipped: t.skipped + r.skipped }), { passed: 0, failed: 0, skipped: 0 })
    const table = [
      ['Suite', 'Passed', 'Failed', 'Skipped', 'Time'],
      ...rows.sort((a, b) => b.failed - a.failed || a.suite.localeCompare(b.suite)).map(r => [r.suite, r.passed, r.failed, r.skipped, r.time]),
      ['TOTAL', totals.passed, totals.failed, totals.skipped, ((Date.now() - results.startTime) / 1000).toFixed(1) + 's'],
    ]
    process.stdout.write(`\n${color(BOLD, 'Summary')}\n${renderTable(table, rows.length)}\n`)
    const verdict = totals.failed ? color(RED, `${totals.failed} failed`) : color(GREEN, 'all passed')
    process.stdout.write(`${results.numTotalTestSuites} suites, ${results.numTotalTests} tests: ${verdict}\n`)
  }
}

function renderTable(rows, dataRowCount) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i]).length)))
  const line = (cells) => '| ' + cells.map((c, i) => i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i])).join(' | ') + ' |'
  const sep = '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|'
  const [header, ...body] = rows
  const data = body.slice(0, dataRowCount).map(r => {
    const s = line(r)
    return r[2] > 0 ? color(RED, s) : s
  })
  const total = line(body[dataRowCount])
  return [line(header), sep, ...data, sep, color(BOLD, total)].join('\n')
}

// errors thrown without a message/stack (plain objects, formError results) leave failureMessages blank
function failureMessage(t) {
  const message = t.failureMessages.join('\n').trim()
  if (message) return message
  const details = (t.failureDetails || []).map(d => {
    if (d && typeof d === 'object') return d.message || d.stack || JSON.stringify(d, null, 2)
    return String(d)
  }).filter(Boolean)
  return details.length ? details.join('\n') : '(no error message)'
}

function indent(s) {
  return String(s).split('\n').map(l => '    ' + l).join('\n')
}

function stripAnsiIfNotTty(s) {
  return process.stdout.isTTY ? s : String(s).replace(/\x1b\[[0-9;]*m/g, '')
}

module.exports = SummaryReporter

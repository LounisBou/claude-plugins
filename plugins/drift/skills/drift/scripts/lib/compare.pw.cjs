// drift shots' comparison, a Playwright spec: `drift shots` copies it into the run directory, with
// the path of the shared Playwright install in place of its placeholder, once both sides are
// captured. Each pair is compared by Playwright's own comparator (`toMatchSnapshot`, base being the
// snapshot, copied under a name its file naming keeps as it is): when they differ, the diff image it writes is copied to `<diff>/<pair>.png`; when the
// comparison itself fails, its first line goes to `<diff>/<pair>.error.txt`.
'use strict'
const { test, expect } = require(__PLAYWRIGHT_MODULE__)
const fs = require('node:fs')
const path = require('node:path')

const plan = JSON.parse(fs.readFileSync(process.env.DRIFT_PLAN, 'utf8'))

for (const { pair, snapshot } of plan.pairs) {
  test(pair, async ({}, testInfo) => {
    const head = fs.readFileSync(path.join(plan.head, `${pair}.png`))
    try {
      expect(head).toMatchSnapshot(`${snapshot}.png`, { threshold: plan.threshold, maxDiffPixels: 0 })
    } catch (error) {
      const diff = testInfo.outputPath(`${snapshot}-diff.png`)
      if (fs.existsSync(diff)) fs.copyFileSync(diff, path.join(plan.diff, `${pair}.png`))
      else fs.writeFileSync(path.join(plan.diff, `${pair}.error.txt`), `${String(error && error.message || error).split('\n')[0]}\n`)
    }
  })
}

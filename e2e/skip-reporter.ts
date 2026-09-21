import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * TES-119: a Playwright run that skips every real-key assertion still exits
 * 0 and shows green in the list/github reporters — that is exactly how the
 * TES-117 guard (`branch-off-earlier-node.spec.ts`) went unrun in CI for
 * weeks without anyone noticing. This reporter makes a skip impossible to
 * miss in the log, and — when `E2E_FAIL_ON_SKIP` is set — turns it into a
 * failing run instead of a silent one. Set that variable only where a skip
 * is never expected (the nightly real-key job); leave it unset for local
 * runs and the per-PR job, where skipping without `DATABASE_URL` /
 * `E2E_ANTHROPIC_API_KEY` is normal.
 */
export default class SkipReporter implements Reporter {
  private skipped: { title: string; file: string }[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== "skipped") return;
    this.skipped.push({
      title: test.titlePath().slice(1).join(" › "),
      file: test.location.file,
    });
  }

  onEnd() {
    if (this.skipped.length === 0) return;

    const lines = [
      "",
      `⚠ ${this.skipped.length} e2e test(s) skipped:`,
      ...this.skipped.map((s) => `⚠   ${s.title}  (${s.file})`),
      "",
    ];
    for (const line of lines) console.log(line);

    if (process.env.CI) {
      console.log(
        `::warning::${this.skipped.length} e2e test(s) skipped — see the lines above`,
      );
    }

    if (process.env.E2E_FAIL_ON_SKIP) {
      console.log(
        "E2E_FAIL_ON_SKIP is set — failing this run because of the skips above.",
      );
      process.exitCode = 1;
    }
  }
}

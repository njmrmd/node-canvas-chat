import { mkdir } from "node:fs/promises";
import { withPage, sleep } from "./lib/cdp.mjs";

const BASE = "http://127.0.0.1:3100";
const EMAIL = `tes116-verify+${Date.now()}@example.com`;
const PASSWORD = "TES-116-verify-pass-1!";
const OUT = "/tmp/tes116-shots";

const fillJs = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

await mkdir(OUT, { recursive: true });

await withPage(async (page) => {
  await page.emulate({ width: 1440, height: 900, mobile: false, scheme: "light" });
  await page.navigate(`${BASE}/sign-up`);
  await sleep(500);
  await page.eval(fillJs("#email", EMAIL));
  await page.eval(fillJs("#password", PASSWORD));
  await page.eval(`document.querySelector('button[type="submit"]').click()`);
  await sleep(2000);
  await page.navigate(`${BASE}/canvas`);
  await sleep(1500);

  const { writeFile } = await import("node:fs/promises");
  const desktopPng = await page.screenshot();
  await writeFile(`${OUT}/desktop.png`, desktopPng);
  console.log("wrote desktop.png");

  await page.emulate({ width: 390, height: 844, mobile: true, scheme: "light" });
  await sleep(500);
  const mobilePng = await page.screenshot();
  await writeFile(`${OUT}/mobile.png`, mobilePng);
  console.log("wrote mobile.png");
});

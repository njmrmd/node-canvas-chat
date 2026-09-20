import { withPage, sleep } from "./lib/cdp.mjs";
const BASE = "https://node-canvas-chat.vercel.app";
const EMAIL = "platform-eng-tes67-verify+1789859719@example.com";
const PASSWORD = process.env.QA_TEST_ACCOUNT_PASSWORD;
const fillJs = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`;
await withPage(async (page) => {
  await page.emulate({ width: 1440, height: 900, mobile: false, scheme: "light" });
  await page.navigate(`${BASE}/sign-in`);
  await sleep(800);
  await page.eval(fillJs("#email", EMAIL));
  await page.eval(fillJs("#password", PASSWORD));
  await page.eval(`document.querySelector('button[type="submit"]').click()`);
  await sleep(2000);
  await page.navigate(`${BASE}/canvas`);
  await sleep(1500);

  const before = await page.eval(`fetch('/api/canvas').then(r => r.json()).then(j => JSON.stringify(
    j.graph.nodeIds.map(id => ({ id: id.slice(0,8), parentId: j.graph.nodesById[id].parentId?.slice(0,8) || null, x: j.graph.nodesById[id].position.x, y: j.graph.nodesById[id].position.y }))
  ))`);
  console.log("before Tidy:", before);

  const tidyClicked = await page.eval(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Tidy');
    if (b) { b.click(); return true; }
    return false;
  })()`);
  console.log("Tidy clicked:", tidyClicked);
  await sleep(1500);

  const after = await page.eval(`fetch('/api/canvas').then(r => r.json()).then(j => JSON.stringify(
    j.graph.nodeIds.map(id => ({ id: id.slice(0,8), parentId: j.graph.nodesById[id].parentId?.slice(0,8) || null, x: j.graph.nodesById[id].position.x, y: j.graph.nodesById[id].position.y }))
  ))`);
  console.log("after Tidy:", after);

  const beforeArr = JSON.parse(before);
  const afterArr = JSON.parse(after);
  // group by parentId, check distinct x among siblings
  function checkDistinct(arr, label) {
    const byParent = {};
    for (const n of arr) {
      const key = n.parentId || "root";
      (byParent[key] ||= []).push(n.x);
    }
    for (const [parent, xs] of Object.entries(byParent)) {
      if (xs.length > 1) {
        const distinct = new Set(xs).size === xs.length;
        console.log(`${label}: parent=${parent} children_x=${JSON.stringify(xs)} distinct=${distinct}`);
      }
    }
  }
  checkDistinct(beforeArr, "before Tidy");
  checkDistinct(afterArr, "after Tidy");
});

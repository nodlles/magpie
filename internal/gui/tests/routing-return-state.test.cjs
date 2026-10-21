// Opening a request's routing from Usage changes what Routing shows. Keep the
// day, picked request and purpose filter it had before that jump, and let
// "Back to previous routing view" put them back. Usage and Routing use fake APIs.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = process.env.ASSET_DIR || path.resolve(__dirname, "../assets");
const aday = "2026-10-20";
const bday = "2026-10-19";
const now = new Date();

const route = (id, day, model, kind) => ({
  id,
  seq: id,
  time: `${day}T10:00:00Z`,
  agent: "codex",
  model,
  provider: "relay",
  kind,
  done: true,
  order: [{ id: "relay", provider: "relay", name: "Relay", kind: "provider", model, routing: "order" }],
  tries: [{ id: "relay", model, start: `${day}T10:00:00Z`, done: true, status: 200, ms: 420 }],
  status: 200,
  ms: 420,
});
const oldRoute = route(101, aday, "model-before", "review");
const otherRoute = route(100, aday, "model-other", "guardian");
const usageRoute = route(202, bday, "model-opened", "guardian");

const words = {
  en: "Back to previous routing view",
  zh: "返回上一次路由状态",
  "zh-TW": "返回上一次路由狀態",
  ja: "前回のルーティング表示に戻る",
  de: "Zurück zur vorherigen Weiterleitungsansicht",
};

function serve(lang) {
  return async (request) => {
    const url = new URL(request.request().url());
    const json = (body) => request.fulfill({ json: body });
    if (url.pathname === "/boot.js") return request.fulfill({ contentType: "text/javascript", body: `window.bootPrefs={lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return request.fulfill({ contentType: "text/javascript", body: "export const Window={};" });
    if (url.pathname === "/api/state") return json({ agents: [{ id: "codex", name: "Codex", path: "/fixture/config.toml", fields: [] }], profiles: [], settings: { lang, theme: "light" } });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true } });
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/gateway/trace") return json({
      mine: true, seq: 300, now: now.toISOString(), totals: { requests: 0, rerouted: 0, errors: 0 }, routes: [],
    });
    if (url.pathname === "/api/gateway/history") {
      const day = url.searchParams.get("day");
      return json({
        cut: false,
        days: [{ day: aday, requests: 2 }, { day: bday, requests: 1 }],
        routes: day === aday ? [oldRoute, otherRoute] : day === bday ? [usageRoute] : [],
      });
    }
    if (url.pathname === "/api/gateway/route") {
      const id = Number(url.searchParams.get("id"));
      if (id === oldRoute.id) return json(oldRoute);
      if (id === otherRoute.id) return json(otherRoute);
      if (id === usageRoute.id) return json(usageRoute);
      return request.fulfill({ status: 404, body: "not found" });
    }
    if (url.pathname === "/api/usage/requests") {
      const row = {
        route_id: usageRoute.id, t: usageRoute.time, agent: "codex", agentName: "Codex", icon: "codex-color",
        provider: "relay", providerName: "Relay", req: "luna", model: "model-opened", served: "model-opened",
        kind: usageRoute.kind, in: 1000, out: 100, ms: 420, status: 200, cost: 0.001, priced: true,
      };
      return json({
        period: url.searchParams.get("period"), rows: [row], offset: 0, total: 1, calls: 1, errors: 0,
        input: 1000, output: 100, cache_read: 0, cache_write: 0, reasoning: 0, cost: 0.001, unpriced: 0,
        agents: [{ id: "codex", name: "Codex", icon: "codex-color" }], callerKeys: [],
      });
    }
    if (url.pathname === "/api/usage") return json({
      calls: 1, errors: 0, input: 1000, output: 100, cache_read: 0, cache_write: 0, reasoning: 0,
      unpriced: 0, cost: 0.001, bucket: "day", series: [], agents: [], models: [],
      path: "~/.config/magpie/usage.jsonl",
    });
    if (url.pathname === "/api/usage/quotas" || url.pathname === "/api/sessions") return json([]);
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await request.fulfill({ body: await fs.readFile(file), contentType: type });
  };
}

async function click(page, target) {
  await target.waitFor({ state: "visible" });
  const view = await target.evaluate((e) => e.closest("#view-usage, #view-routing")?.id);
  if (view) {
    const box = await page.locator("#" + view).boundingBox();
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    for (let i = 0; i < 80; i++) {
      const b = await target.boundingBox();
      if (b.y >= box.y && b.y + b.height <= box.y + box.height) break;
      await page.mouse.wheel(0, b.y < box.y ? -120 : 120);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(250);
  }
  await target.click();
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  test(`${engine}: Routing returns to the view a Usage request replaced`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chromium" }));
    t.after(() => browser.close());
    for (const lang of Object.keys(words)) {
      for (const width of [1100, 560]) {
        await t.test(`${lang} ${width}px`, async () => {
          const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
          const errors = [];
          page.setDefaultTimeout(7000);
          page.on("pageerror", (e) => { if (!/^ResizeObserver loop completed with undelivered notifications/.test(e.message)) errors.push(e.message); });
          await page.route("**/*", serve(lang));
          await page.goto("http://magpie.test/?view=routing");

          const days = page.locator(".rt-days .rt-day");
          await days.nth(1).waitFor();
          await days.nth(1).click();
          await page.waitForFunction(() => document.querySelector(".rt-steps")?.textContent.includes("model-before"));

          const reviewName = await page.evaluate(() => purposeOptions(["kind:review"], "kind:review")[0].name);
          await click(page, page.locator("#rtPurpose"));
          await page.locator(".rt-purpose-menu").getByRole("menuitemcheckbox", { name: reviewName, exact: true }).click();
          const purposeLabel = await page.evaluate((name) => t("Purpose: {name}", { name }), reviewName);
          await page.locator("#rtPurpose span", { hasText: purposeLabel }).waitFor();
          await page.keyboard.press("Escape");

          const before = await page.locator('.rt-days .rt-day[aria-pressed="true"]').textContent();

          await page.locator('nav [data-view="usage"], [data-view="usage"]').first().click();
          await page.locator(":is(#usageTab .opt, .nav-s):visible").nth(1).click();
          await page.locator(".led tbody tr").first().waitFor();
          const routeLink = { en: "View routing", zh: "查看路由", "zh-TW": "檢視路由", ja: "ルーティングを表示", de: "Weiterleitung anzeigen" }[lang];
          await click(page, page.locator(".led tbody tr").first().getByTitle(routeLink));
          await page.locator("#view-routing").waitFor({ state: "visible" });
          await page.waitForFunction(() => document.querySelector(".rt-steps")?.textContent.includes("model-opened"));

          assert.notEqual(await page.locator(".rt-days .rt-day[aria-pressed=true]").textContent(), before);
          assert.equal(await page.locator("#rtPurpose span").textContent(), await page.evaluate(() => t("Purpose filter")));
          const previous = page.locator(".rt-log-head button", { hasText: words[lang] });
          assert.equal(await previous.count(), 1);

          await previous.click();
          await page.waitForFunction((day) => document.querySelector('.rt-days .rt-day[aria-pressed="true"]')?.textContent === day, before);
          await page.waitForFunction(() => document.querySelector(".rt-steps")?.textContent.includes("model-before"));
          assert.equal(await page.locator("#rtPurpose span").textContent(), purposeLabel);
          assert.equal(await page.locator(".rt-log-head button", { hasText: words[lang] }).count(), 0);
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          assert.deepEqual(errors, []);
          await page.close();
        });
      }
    }
  });
}

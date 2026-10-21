import { chromium } from "playwright";
const WEB = "http://localhost:5199", TOKEN = "gp2-fixed-token-123456", API = "http://127.0.0.1:4651";
const b = await chromium.launch();
const p = await b.newPage();
p.on("response", async r => {
  const u = r.url();
  if (u.includes("/api/runs") && (r.request().method() === "POST")) {
    console.log("POST", u.split("/api")[1], r.status(), (await r.text().catch(()=>"")).slice(0,150));
  }
});
p.on("pageerror", e => console.log("PAGE-ERR:", e.message.slice(0, 300)));
await p.goto(WEB, { waitUntil: "domcontentloaded" });
await p.fill("input[type=password]", TOKEN);
await p.keyboard.press("Enter");
await p.waitForSelector("nav a[href='/runs/new']", { timeout: 15000 });
await p.goto(`${WEB}/runs/new`, { waitUntil: "domcontentloaded" });
await p.waitForSelector("select >> nth=1 >> option[value='cpv.js']", { state: "attached", timeout: 20000 });
await p.selectOption("select >> nth=1", "cpv.js");
await p.click("button[type=submit]");
await p.waitForURL(/\/runs\/run-/);
await p.waitForSelector("text=允许继续吗", { timeout: 30000 });
console.log("PENDING-OK url=", p.url());
await p.click("button:has-text('拒绝…')");
await p.waitForTimeout(300);
console.log("PANEL:", (await p.locator(".checkpoint-panel").innerText().catch(() => "<gone>")).slice(0, 250).replace(/\n/g, " | "));
const clicked = await p.locator("button:has-text('确认拒绝')").count();
console.log("确认拒绝 buttons:", clicked);
await p.click("button:has-text('确认拒绝')");
for (const ms of [2000, 5000]) {
  await p.waitForTimeout(ms === 2000 ? 2000 : 3000);
  const chip = await p.locator(".status-chip").first().innerText().catch(() => "<none>");
  const panel = await p.locator(".checkpoint-panel").innerText().catch(() => "<gone>");
  console.log(`T+${ms} chip=${chip} panel=${panel.slice(0, 150).replace(/\n/g, " | ")}`);
}
const res = await fetch(`${API}/api/runs/${p.url().split("/").pop()}`, { headers: { authorization: `Bearer ${TOKEN}` } });
const d = await res.json() as any;
console.log("API status:", d.snapshot.status, "effective:", d.snapshot.effectiveStatus, "error:", d.snapshot.error);
await b.close();

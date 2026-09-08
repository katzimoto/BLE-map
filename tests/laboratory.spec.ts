import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { PNG } from "pngjs";
import { mkdirSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
async function ready(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Synthetic Beacon 001", exact: false }),
  ).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  await expect
    .poll(
      async () =>
        page.evaluate(() => window.__SYNTHETIC_LAB__?.active.length ?? 0),
      { timeout: 15000 },
    )
    .toBeGreaterThan(0);
}
function difference(a: Buffer, b?: Buffer) {
  const x = PNG.sync.read(a),
    y = b ? PNG.sync.read(b) : null;
  let count = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    const delta = y
      ? Math.abs(x.data[i] - y.data[i]) +
        Math.abs(x.data[i + 1] - y.data[i + 1]) +
        Math.abs(x.data[i + 2] - y.data[i + 2])
      : Math.abs(x.data[i] - 9) +
        Math.abs(x.data[i + 1] - 18) +
        Math.abs(x.data[i + 2] - 28);
    if (x.data[i + 3] > 0 && delta > 28) count++;
  }
  return count / (x.width * x.height);
}
test("default requests stay on the local application origin", async ({
  page,
}) => {
  const external: string[] = [];
  page.on("request", (r) => {
    if (
      !r.url().startsWith("http://localhost:4173/") &&
      !r.url().startsWith("data:") &&
      !r.url().startsWith("blob:")
    )
      external.push("unexpected request");
  });
  await ready(page);
  await page.getByLabel("Synthetic scenario").selectOption("clock-drift");
  await page
    .getByRole("button", { name: "Receiver layout", exact: true })
    .click();
  await page.getByRole("button", { name: "Play replay" }).click();
  await page.waitForTimeout(1000);
  expect(external).toEqual([]);
});
test("canvas contains signal evidence and changes during replay", async ({
  page,
}) => {
  await ready(page);
  await page.waitForTimeout(500);
  const before = await page.locator("canvas").screenshot();
  expect(difference(before)).toBeGreaterThan(0.05);
  await page.getByRole("button", { name: "Play replay" }).click();
  await page.waitForTimeout(5200);
  await page.getByRole("button", { name: "Pause replay" }).click();
  const after = await page.locator("canvas").screenshot();
  expect(difference(before, after)).toBeGreaterThan(0.001);
});
test("selection, filtering, timeline and keyboard stay linked", async ({
  page,
}) => {
  await ready(page);
  expect(
    await page
      .getByRole("group", { name: "Advertiser address table" })
      .getByRole("button")
      .count(),
  ).toBe(7);
  await page
    .getByRole("button", { name: "Synthetic Beacon 002", exact: false })
    .click();
  await expect(
    page.getByRole("heading", { name: "Synthetic Beacon 002" }),
  ).toBeVisible();
  expect(
    await page.getByTestId("signal-trace").getAttribute("points"),
  ).not.toBe("");
  await page.getByLabel("Filter synthetic addresses").fill("007");
  expect(
    await page
      .getByRole("group", { name: "Advertiser address table" })
      .getByRole("button")
      .count(),
  ).toBe(1);
  await page.getByLabel("Filter synthetic addresses").fill("");
  await page.getByLabel("Replay time in milliseconds").fill("30000");
  await expect(page.getByLabel("Replay time in milliseconds")).toHaveValue(
    "30000",
  );
  await page.locator("h1").click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Select an address" }),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Replay time in milliseconds")).toHaveValue(
    "31000",
  );
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("button", { name: "Pause replay" }),
  ).toBeVisible();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Play replay" }).focus();
  expect(
    await page
      .getByRole("button", { name: "Play replay" })
      .evaluate((e) => getComputedStyle(e).outlineWidth),
  ).toBe("3px");
});
test("geometry and calibration failures remain explicit", async ({ page }) => {
  await ready(page);
  await page.getByLabel("Synthetic scenario").selectOption("collinear");
  await page
    .getByRole("button", { name: "Receiver layout", exact: true })
    .click();
  await expect(
    page.getByText("Receiver geometry is degenerate: no fix."),
  ).toBeVisible();
  await page.getByLabel("Synthetic scenario").selectOption("weak-fit");
  await expect(
    page.getByText("Calibration slope unresolved: no fix."),
  ).toBeVisible();
});
test("exports, saves, reloads and validates synthetic restore", async ({
  page,
}) => {
  await ready(page);
  await page.getByLabel("Replay time in milliseconds").fill("22000");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export / back up" }).click();
  const file = await (await downloading).path();
  expect(file).not.toBeNull();
  const exported = JSON.parse(readFileSync(file!, "utf8"));
  expect(exported.synthetic).toBe(true);
  await page.getByRole("button", { name: "Save locally", exact: true }).click();
  await expect(
    page.getByText("Synthetic project saved in this browser."),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Replay time in milliseconds")).toHaveValue(
    "22000",
  );
  await page.getByLabel("Import synthetic project").setInputFiles({
    name: "synthetic-project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect(
    page.getByRole("region", { name: "Review synthetic restore" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back up current and restore" })
    .click();
  await expect(
    page.getByText(
      "Synthetic project restored. The previous view was exported as a backup.",
    ),
  ).toBeVisible();
  exported.fixture.events.rssi[0]++;
  await page.getByLabel("Import synthetic project").setInputFiles({
    name: "synthetic-project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect(page.getByRole("alert")).toContainText("Import rejected");
});
test("fallback retains useful views without WebGL", async ({ page }) => {
  await page.goto("/?fallback=1");
  await expect(
    page.getByRole("heading", { name: "Signal evidence remains available" }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Advertiser address table" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: "Packet histogram and selected synthetic RSSI trace",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Play replay" }).click();
  await expect
    .poll(async () =>
      Number(await page.getByLabel("Replay time in milliseconds").inputValue()),
    )
    .toBeGreaterThan(12000);
});
test("accessible, unclipped and reviewable at the target viewport", async ({
  page,
}, info) => {
  await ready(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    results.violations.map((v) => ({ id: v.id, count: v.nodes.length })),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const scene = await page.getByTestId("rf-scene").boundingBox(),
    timeline = await page
      .getByRole("region", { name: "Synthetic packet timeline" })
      .boundingBox();
  expect(scene).not.toBeNull();
  expect(timeline!.y).toBeGreaterThan(scene!.y + scene!.height);
  mkdirSync("review-output/screenshots", { recursive: true });
  await page.screenshot({
    path: `review-output/screenshots/${info.project.name}.png`,
    fullPage: true,
  });
});

test("rendered instances map to the linked address table", async ({ page }) => {
  await ready(page);
  await page.getByLabel("Replay time in milliseconds").fill("30000");
  await expect
    .poll(async () => page.evaluate(() => window.__SYNTHETIC_LAB__?.time))
    .toBe(30000);
  const view = await page.evaluate(() => window.__SYNTHETIC_LAB__!);
  expect(view.active.length).toBeGreaterThan(2);
  for (const id of view.active) expect(id).toBeLessThan(7);
  const target = view.screen.find((p) => p.id === 1)!;
  await page
    .locator("canvas")
    .click({ position: { x: target.x + 7, y: target.y } });
  await expect(
    page.getByRole("heading", { name: "Synthetic Beacon 002" }),
  ).toBeVisible();
  await page.getByLabel("Filter synthetic addresses").fill("002");
  await expect
    .poll(async () =>
      page.evaluate(() => window.__SYNTHETIC_LAB__?.active.length),
    )
    .toBe(1);
});

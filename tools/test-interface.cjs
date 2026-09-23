const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(process.env.STUDIO_URL || 'http://127.0.0.1:4173');
    assert.equal(await page.locator('#downloadAudio').count(), 0);
    const fixture = fs.readdirSync('.qa').filter((n) => n.startsWith('media-')).sort().at(-1);
    await page.locator('#file').setInputFiles(path.resolve('.qa', fixture, 'video.webm'));
    await page.locator('#extract:not([disabled])').waitFor();
    assert.match(await page.locator('#extract').textContent(), /Распознать/);
    await page.locator('#extract').click();
    await page.locator('#editor:not([hidden])').waitFor({ timeout: 120_000 });
    const text = await page.locator('#transcript').inputValue();
    assert.ok(text.trim().length > 0, 'transcript should be filled');
    assert.match(text, /фрагмент|Будущее| /);
    await page.screenshot({ path: '.qa/studio-desktop.png', fullPage: true });
    await page.locator('nav [data-view="studio"]').click();
    await page.locator('#file').setInputFiles(path.resolve('.qa', fixture, 'silent.mp4'));
    await page.locator('#extract').click();
    await page.locator('#mediaStatus[data-state="error"]').waitFor({ timeout: 60_000 });
    assert.match(await page.locator('#mediaStatus').textContent(), /нет аудиодорожки/);
    await page.locator('nav [data-view="wallet"]').click();
    await page.locator('#minutes').fill('1');
    await page.locator('#seconds').fill('1');
    assert.match(await page.locator('#calc').textContent(), /0,07/);
    await page.locator('nav [data-view="studio"]').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.qa/studio-mobile.png', fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
    console.log('PASS browser longform job, no WAV download, missing audio error, calculator, mobile overflow, no JS errors');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

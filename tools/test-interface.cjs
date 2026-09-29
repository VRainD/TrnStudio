const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const base = process.env.STUDIO_URL || 'http://127.0.0.1:4173';
    await page.goto(base);

    // Auth gate must be visible for anonymous users
    await page.locator('#authGate:not([hidden])').waitFor({ timeout: 10_000 });
    assert.ok(await page.locator('#authTitle').textContent());

    const email = `qa_${Date.now()}@example.com`;
    const password = 'SecurePassw0rd!';
    await page.locator('#tabRegister').click();
    await page.locator('#authName').fill('Тестер');
    await page.locator('#authEmail').fill(email);
    await page.locator('#authPassword').fill(password);
    await page.locator('#authSubmit').click();
    await page.locator('#authGate').waitFor({ state: 'hidden', timeout: 15_000 });
    await page.locator('.shell[data-authed="1"]').waitFor({ timeout: 5_000 });
    assert.match(await page.locator('#profileName').textContent(), /Тестер/);

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

    // Cabinet lists the real job (not fake demo rows)
    await page.locator('nav [data-view="records"]').click();
    await page.waitForTimeout(800);
    const recordsText = await page.locator('#allRecords').innerText();
    assert.ok(!/Интервью о будущем/.test(recordsText) || /Готово|В работе/.test(recordsText));
    assert.match(recordsText, /Готово|Запись|webm|МБ|ток/i);

    await page.screenshot({ path: '.qa/studio-desktop.png', fullPage: true });
    await page.locator('nav [data-view="studio"]').click();
    await page.locator('#file').setInputFiles(path.resolve('.qa', fixture, 'silent.mp4'));
    await page.locator('#extract').click();
    await page.locator('#mediaStatus[data-state="error"]').waitFor({ timeout: 60_000 });
    assert.match(await page.locator('#mediaStatus').textContent(), /нет аудиодорожки/);
    await page.locator('nav [data-view="wallet"]').click();
    await page.locator('#walletAvailable').waitFor();
    assert.match(await page.locator('#walletAvailable').textContent(), /ток/);
    assert.match(await page.locator('#wallet h2').first().textContent(), /токен/i);
    await page.locator('#minutes').fill('1');
    await page.locator('#seconds').fill('1');
    await page.waitForFunction(() => /0,07/.test(document.getElementById('calc').textContent), null, { timeout: 10_000 });
    assert.match(await page.locator('#calc').textContent(), /0,07.*ток/);
    assert.equal(await page.locator('#promoCode').count(), 1);
    await page.locator('nav [data-view="studio"]').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.qa/studio-mobile.png', fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
    console.log('PASS browser auth gate, register, longform job, cabinet, wallet, mobile');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

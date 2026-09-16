const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(process.env.STUDIO_URL || 'http://127.0.0.1:4173');
    const fixture = fs.readdirSync('.qa').filter(n=>n.startsWith('media-')).sort().at(-1);
    await page.locator('#file').setInputFiles(path.resolve('.qa',fixture,'video.webm'));
    await page.locator('#extract:not([disabled])').waitFor();
    await page.locator('#extract').click();
    await page.locator('#mediaStatus[data-state="success"]').waitFor();
    assert.equal(await page.locator('#downloadAudio').isVisible(),true);
    await page.locator('#resultPlayer').evaluate(audio=>new Promise(resolve=>{if(audio.readyState>=1)resolve();else audio.addEventListener('loadedmetadata',resolve,{once:true})}));
    assert.ok(await page.locator('#resultPlayer').evaluate(audio=>audio.duration>1.9));
    await page.screenshot({path:'.qa/studio-desktop.png',fullPage:true});
    await page.locator('#file').setInputFiles(path.resolve('.qa',fixture,'silent.mp4'));
    await page.locator('#extract').click();
    await page.locator('#mediaStatus[data-state="error"]').waitFor();
    assert.match(await page.locator('#mediaStatus').textContent(),/нет аудиодорожки/);
    await page.locator('nav [data-view="wallet"]').click();
    await page.locator('#minutes').fill('1');await page.locator('#seconds').fill('1');
    assert.match(await page.locator('#calc').textContent(),/0,07/);
    await page.locator('nav [data-view="studio"]').click();
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'.qa/studio-mobile.png',fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    assert.deepEqual(errors,[]);
    console.log('PASS browser extraction, WAV playback, missing audio error, calculator, mobile overflow, no JS errors');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { quoteCost, costSnapshotFromSeconds, formatRub, formatTokens, rubToTokenMinor, kopecksToTokenDisplay } from './billing/cost.mjs';
import { creditWallet, getWalletView, reserveForJob, captureHoldForJob, releaseHoldForJob } from './billing/wallet.mjs';
import { createPromo, redeemPromo, validatePromo } from './billing/promos.mjs';
import {
  createPaymentProvider, paymentStatusPublic, createTopupPayment, reconcilePaymentWebhook,
  PREFERRED_PAYMENT_DRIVER,
} from './billing/payments.mjs';

// --- Phase A: SPEC §5 examples ---
{
  const oneSec = quoteCost({ durationSeconds: 1 });
  assert.equal(oneSec.costKopecks, 1, '1s → 0,01 ₽');
  assert.equal(formatRub(oneSec.costKopecks), '0,01 ₽');
  assert.equal(formatTokens(oneSec.costKopecks), '0,01 ток.');

  const sixtyOne = quoteCost({ durationSeconds: 61 });
  assert.equal(sixtyOne.costKopecks, 7, '61s → 0,07 ₽');

  const long = quoteCost({ durationSeconds: 17 * 60 + 42 });
  assert.equal(long.costKopecks, 107, '17:42 → 1,07 ₽');

  const hour = quoteCost({ durationSeconds: 60 * 60 });
  assert.equal(hour.costKopecks, 360, '60 min → 3,60 ₽');

  // Integer samples path: 16000 samples = 1s
  assert.equal(quoteCost({ durationSamples: 16_000 }).costKopecks, 1);
  assert.equal(costSnapshotFromSeconds(61).cost_kopecks, 7);

  // Token unit: 1 token = 1 ₽ = 100 minor
  assert.equal(rubToTokenMinor(100), 10_000);
  assert.equal(kopecksToTokenDisplay(10_000), 100);
  assert.equal(rubToTokenMinor(1), 100);
  console.log('PASS cost formula SPEC examples + token unit');
}

// Isolated billing root for wallet/promo tests
const prevRoot = process.env.BILLING_ROOT;
const prevBilling = process.env.BILLING_ENABLED;
const root = await mkdtemp(join(tmpdir(), 'gorizont-billing-'));
process.env.BILLING_ROOT = root;
process.env.BILLING_ENABLED = 'true';

try {
  const before = await getWalletView();
  assert.equal(before.availableKopecks, 0);

  const credited = await creditWallet({
    amountKopecks: 10_000,
    reason: 'qa seed',
    businessKey: 'qa:seed:10000',
  });
  assert.equal(credited.balanceKopecks, 10_000);
  const again = await creditWallet({
    amountKopecks: 10_000,
    reason: 'qa seed',
    businessKey: 'qa:seed:10000',
  });
  assert.equal(again.idempotent, true);
  assert.equal(again.balanceKopecks, 10_000);

  const jobId = '11111111-1111-4111-8111-111111111111';
  // 17:42 → 107 kopecks
  const reserved = await reserveForJob({
    jobId,
    durationSeconds: 17 * 60 + 42,
    idempotencyKey: `hold:job:${jobId}`,
  });
  assert.equal(reserved.costSnapshot.cost_kopecks, 107);
  assert.equal(reserved.hold.status, 'active');
  const mid = await getWalletView();
  assert.equal(mid.availableKopecks, 10_000 - 107);
  assert.equal(mid.heldKopecks, 107);

  // Insufficient funds: quote larger than available (9893 after 107 hold)
  let blocked = false;
  try {
    await reserveForJob({
      jobId: '22222222-2222-4222-8222-222222222222',
      durationSeconds: 200_000, // ~200k sec → ~20_000 kop >> available
    });
  } catch (e) {
    blocked = e.code === 'INSUFFICIENT_FUNDS';
  }
  assert.equal(blocked, true);

  await captureHoldForJob({ jobId });
  const afterCapture = await getWalletView();
  assert.equal(afterCapture.heldKopecks, 0);
  assert.equal(afterCapture.balanceKopecks, 10_000 - 107);
  assert.equal(afterCapture.availableKopecks, 10_000 - 107);

  // Release path
  process.env.BILLING_ENABLED = 'true';
  await creditWallet({ amountKopecks: 200, reason: 'for release test', businessKey: 'qa:rel:200' });
  const jobFail = '33333333-3333-4333-8333-333333333333';
  await reserveForJob({ jobId: jobFail, durationSeconds: 61 });
  await releaseHoldForJob({ jobId: jobFail });
  const released = await releaseHoldForJob({ jobId: jobFail });
  assert.equal(released.status, 'already_released');
  console.log('PASS wallet holds credit debit');

  // Promos
  const promo = await createPromo({
    code: 'bonus50',
    effectType: 'bonus_credit',
    bonusKopecks: 5000,
  });
  assert.equal(promo.normalizedCode, 'BONUS50');
  const preview = await validatePromo({ code: '  bonus50 ' });
  assert.equal(preview.bonusKopecks, 5000);
  const redeemed = await redeemPromo({ code: 'BONUS50', businessKey: 'qa:promo:BONUS50' });
  assert.equal(redeemed.bonusKopecks, 5000);
  const redeemAgain = await redeemPromo({ code: 'BONUS50', businessKey: 'qa:promo:BONUS50' });
  assert.equal(redeemAgain.idempotent, true);
  let secondUserBlock = false;
  try {
    // same user, different key but per-user max=1
    await redeemPromo({ code: 'BONUS50', businessKey: 'qa:promo:BONUS50:2' });
  } catch (e) {
    secondUserBlock = e.code === 'PROMO_UNAVAILABLE';
  }
  assert.equal(secondUserBlock, true);
  console.log('PASS promo redeem idempotent');

  // Payments stub + 1:1 token credit on webhook success
  process.env.PAYMENT_DRIVER = 'stub';
  const provider = createPaymentProvider();
  assert.ok(provider.name === 'stub' || provider.name.includes('stub'));
  const topup = await createTopupPayment({ amountRub: 300, idempotenceKey: 'qa:pay:300' });
  assert.equal(topup.payment.amountKopecks, 30_000);
  assert.equal(topup.creditTokensOnSuccess, 300);
  assert.equal(topup.payment.status, 'pending');
  const status = paymentStatusPublic();
  assert.equal(status.driver, 'stub');
  assert.equal(status.preferredDriver, PREFERRED_PAYMENT_DRIVER);
  assert.equal(status.preferredDriver, 'yoomoney');
  assert.equal(status.creditRule, '1_token_per_rub');
  assert.equal(status.configured, false);

  const beforePay = await getWalletView();
  const creditedPay = await reconcilePaymentWebhook({
    provider: topup.payment.provider,
    providerPaymentId: topup.payment.providerPaymentId,
    status: 'succeeded',
  });
  assert.equal(creditedPay.credited, true);
  assert.equal(creditedPay.creditTokens, 300);
  const afterPay = await getWalletView();
  assert.equal(afterPay.balanceKopecks, beforePay.balanceKopecks + 30_000);
  assert.equal(afterPay.balanceTokens, beforePay.balanceTokens + 300);

  const againPay = await reconcilePaymentWebhook({
    provider: topup.payment.provider,
    providerPaymentId: topup.payment.providerPaymentId,
    status: 'succeeded',
  });
  assert.equal(againPay.credited, false);
  assert.ok(againPay.reason === 'already_succeeded' || againPay.reason === 'already_credited');
  console.log('PASS payment stub + token credit 1:1');
} finally {
  if (prevRoot === undefined) delete process.env.BILLING_ROOT;
  else process.env.BILLING_ROOT = prevRoot;
  if (prevBilling === undefined) delete process.env.BILLING_ENABLED;
  else process.env.BILLING_ENABLED = prevBilling;
  delete process.env.PAYMENT_DRIVER;
  await rm(root, { recursive: true, force: true });
}

console.log('PASS tools/test-billing.mjs');

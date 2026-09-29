#!/usr/bin/env node
/**
 * Admin CLI: credit wallet / manage promos for local Горизонт billing.
 *
 * Usage:
 *   node tools/billing/admin-cli.mjs credit --amount-rub 100 --reason "тест"
 *   node tools/billing/admin-cli.mjs credit --amount-kopecks 10000 --reason "manual"
 *   node tools/billing/admin-cli.mjs wallet
 *   node tools/billing/admin-cli.mjs promo-create --code WELCOME50 --type bonus_credit --bonus-kopecks 5000
 *   node tools/billing/admin-cli.mjs promo-list
 *   node tools/billing/admin-cli.mjs promo-status --id <uuid> --status paused
 */
import { creditWallet, getWalletView, listTransactions } from './wallet.mjs';
import { createPromo, listPromos, setPromoStatus } from './promos.mjs';
import { demoUserId } from './store.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

const cmd = process.argv[2];

async function main() {
  if (!cmd || cmd === 'help' || flag('help')) {
    console.log(`Горизонт billing admin

  credit --amount-rub N|--amount-kopecks N --reason TEXT [--business-key K]
  wallet
  transactions
  promo-create --code CODE --type bonus_credit|bonus_minutes|percent_off|fixed_off|welcome
               [--bonus-kopecks N] [--bonus-minutes N] [--percent N] [--fixed-kopecks N]
  promo-list
  promo-status --id UUID --status draft|active|paused|expired|revoked
`);
    process.exit(0);
  }

  if (cmd === 'wallet') {
    console.log(JSON.stringify(await getWalletView(demoUserId()), null, 2));
    return;
  }
  if (cmd === 'transactions') {
    console.log(JSON.stringify(await listTransactions(demoUserId()), null, 2));
    return;
  }
  if (cmd === 'credit') {
    const rub = arg('amount-rub');
    const kop = arg('amount-kopecks');
    const reason = arg('reason');
    if (!reason) throw new Error('--reason required');
    let amountKopecks;
    if (kop != null) amountKopecks = Number(kop);
    else if (rub != null) amountKopecks = Math.round(Number(rub) * 100);
    else throw new Error('--amount-rub or --amount-kopecks required');
    const result = await creditWallet({
      amountKopecks,
      reason,
      businessKey: arg('business-key') || undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (cmd === 'promo-create') {
    const code = arg('code');
    const effectType = arg('type');
    if (!code || !effectType) throw new Error('--code and --type required');
    const promo = await createPromo({
      code,
      effectType,
      bonusKopecks: arg('bonus-kopecks') != null ? Number(arg('bonus-kopecks')) : null,
      bonusMinutes: arg('bonus-minutes') != null ? Number(arg('bonus-minutes')) : null,
      percentOff: arg('percent') != null ? Number(arg('percent')) : null,
      fixedOffKopecks: arg('fixed-kopecks') != null ? Number(arg('fixed-kopecks')) : null,
      status: arg('status') || 'active',
    });
    console.log(JSON.stringify(promo, null, 2));
    return;
  }
  if (cmd === 'promo-list') {
    console.log(JSON.stringify(await listPromos(), null, 2));
    return;
  }
  if (cmd === 'promo-status') {
    const id = arg('id');
    const status = arg('status');
    if (!id || !status) throw new Error('--id and --status required');
    console.log(JSON.stringify(await setPromoStatus({ promoId: id, status }), null, 2));
    return;
  }
  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

import { expect, test, type Page } from '@playwright/test';
import { LEDGER_STORAGE_KEY } from '../../src/lib/ledgerStorage';

/**
 * 容量预留的双标签页端到端验收：
 * - 两页同时占容量：先占者成功，后者冲突提示并先展示最新台账，按最新可用量重试；
 * - 一页结算 / 取消时，另一页通过 storage 事件自动同步记录、预留集合与可用量；
 * - 重复终结：另一页已结算后，迟到页面刷新再结算被拒、不会二次入账；
 * - 写入失败时结算不留「已结算却无记录」的半状态，刷新后预留仍在；
 * - 旧版存档（无 reservations）在双页下按空集合读入。
 */

const BATCH_ID = 'seed-batch';

async function seedLedger(page: Page, capacity: number, revision = 1): Promise<void> {
  const payload = {
    batches: [
      { id: BATCH_ID, name: '跨页预留批次', capacity, createdAt: new Date(Date.UTC(2026, 9, 1, 8)).toISOString() },
    ],
    records: [],
    reservations: [],
    revision,
  };
  await page.addInitScript(
    ([key, value]) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    [LEDGER_STORAGE_KEY, JSON.stringify(payload)] as const,
  );
}

async function gotoLedger(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('nav-ledger').click();
  await page.getByTestId('batch-item').click();
}

async function readRawLedger(page: Page) {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw
      ? (JSON.parse(raw) as {
          revision: number;
          records: Array<{ films: number; note?: string }>;
          reservations: Array<{ amount: number; note?: string }>;
        })
      : null;
  }, LEDGER_STORAGE_KEY);
}

/** 确定性屏蔽 storage 事件（见 cross-tab-ledger.spec.ts 同名助手的说明）。 */
async function blockStorageSync(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const w = window as Window & { __blockLedgerEvents?: boolean };
    w.__blockLedgerEvents = true;
    window.addEventListener(
      'storage',
      (event) => {
        if (w.__blockLedgerEvents && event.key === key) event.stopImmediatePropagation();
      },
      true,
    );
  }, LEDGER_STORAGE_KEY);
}

async function unblockStorageSync(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __blockLedgerEvents?: boolean }).__blockLedgerEvents = false;
  });
}

async function makeLedgerWritesFail(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const proto = Object.getPrototypeOf(window.localStorage);
    if (!(proto as { __failLedger?: boolean }).__failLedger) {
      const original = proto.setItem;
      proto.setItem = function patchedSetItem(this: Storage, k: string, value: string) {
        if (k === key) throw new Error('QuotaExceededError: simulated quota');
        return original.call(this, k, value);
      };
      (proto as { __failLedger?: boolean }).__failLedger = true;
    }
  }, LEDGER_STORAGE_KEY);
}

test.describe('预留 / 结算 / 取消的双标签页交错', () => {
  test('两页同时预留：先占者成功；后者冲突后先看到最新台账，再按最新可用量重试', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    await seedLedger(pageA, 10);
    const pageB = await context.newPage();
    await blockStorageSync(pageB);
    await gotoLedger(pageA);
    await gotoLedger(pageB);

    // 两页都看到可用 10
    await expect(pageA.getByTestId('detail-remaining')).toHaveText('10');
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('10');

    // A 先预留 6
    await pageA.getByTestId('reserve-amount-input').fill('6');
    await pageA.getByTestId('reserve-note-input').fill('A 页先占');
    await pageA.getByTestId('reserve-button').click();
    await expect(pageA.getByTestId('reservation-item')).toHaveCount(1);
    await expect(pageA.getByTestId('detail-remaining')).toHaveText('4');

    // B 持旧台账也预留 6 → 修订号冲突：顶部提示，页面先对齐到最新台账（A 的预留可见）
    await pageB.getByTestId('reserve-amount-input').fill('6');
    await pageB.getByTestId('reserve-button').click();
    await expect(pageB.getByTestId('ledger-error')).toContainText('其他页面');
    await expect(pageB.getByTestId('reservation-item')).toHaveCount(1);
    await expect(pageB.getByTestId('reservation-note')).toContainText('A 页先占');
    await expect(pageB.getByTestId('detail-reserved')).toHaveText('6');
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('4');
    // 冲突后表单草稿保留，操作员可改数重试
    await expect(pageB.getByTestId('reserve-amount-input')).toHaveValue('6');

    // 原始存储：只有 A 一笔预留
    const rawAfterConflict = await readRawLedger(pageA);
    expect(rawAfterConflict?.revision).toBe(2);
    expect(rawAfterConflict?.reservations).toHaveLength(1);
    expect(rawAfterConflict?.reservations[0].amount).toBe(6);

    // B 按最新可用量改预留 4：成功，容量被两页占满（可用 0，已用 0）
    await pageB.getByTestId('reserve-amount-input').fill('4');
    await pageB.getByTestId('reserve-button').click();
    await expect(pageB.getByTestId('ledger-error')).toHaveCount(0);
    await expect(pageB.getByTestId('reservation-item')).toHaveCount(2);
    await expect(pageB.getByTestId('detail-reserved')).toHaveText('10');
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('0');
    await expect(pageB.getByTestId('detail-used')).toHaveText('0');
    await expect(pageB.getByTestId('detail-status')).toHaveText('使用中');
    await unblockStorageSync(pageB);

    // A 自动同步到两笔预留
    await expect(pageA.getByTestId('reservation-item')).toHaveCount(2);
    await expect(pageA.getByTestId('detail-reserved')).toHaveText('10');

    // 刷新两页：预留集合、顺序、可用量完全一致
    for (const page of [pageA, pageB]) {
      await page.reload();
      await gotoLedger(page);
      await expect(page.getByTestId('reservation-item')).toHaveCount(2);
      await expect(page.getByTestId('detail-reserved')).toHaveText('10');
      await expect(page.getByTestId('detail-remaining')).toHaveText('0');
      const amounts = await page.getByTestId('reservation-amount').allInnerTexts();
      expect(amounts).toEqual(['6', '4']);
    }
    const finalRaw = await readRawLedger(pageA);
    expect(finalRaw?.records).toEqual([]);
    expect(finalRaw?.reservations.map((r) => r.amount)).toEqual([6, 4]);
    expect(finalRaw?.revision).toBe(3);
    await context.close();
  });

  test('一页结算 / 取消时另一页自动同步：记录出现、预留消失、可用量恢复；直接登记受预留保护', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    await seedLedger(pageA, 10);
    await gotoLedger(pageA);
    const pageB = await context.newPage();
    await gotoLedger(pageB);

    // A 预留 6
    await pageA.getByTestId('reserve-amount-input').fill('6');
    await pageA.getByTestId('reserve-button').click();
    // B 自动同步：可用 4
    await expect(pageB.getByTestId('detail-reserved')).toHaveText('6');
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('4');
    await expect(pageB.getByTestId('reservation-item')).toHaveCount(1);

    // B 想把被占住的容量直接登记：只能用可用 4，登记 5 被领域拒绝
    await pageB.getByTestId('films-input').fill('5');
    await pageB.getByTestId('record-usage-button').click();
    await expect(pageB.getByTestId('error-films')).toContainText('本批当前可用 4');
    await expect(pageB.getByTestId('usage-item')).toHaveCount(0);
    // 登记 4（全部可用）成功
    await pageB.getByTestId('films-input').fill('4');
    await pageB.getByTestId('record-usage-button').click();
    await expect(pageB.getByTestId('detail-used')).toHaveText('4');
    // A 同步到已用 4、可用 0
    await expect(pageA.getByTestId('detail-used')).toHaveText('4');
    await expect(pageA.getByTestId('detail-remaining')).toHaveText('0');

    // A 部分结算预留：实际 2（未用 4 释放）
    await pageA.getByTestId('settle-input').fill('2');
    await pageA.getByTestId('settle-button').click();
    // B 自动同步：记录两条（4 直接登记、2 结算），预留清空，可用 = 10 − 6 = 4
    await expect(pageB.getByTestId('reservation-item')).toHaveCount(0);
    await expect(pageB.getByTestId('usage-item')).toHaveCount(2);
    await expect(pageB.getByTestId('detail-used')).toHaveText('6');
    await expect(pageB.getByTestId('detail-reserved')).toHaveText('0');
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('4');

    // A 再预留 3 后取消：B 同步看到预留短暂占住又释放，最终仍无预留、无新记录
    await pageA.getByTestId('reserve-amount-input').fill('3');
    await pageA.getByTestId('reserve-button').click();
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('1');
    await pageA.getByTestId('cancel-reservation-button').click();
    await expect(pageB.getByTestId('reservation-item')).toHaveCount(0);
    await expect(pageB.getByTestId('detail-reserved')).toHaveText('0');
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('4');
    await expect(pageB.getByTestId('usage-item')).toHaveCount(2);

    const raw = await readRawLedger(pageA);
    expect(raw?.records.map((r) => r.films)).toEqual([4, 2]);
    expect(raw?.reservations).toEqual([]);
    await context.close();
  });

  test('重复终结：一页已结算后，另一页迟到的结算在刷新后仍被拒绝，不会二次入账', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    await seedLedger(pageA, 10);
    await gotoLedger(pageA);
    const pageB = await context.newPage();
    await blockStorageSync(pageB);
    await gotoLedger(pageB);

    // A 预留 5（B 屏蔽通知，保持旧视图）
    await pageA.getByTestId('reserve-amount-input').fill('5');
    await pageA.getByTestId('reserve-button').click();
    await expect(pageA.getByTestId('reservation-item')).toHaveCount(1);
    // B 视图里没有这笔预留（模拟在 B 不知情的世界线；下方先刷新对齐）
    await pageB.reload();
    await unblockStorageSync(pageB);
    await gotoLedger(pageB);
    await expect(pageB.getByTestId('reservation-item')).toHaveCount(1);

    // 两页都看到预留后，再屏蔽 B，制造「同时结算」
    await blockStorageSync(pageB);
    await pageB.reload();
    await gotoLedger(pageB);
    await expect(pageB.getByTestId('reservation-item')).toHaveCount(1);

    // A 全额结算 5
    await pageA.getByTestId('settle-input').fill('5');
    await pageA.getByTestId('settle-button').click();
    await expect(pageA.getByTestId('usage-item')).toHaveCount(1);
    await expect(pageA.getByTestId('reservation-item')).toHaveCount(0);

    // B 也点结算 5 → 冲突（修订号旧），先展示最新台账：预留已消失、A 的记录可见
    await pageB.getByTestId('settle-input').fill('5');
    await pageB.getByTestId('settle-button').click();
    await expect(pageB.getByTestId('ledger-error')).toContainText('其他页面');
    await expect(pageB.getByTestId('reservation-item')).toHaveCount(0);
    await expect(pageB.getByTestId('usage-item')).toHaveCount(1);
    await expect(pageB.getByTestId('usage-films')).toHaveText('5');

    // B 刷新后不会出现幽灵结算行；确认只有 A 的一条记录、容量未被二次扣减
    await pageB.reload();
    await gotoLedger(pageB);
    await expect(pageB.getByTestId('usage-item')).toHaveCount(1);
    await expect(pageB.getByTestId('detail-used')).toHaveText('5');
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('5');
    await expect(pageB.getByTestId('reservation-empty')).toBeVisible();

    // 此时再想重复结算已无入口（预留终结）；直接登记 5 可成功用掉剩余容量
    await pageB.getByTestId('films-input').fill('5');
    await pageB.getByTestId('record-usage-button').click();
    await expect(pageB.getByTestId('detail-status')).toHaveText('已耗尽');
    const raw = await readRawLedger(pageA);
    expect(raw?.records.map((r) => r.films)).toEqual([5, 5]);
    expect(raw?.reservations).toEqual([]);
    await context.close();
  });

  test('写入失败：结算被拒后不留下已结算却无记录的半状态，另一页与刷新后都只见预留', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    await seedLedger(pageA, 10);
    await gotoLedger(pageA);
    const pageB = await context.newPage();
    await gotoLedger(pageB);

    // A 预留 4，B 自动同步
    await pageA.getByTestId('reserve-amount-input').fill('4');
    await pageA.getByTestId('reserve-button').click();
    await expect(pageB.getByTestId('reservation-item')).toHaveCount(1);
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('6');

    // A 的存储开始拒写后尝试结算 3
    await makeLedgerWritesFail(pageA);
    await pageA.getByTestId('settle-input').fill('3');
    await pageA.getByTestId('settle-button').click();
    await expect(pageA.getByTestId('ledger-error')).toContainText(/保存失败|存储/);
    // 未伪装成功：预留仍在、记录未出现、可用量不变
    await expect(pageA.getByTestId('reservation-item')).toHaveCount(1);
    await expect(pageA.getByTestId('usage-item')).toHaveCount(0);
    await expect(pageA.getByTestId('detail-reserved')).toHaveText('4');
    await expect(pageA.getByTestId('detail-remaining')).toHaveText('6');

    // 原始存储核对：仍是预留、无记录、修订号未因失败推进
    const rawAfterFail = await readRawLedger(pageB);
    expect(rawAfterFail?.reservations).toHaveLength(1);
    expect(rawAfterFail?.records).toEqual([]);

    // A 刷新（存储写入补丁不跨刷新的页面上下文持久化于新文档之外的实现细节无关：
    // 这里直接用新页面验证存储真相）：预留仍可结算
    const pageC = await context.newPage();
    await gotoLedger(pageC);
    await expect(pageC.getByTestId('reservation-item')).toHaveCount(1);
    await pageC.getByTestId('settle-input').fill('3');
    await pageC.getByTestId('settle-button').click();
    await expect(pageC.getByTestId('usage-item')).toHaveCount(1);
    await expect(pageC.getByTestId('usage-films')).toHaveText('3');
    await expect(pageC.getByTestId('reservation-item')).toHaveCount(0);
    await expect(pageC.getByTestId('detail-remaining')).toHaveText('7');

    // B 自动同步到结算结果
    await expect(pageB.getByTestId('usage-item')).toHaveCount(1);
    await expect(pageB.getByTestId('reservation-item')).toHaveCount(0);
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('7');
    await context.close();
  });

  test('旧版存档（无 reservations）在双标签页下按空集合读入，首次预留提交受修订号保护', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    await pageA.addInitScript(
    ([key, value]) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    [
      LEDGER_STORAGE_KEY,
      JSON.stringify({
        batches: [
          { id: BATCH_ID, name: '旧版批次', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' },
        ],
        records: [
          { id: 'r0', batchId: BATCH_ID, films: 2, note: '旧记录', remainingAfter: 8, createdAt: 't' },
        ],
      }),
    ] as const,
    );
    const pageB = await context.newPage();
    await blockStorageSync(pageB);
    await gotoLedger(pageA);
    await gotoLedger(pageB);

    // 两页都按空预留集合读入：已用 2、预留 0、可用 8
    for (const page of [pageA, pageB]) {
      await expect(page.getByTestId('batch-used')).toHaveText('2');
      await expect(page.getByTestId('batch-reserved')).toHaveText('0');
      await expect(page.getByTestId('batch-remaining')).toHaveText('8');
      await expect(page.getByTestId('reservation-empty')).toBeVisible();
    }

    // A 首次提交（预留 5）：旧格式升级 revision 1
    await pageA.getByTestId('reserve-amount-input').fill('5');
    await pageA.getByTestId('reserve-button').click();
    await expect(pageA.getByTestId('reservation-item')).toHaveCount(1);
    await expect(pageA.getByTestId('detail-remaining')).toHaveText('3');

    // B 用旧基准（revision 0）预留 3：冲突被拒，先展示含 A 预留的最新台账
    await pageB.getByTestId('reserve-amount-input').fill('3');
    await pageB.getByTestId('reserve-button').click();
    await expect(pageB.getByTestId('ledger-error')).toContainText('其他页面');
    await expect(pageB.getByTestId('reservation-item')).toHaveCount(1);
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('3');

    // B 刷新后重试预留 3：成功；旧记录始终保留
    await pageB.reload();
    await unblockStorageSync(pageB);
    await gotoLedger(pageB);
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('3');
    await pageB.getByTestId('reserve-amount-input').fill('3');
    await pageB.getByTestId('reserve-button').click();
    await expect(pageB.getByTestId('reservation-item')).toHaveCount(2);
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('0');
    await expect(pageB.getByTestId('usage-item')).toHaveCount(1);
    const raw = await readRawLedger(pageA);
    expect(raw?.records.map((r) => r.films)).toEqual([2]);
    expect(raw?.reservations.map((r) => r.amount)).toEqual([5, 3]);
    expect(raw?.revision).toBe(2);
    await context.close();
  });
});

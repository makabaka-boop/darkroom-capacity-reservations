import { expect, test, type Page } from '@playwright/test';
import { LEDGER_STORAGE_KEY } from '../../src/lib/ledgerStorage';

/**
 * 容量预留端到端验收（单标签页）：
 * 预留占容量 → 直接登记按扣除预留后的可用量裁决 → 结算（全额 / 部分）原子入账并释放未用部分
 * → 取消只释放不留记录 → 刷新恢复有效预留 → 旧版存档（无 reservations 字段）按空集合恢复。
 */

async function gotoLedger(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('nav-ledger').click();
}

/** 创建并选中一个额定容量的批次。 */
async function createBatch(page: Page, name: string, capacity: string): Promise<void> {
  await page.getByTestId('batch-name-input').fill(name);
  await page.getByTestId('batch-capacity-input').fill(capacity);
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('batch-item')).toHaveCount(1);
}

async function readRawLedger(page: Page) {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw
      ? (JSON.parse(raw) as {
          revision: number;
          records: Array<{ films: number }>;
          reservations: Array<{ amount: number; note?: string }>;
        })
      : null;
  }, LEDGER_STORAGE_KEY);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('预留占住容量：列表与详情同时显示已用 / 预留 / 可用，直接登记不得超过可用量', async ({ page }) => {
  await page.getByTestId('nav-ledger').click();
  await createBatch(page, 'D-76 显影液', '10');

  // 初始：已用 0、预留 0、可用 10、账面剩余 10
  await expect(page.getByTestId('batch-used')).toHaveText('0');
  await expect(page.getByTestId('batch-reserved')).toHaveText('0');
  await expect(page.getByTestId('batch-remaining')).toHaveText('10');
  await expect(page.getByTestId('detail-reserved')).toHaveText('0');
  await expect(page.getByTestId('detail-remaining')).toHaveText('10');
  await expect(page.getByTestId('detail-book-remaining')).toHaveText('10');
  await expect(page.getByTestId('reservation-empty')).toBeVisible();

  // 预留 4
  await page.getByTestId('reserve-amount-input').fill('4');
  await page.getByTestId('reserve-note-input').fill('待冲 4 卷 135');
  await page.getByTestId('reserve-button').click();
  await expect(page.getByTestId('reservation-item')).toHaveCount(1);
  await expect(page.getByTestId('reservation-amount')).toHaveText('4');
  await expect(page.getByTestId('reservation-note')).toContainText('待冲 4 卷 135');

  // 界面同时显示：已用 0、预留 4、可用 6（账面剩余仍 10）
  await expect(page.getByTestId('batch-used')).toHaveText('0');
  await expect(page.getByTestId('batch-reserved')).toHaveText('4');
  await expect(page.getByTestId('batch-remaining')).toHaveText('6');
  await expect(page.getByTestId('detail-used')).toHaveText('0');
  await expect(page.getByTestId('detail-reserved')).toHaveText('4');
  await expect(page.getByTestId('detail-remaining')).toHaveText('6');
  await expect(page.getByTestId('detail-book-remaining')).toHaveText('10');
  // 提示文案随当前可用量更新
  await expect(page.locator('#films-hint')).toContainText('不得超过当前可用 6');

  // 直接登记 7：超过扣除预留后的可用量，就地拒绝，不留记录
  await page.getByTestId('films-input').fill('7');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('error-films')).toHaveText('超过可用容量：本批当前可用 6，无法登记 7');
  await expect(page.getByTestId('usage-item')).toHaveCount(0);
  await expect(page.getByTestId('detail-remaining')).toHaveText('6');

  // 非法预留数量就地说明
  await page.getByTestId('reserve-amount-input').fill('0');
  await page.getByTestId('reserve-button').click();
  await expect(page.getByTestId('error-reserve-amount')).toHaveText('预留数量须为大于 0 的整数');
  await page.getByTestId('reserve-amount-input').fill('7');
  await page.getByTestId('reserve-button').click();
  await expect(page.getByTestId('error-reserve-amount')).toHaveText('超过可用容量：本批当前可用 6，无法预留 7');
  await expect(page.getByTestId('reservation-item')).toHaveCount(1);

  // 恰好预留 6：可用量降到 0，但状态仍为使用中（只是占住，尚未消耗）
  await page.getByTestId('reserve-amount-input').fill('6');
  await page.getByTestId('reserve-button').click();
  await expect(page.getByTestId('reservation-item')).toHaveCount(2);
  await expect(page.getByTestId('detail-remaining')).toHaveText('0');
  await expect(page.getByTestId('detail-book-remaining')).toHaveText('10');
  await expect(page.getByTestId('detail-status')).toHaveText('使用中');
  await expect(page.getByTestId('batch-status')).toHaveText('使用中');

  // 可用为 0：直接登记 1 被拒
  await page.getByTestId('films-input').fill('1');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('error-films')).toContainText('本批当前可用 0');
  await expect(page.getByTestId('usage-item')).toHaveCount(0);
});

test('全额结算：原子追加使用记录并终结预留，记录默认携带预留备注', async ({ page }) => {
  await page.getByTestId('nav-ledger').click();
  await createBatch(page, '结算批次', '10');

  await page.getByTestId('reserve-amount-input').fill('4');
  await page.getByTestId('reserve-note-input').fill('预留备注');
  await page.getByTestId('reserve-button').click();
  await expect(page.getByTestId('reservation-item')).toHaveCount(1);

  // 结算数量非法时就地说明，预留保留
  await page.getByTestId('settle-input').fill('5');
  await page.getByTestId('settle-button').click();
  await expect(page.getByTestId('settle-error')).toHaveText('结算数量超过预留量：本次预留 4，无法结算 5');
  await expect(page.getByTestId('reservation-item')).toHaveCount(1);
  await expect(page.getByTestId('usage-item')).toHaveCount(0);

  await page.getByTestId('settle-input').fill('0');
  await page.getByTestId('settle-button').click();
  await expect(page.getByTestId('settle-error')).toHaveText('结算数量须为大于 0 的整数');
  await expect(page.getByTestId('reservation-item')).toHaveCount(1);

  // 全额结算 4：记录出现、预留消失、可用恢复
  await page.getByTestId('settle-input').fill('4');
  await page.getByTestId('settle-button').click();
  await expect(page.getByTestId('reservation-item')).toHaveCount(0);
  await expect(page.getByTestId('reservation-empty')).toBeVisible();
  await expect(page.getByTestId('usage-item')).toHaveCount(1);
  await expect(page.getByTestId('usage-films')).toHaveText('4');
  await expect(page.getByTestId('usage-note')).toContainText('预留备注');
  await expect(page.getByTestId('usage-remaining')).toHaveText('6');
  await expect(page.getByTestId('detail-used')).toHaveText('4');
  await expect(page.getByTestId('detail-reserved')).toHaveText('0');
  await expect(page.getByTestId('detail-remaining')).toHaveText('6');

  // 结算输入框随终结预留一起清空，无残留草稿
  await expect(page.getByTestId('settle-input')).toHaveCount(0);

  // 刷新：使用记录保留、无幽灵预留
  await page.reload();
  await gotoLedger(page);
  await expect(page.getByTestId('batch-used')).toHaveText('4');
  await expect(page.getByTestId('batch-reserved')).toHaveText('0');
  await expect(page.getByTestId('batch-remaining')).toHaveText('6');
  await page.getByTestId('batch-item').click();
  await expect(page.getByTestId('usage-item')).toHaveCount(1);
  await expect(page.getByTestId('reservation-item')).toHaveCount(0);
  const raw = await readRawLedger(page);
  expect(raw?.records).toHaveLength(1);
  expect(raw?.reservations).toEqual([]);
});

test('部分结算：按实际用量入账，未用部分释放并可被再次登记', async ({ page }) => {
  await page.getByTestId('nav-ledger').click();
  await createBatch(page, '部分结算批次', '10');

  await page.getByTestId('reserve-amount-input').fill('6');
  await page.getByTestId('reserve-button').click();
  await expect(page.getByTestId('detail-remaining')).toHaveText('4');

  // 实际只用 4：记录 4，预留 6 终结，未用的 2 释放 → 可用 10 − 4 = 6
  await page.getByTestId('settle-input').fill('4');
  await page.getByTestId('settle-button').click();
  await expect(page.getByTestId('usage-item')).toHaveCount(1);
  await expect(page.getByTestId('usage-films')).toHaveText('4');
  await expect(page.getByTestId('usage-remaining')).toHaveText('6');
  await expect(page.getByTestId('detail-used')).toHaveText('4');
  await expect(page.getByTestId('detail-reserved')).toHaveText('0');
  await expect(page.getByTestId('detail-remaining')).toHaveText('6');

  // 释放出的容量（含未用 2）可直接登记 6，恰好耗尽
  await page.getByTestId('films-input').fill('6');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('usage-item')).toHaveCount(2);
  await expect(page.getByTestId('detail-status')).toHaveText('已耗尽');
  await expect(page.getByTestId('detail-remaining')).toHaveText('0');
});

test('取消预留：全部容量释放、不生成使用记录；切换批次丢弃预留 / 结算草稿', async ({ page }) => {
  await page.getByTestId('nav-ledger').click();
  await createBatch(page, '取消批次', '10');

  await page.getByTestId('reserve-amount-input').fill('5');
  await page.getByTestId('reserve-button').click();
  await expect(page.getByTestId('detail-remaining')).toHaveText('5');

  // 填了结算数量但改点取消：不生成记录，输入随之清理
  await page.getByTestId('settle-input').fill('3');
  await page.getByTestId('cancel-reservation-button').click();
  await expect(page.getByTestId('reservation-item')).toHaveCount(0);
  await expect(page.getByTestId('usage-item')).toHaveCount(0);
  await expect(page.getByTestId('detail-used')).toHaveText('0');
  await expect(page.getByTestId('detail-reserved')).toHaveText('0');
  await expect(page.getByTestId('detail-remaining')).toHaveText('10');

  const raw = await readRawLedger(page);
  expect(raw?.records).toEqual([]);
  expect(raw?.reservations).toEqual([]);

  // 草稿隔离：再建一批，填写预留 / 结算草稿后切批次，全部丢弃
  await page.getByTestId('batch-name-input').fill('批次 B');
  await page.getByTestId('batch-capacity-input').fill('8');
  await page.getByTestId('create-batch-button').click();
  await page.getByTestId('reserve-amount-input').fill('2');
  await page.getByTestId('reserve-button').click();
  await page.getByTestId('reserve-amount-input').fill('3');
  await page.getByTestId('reserve-note-input').fill('不应带走的备注');
  await page.getByTestId('settle-input').fill('1');
  await page.getByTestId('batch-item').first().click();
  // 切回「取消批次」：预留表单与结算草稿全部丢弃，不影响该批次（无有效预留）
  await expect(page.getByTestId('reserve-amount-input')).toHaveValue('');
  await expect(page.getByTestId('reserve-note-input')).toHaveValue('');
  await expect(page.getByTestId('reservation-item')).toHaveCount(0);
});

test('刷新恢复：有效预留按时间还原，占住的容量继续生效，随后可正常结算', async ({ page }) => {
  await page.getByTestId('nav-ledger').click();
  await createBatch(page, '刷新批次', '10');

  await page.getByTestId('reserve-amount-input').fill('3');
  await page.getByTestId('reserve-note-input').fill('第一卷');
  await page.getByTestId('reserve-button').click();
  await page.getByTestId('reserve-amount-input').fill('2');
  await page.getByTestId('reserve-note-input').fill('第二卷');
  await page.getByTestId('reserve-button').click();
  await expect(page.getByTestId('reservation-item')).toHaveCount(2);
  await expect(page.getByTestId('detail-remaining')).toHaveText('5');

  await page.reload();
  await gotoLedger(page);
  // 列表显示预留 5、可用 5
  await expect(page.getByTestId('batch-reserved')).toHaveText('5');
  await expect(page.getByTestId('batch-remaining')).toHaveText('5');
  await page.getByTestId('batch-item').click();
  await expect(page.getByTestId('reservation-item')).toHaveCount(2);
  const amounts = await page.getByTestId('reservation-amount').allInnerTexts();
  expect(amounts).toEqual(['3', '2']);
  await expect(page.getByTestId('detail-remaining')).toHaveText('5');

  // 刷新后仍被占住：直接登记 6 被拒
  await page.getByTestId('films-input').fill('6');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('error-films')).toContainText('本批当前可用 5');

  // 结算第一笔预留（3）：记录入账、该预留消失，可用升到 5（10 − 3 已用 − 2 仍预留）
  await page.getByTestId('settle-input').first().fill('3');
  await page.getByTestId('settle-button').first().click();
  await expect(page.getByTestId('reservation-item')).toHaveCount(1);
  await expect(page.getByTestId('usage-item')).toHaveCount(1);
  await expect(page.getByTestId('detail-reserved')).toHaveText('2');
  await expect(page.getByTestId('detail-remaining')).toHaveText('5');
});

test('旧版存档缺少 reservations 字段时按空集合恢复，随后预留 / 结算正常升级', async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    [
      LEDGER_STORAGE_KEY,
      JSON.stringify({
        batches: [
          { id: 'legacy-batch', name: '旧批次', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' },
        ],
        records: [
          {
            id: 'old-record',
            batchId: 'legacy-batch',
            films: 3,
            note: '旧记录',
            remainingAfter: 7,
            createdAt: '2026-09-01T09:00:00.000Z',
          },
        ],
      }),
    ] as const,
  );
  await gotoLedger(page);
  // 旧记录结构与含义不变：已用 3；预留字段缺失按空集合：预留 0、可用 7
  await expect(page.getByTestId('batch-used')).toHaveText('3');
  await expect(page.getByTestId('batch-reserved')).toHaveText('0');
  await expect(page.getByTestId('batch-remaining')).toHaveText('7');
  await page.getByTestId('batch-item').click();
  await expect(page.getByTestId('usage-item')).toHaveCount(1);
  await expect(page.getByTestId('reservation-empty')).toBeVisible();

  // 预留 4 并刷新：新格式带 reservations 数组
  await page.getByTestId('reserve-amount-input').fill('4');
  await page.getByTestId('reserve-button').click();
  await expect(page.getByTestId('reservation-item')).toHaveCount(1);
  await expect(page.getByTestId('detail-remaining')).toHaveText('3');
  const rawAfterReserve = await readRawLedger(page);
  expect(rawAfterReserve?.reservations).toHaveLength(1);
  expect(rawAfterReserve?.revision).toBe(1);

  // 结算 2（部分）：记录追加、预留释放未用 2
  await page.getByTestId('settle-input').fill('2');
  await page.getByTestId('settle-button').click();
  await expect(page.getByTestId('usage-item')).toHaveCount(2);
  await expect(page.getByTestId('detail-used')).toHaveText('5');
  await expect(page.getByTestId('detail-remaining')).toHaveText('5');
  const raw = await readRawLedger(page);
  expect(raw?.records.map((r) => r.films)).toEqual([3, 2]);
  expect(raw?.reservations).toEqual([]);
  expect(raw?.revision).toBe(2);
});

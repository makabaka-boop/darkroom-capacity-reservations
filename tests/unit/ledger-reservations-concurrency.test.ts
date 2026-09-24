import { describe, expect, it } from 'vitest';
import {
  availableCapacity,
  createBatch,
  EMPTY_LEDGER,
  remainingCapacity,
  reservedCapacity,
  usedCapacity,
  type LedgerDeps,
} from '../../src/lib/capacityLedger';
import {
  commitLedger,
  LEDGER_STORAGE_KEY,
  loadLedgerDocument,
  parseLedgerDocument,
  serializeLedgerDocument,
  type LedgerDocument,
  type StorageLike,
} from '../../src/lib/ledgerStorage';

/** 确定性依赖：时间逐秒递增，id 递增，便于断言与复现。 */
function testDeps(): LedgerDeps {
  let counter = 0;
  return {
    now: () => {
      counter += 1;
      return new Date(Date.UTC(2026, 8, 24, 12, 0, 0) + counter * 1000);
    },
    nextId: () => `test-id-${counter}`,
  };
}

interface TestStorage extends StorageLike {
  failWrites(): void;
  recoverWrites(): void;
  raw(): string | null;
}

function memoryStorage(initial?: Record<string, string>): TestStorage {
  const data = new Map<string, string>(initial ? Object.entries(initial) : []);
  let failing = false;
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (failing) throw new Error('QuotaExceededError: mock quota');
      data.set(key, value);
    },
    failWrites: () => {
      failing = true;
    },
    recoverWrites: () => {
      failing = false;
    },
    raw: () => data.get(LEDGER_STORAGE_KEY) ?? null,
  };
}

/** 直接在存储中建立一个容量为 capacity 的批次（绕过页面文档）。 */
function seedBatch(storage: StorageLike, name: string, capacity: string, deps: LedgerDeps): string {
  const result = createBatch(loadLedgerDocument(storage).doc.ledger, { name, capacity }, deps);
  if (!result.ok) throw new Error(`seed 失败：${result.error}`);
  const doc = loadLedgerDocument(storage).doc;
  storage.setItem(
    LEDGER_STORAGE_KEY,
    serializeLedgerDocument({ ledger: result.state, revision: doc.revision + 1 }),
  );
  return result.value.id;
}

function reload(storage: StorageLike): LedgerDocument {
  return loadLedgerDocument(storage).doc;
}

describe('预留 / 结算 / 取消的跨标签并发提交', () => {
  it('预留成功提交修订号 +1；超额预留被领域拒绝、不写存储', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const batchId = seedBatch(storage, '显影液', '10', deps);
    const page = reload(storage);
    expect(page.revision).toBe(1);

    const reserved = commitLedger(
      storage,
      page,
      { type: 'reserveCapacity', input: { batchId, amount: '6', note: 'A 页先占' } },
      deps,
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(reserved.doc.revision).toBe(2);
    const reservationId = reserved.intent.result.ok ? reserved.intent.result.value.id : '';
    const batch = reserved.doc.ledger.batches[0];
    expect(reservedCapacity(reserved.doc.ledger, batchId)).toBe(6);
    expect(availableCapacity(batch, reserved.doc.ledger)).toBe(4);

    // 超额预留（可用只剩 4）：领域拒绝，修订号与存储不变
    const over = commitLedger(
      storage,
      reserved.doc,
      { type: 'reserveCapacity', input: { batchId, amount: '5' } },
      deps,
    );
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.kind).toBe('rejected');
    expect(reload(storage).revision).toBe(2);

    // 取消该预留：同样 +1，可用量全部恢复，无使用记录
    const cancelled = commitLedger(
      storage,
      reserved.doc,
      { type: 'cancelReservation', input: { reservationId } },
      deps,
    );
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.doc.revision).toBe(3);
    expect(cancelled.doc.ledger.reservations).toHaveLength(0);
    expect(cancelled.doc.ledger.records).toHaveLength(0);
    expect(availableCapacity(batch, cancelled.doc.ledger)).toBe(10);
  });

  it('两标签页同时占容量：先占者成功，后者冲突后按最新可用量重试；容量不被双重占用', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const batchId = seedBatch(storage, '抢占批次', '10', deps);
    const pageA = reload(storage);
    const pageB = reload(storage);

    // A 先预留 6：成功
    const a = commitLedger(
      storage,
      pageA,
      { type: 'reserveCapacity', input: { batchId, amount: '6', note: 'A 占 6' } },
      deps,
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const reservationA = a.intent.result.ok ? a.intent.result.value.id : '';

    // B 持旧基准也要预留 6：冲突整体拒绝，不留下任何预留
    const bStale = commitLedger(
      storage,
      pageB,
      { type: 'reserveCapacity', input: { batchId, amount: '6', note: 'B 也想占 6' } },
      deps,
    );
    expect(bStale.ok).toBe(false);
    if (!bStale.ok) {
      expect(bStale.kind).toBe('conflict');
      if (bStale.kind === 'conflict') expect(bStale.error).toContain('其他页面');
      // 返回的最新台账：只有 A 的预留
      expect(bStale.doc.ledger.reservations.map((r) => r.note)).toEqual(['A 占 6']);
    }
    const storedAfterConflict = parseLedgerDocument(storage.raw()!)!;
    expect(storedAfterConflict.ledger.reservations).toHaveLength(1);
    expect(reservedCapacity(storedAfterConflict.ledger, batchId)).toBe(6);

    // B 刷新：可用只剩 4。坚持预留 6 被领域拒绝
    const pageBFresh = reload(storage);
    const over = commitLedger(
      storage,
      pageBFresh,
      { type: 'reserveCapacity', input: { batchId, amount: '6' } },
      deps,
    );
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.kind).toBe('rejected');

    // B 改预留 4：成功，可用量降为 0（容量被两页占满但未消耗）
    const b = commitLedger(
      storage,
      pageBFresh,
      { type: 'reserveCapacity', input: { batchId, amount: '4', note: 'B 占 4' } },
      deps,
    );
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const batch = b.doc.ledger.batches[0];
    expect(availableCapacity(batch, b.doc.ledger)).toBe(0);
    expect(usedCapacity(b.doc.ledger, batchId)).toBe(0);
    expect(remainingCapacity(batch, b.doc.ledger)).toBe(10);
    expect(reservationA).toBeTruthy();
  });

  it('结算与直接登记交错：A 结算释放的余量立即可用，旧页面登记不会超扣', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const batchId = seedBatch(storage, '结算批次', '10', deps);
    const page0 = reload(storage);

    // A 预留 6
    const reserved = commitLedger(
      storage,
      page0,
      { type: 'reserveCapacity', input: { batchId, amount: '6', note: '待冲' } },
      deps,
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    const reservationId = reserved.intent.result.ok ? reserved.intent.result.value.id : '';

    // 另一标签页持「已预留 6、可用 4」的文档，想直接登记 5：超过可用量
    const otherPage = reload(storage);
    const blocked = commitLedger(
      storage,
      otherPage,
      { type: 'recordUsage', input: { batchId, films: '5' } },
      deps,
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.kind).toBe('rejected');
      if (blocked.kind === 'rejected') {
        expect(blocked.intent.result.ok).toBe(false);
      }
    }

    // A 部分结算：实际 4，释放 2（修订号推进）
    const settled = commitLedger(
      storage,
      reserved.doc,
      { type: 'settleReservation', input: { reservationId, films: '4' } },
      deps,
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    // 使用记录原子追加、预留终结在同一文档
    expect(settled.doc.ledger.records.map((r) => r.films)).toEqual([4]);
    expect(settled.doc.ledger.records[0].note).toBe('待冲');
    expect(settled.doc.ledger.reservations).toHaveLength(0);
    const batch = settled.doc.ledger.batches[0];
    expect(availableCapacity(batch, settled.doc.ledger)).toBe(6);

    // 旧页面（revision 2）直接登记 5：先撞修订号冲突，绝不超扣
    const stale = commitLedger(
      storage,
      otherPage,
      { type: 'recordUsage', input: { batchId, films: '5' } },
      deps,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.kind).toBe('conflict');

    // 刷新对齐后重试 5：成功，最终已用 9、可用 1
    const fresh = reload(storage);
    const retry = commitLedger(
      storage,
      fresh,
      { type: 'recordUsage', input: { batchId, films: '5', note: 'B 页登记' } },
      deps,
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(usedCapacity(retry.doc.ledger, batchId)).toBe(9);
    expect(availableCapacity(batch, retry.doc.ledger)).toBe(1);
    expect(retry.doc.ledger.records.map((r) => r.note)).toEqual(['待冲', 'B 页登记']);
  });

  it('重复终结：另一标签页已经结算时，迟到的结算 / 取消在最新台账上被领域拒绝且不二次入账', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const batchId = seedBatch(storage, '终结批次', '10', deps);
    const page0 = reload(storage);
    const reserved = commitLedger(
      storage,
      page0,
      { type: 'reserveCapacity', input: { batchId, amount: '4' } },
      deps,
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    const reservationId = reserved.intent.result.ok ? reserved.intent.result.value.id : '';

    // 两个页面都读到「预留中」
    const pageA = reload(storage);
    const pageB = reload(storage);

    // A 全额结算 4
    const settled = commitLedger(
      storage,
      pageA,
      { type: 'settleReservation', input: { reservationId, films: '4' } },
      deps,
    );
    expect(settled.ok).toBe(true);

    // B 迟到的结算先撞冲突（旧修订号）
    const staleSettle = commitLedger(
      storage,
      pageB,
      { type: 'settleReservation', input: { reservationId, films: '4' } },
      deps,
    );
    expect(staleSettle.ok).toBe(false);
    if (!staleSettle.ok) expect(staleSettle.kind).toBe('conflict');

    // B 刷新后再次提交同一结算：预留已终结 → 领域拒绝，不会二次入账
    const pageBFresh = reload(storage);
    const duplicate = commitLedger(
      storage,
      pageBFresh,
      { type: 'settleReservation', input: { reservationId, films: '4' } },
      deps,
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.kind).toBe('rejected');
      if (duplicate.kind === 'rejected') {
        expect(duplicate.intent.result.ok).toBe(false);
        if (!duplicate.intent.result.ok) {
          expect(duplicate.intent.result.error).toBe('预留不存在或已终结（已结算或已取消）');
        }
      }
    }
    // 刷新后取消也一样被拒
    const cancelAfter = commitLedger(
      storage,
      reload(storage),
      { type: 'cancelReservation', input: { reservationId } },
      deps,
    );
    expect(cancelAfter.ok).toBe(false);
    if (!cancelAfter.ok) expect(cancelAfter.kind).toBe('rejected');

    const final = reload(storage);
    expect(final.ledger.records).toHaveLength(1);
    expect(final.ledger.records[0].films).toBe(4);
    expect(final.ledger.reservations).toHaveLength(0);
    expect(usedCapacity(final.ledger, batchId)).toBe(4);
  });

  it('写入失败：结算 / 预留 / 取消被整体拒绝，存储不留已结算却无记录的半状态', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const batchId = seedBatch(storage, '配额批次', '10', deps);
    // 先正常预留 4
    const base = reload(storage);
    const reserved = commitLedger(
      storage,
      base,
      { type: 'reserveCapacity', input: { batchId, amount: '4' } },
      deps,
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    const reservationId = reserved.intent.result.ok ? reserved.intent.result.value.id : '';
    const rawBeforeSettle = storage.raw();

    // 存储开始拒写后尝试结算：拒绝，原始文档一个字节不变
    storage.failWrites();
    const failedSettle = commitLedger(
      storage,
      reserved.doc,
      { type: 'settleReservation', input: { reservationId, films: '3' } },
      deps,
    );
    expect(failedSettle.ok).toBe(false);
    if (!failedSettle.ok && failedSettle.kind === 'storage') {
      expect(failedSettle.error).toContain('保存失败');
      // 返回的最后完整台账：预留还在、记录未追加
      expect(failedSettle.doc.ledger.reservations).toHaveLength(1);
      expect(failedSettle.doc.ledger.records).toHaveLength(0);
    }
    expect(storage.raw()).toBe(rawBeforeSettle);
    const reloadedAfterFail = parseLedgerDocument(storage.raw()!)!;
    expect(reloadedAfterFail.ledger.reservations).toHaveLength(1);
    expect(reloadedAfterFail.ledger.records).toHaveLength(0);

    // 取消在拒写期间同样失败：预留原样保留
    const failedCancel = commitLedger(
      storage,
      reserved.doc,
      { type: 'cancelReservation', input: { reservationId } },
      deps,
    );
    expect(failedCancel.ok).toBe(false);
    if (!failedCancel.ok) expect(failedCancel.kind).toBe('storage');
    expect(parseLedgerDocument(storage.raw()!)!.ledger.reservations).toHaveLength(1);

    // 恢复后重试结算 3：成功，无半状态
    storage.recoverWrites();
    const retry = commitLedger(
      storage,
      reload(storage),
      { type: 'settleReservation', input: { reservationId, films: '3' } },
      deps,
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    const final = reload(storage);
    expect(final.ledger.records.map((r) => r.films)).toEqual([3]);
    expect(final.ledger.reservations).toHaveLength(0);
    const batch = final.ledger.batches[0];
    expect(availableCapacity(batch, final.ledger)).toBe(7);
  });

  it('旧版存档（无 reservations / revision）：预留按空集合读入，首次提交后升级为新格式', () => {
    const legacy = JSON.stringify({
      batches: [{ id: 'legacy-batch', name: '旧批次', capacity: 10, createdAt: 't' }],
      records: [
        { id: 'legacy-record', batchId: 'legacy-batch', films: 2, note: '', remainingAfter: 8, createdAt: 't2' },
      ],
    });
    const storage = memoryStorage({ [LEDGER_STORAGE_KEY]: legacy });

    const page = reload(storage);
    expect(page.revision).toBe(0);
    expect(page.ledger.reservations).toEqual([]);
    const batch = page.ledger.batches[0];
    expect(availableCapacity(batch, page.ledger)).toBe(8);

    const deps = testDeps();
    const reserved = commitLedger(
      storage,
      page,
      { type: 'reserveCapacity', input: { batchId: 'legacy-batch', amount: '5' } },
      deps,
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    const raw = JSON.parse(storage.raw()!) as Record<string, unknown>;
    expect(raw.revision).toBe(1);
    expect(Array.isArray(raw.reservations)).toBe(true);
    expect((raw.reservations as unknown[])).toHaveLength(1);
    // 旧记录保持原结构及含义
    expect((raw.records as Array<Record<string, unknown>>).map((r) => r.films)).toEqual([2]);

    // 新文档仍可被旧入口（只认 batches / records）读出
    expect(parseLedgerDocument(storage.raw()!)!.ledger.records).toHaveLength(1);
  });

  it('存储损坏时预留 / 结算 / 取消一律拒绝且不覆盖原文', () => {
    const storage = memoryStorage({ [LEDGER_STORAGE_KEY]: '{broken' });
    const deps = testDeps();
    for (const intent of [
      { type: 'reserveCapacity', input: { batchId: 'b', amount: '1' } },
      { type: 'settleReservation', input: { reservationId: 'r', films: '1' } },
      { type: 'cancelReservation', input: { reservationId: 'r' } },
    ] as const) {
      const outcome = commitLedger(
        storage,
        { ledger: EMPTY_LEDGER, revision: 0 },
        intent,
        deps,
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.kind).toBe('corrupted');
    }
    expect(storage.raw()).toBe('{broken');
  });
});

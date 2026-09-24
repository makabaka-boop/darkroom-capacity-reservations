import { describe, expect, it } from 'vitest';
import {
  availableCapacity,
  batchRecords,
  batchReservations,
  batchStatus,
  cancelReservation,
  createBatch,
  EMPTY_LEDGER,
  recordUsage,
  remainingCapacity,
  reserveCapacity,
  reservedCapacity,
  settleReservation,
  usedCapacity,
  validateReserveAmountInput,
  validateSettleAmountInput,
  type CapacityReservation,
  type LedgerDeps,
  type LedgerState,
} from '../../src/lib/capacityLedger';

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

function mustCreate(state: LedgerState, name: string, capacity: string, deps: LedgerDeps) {
  const result = createBatch(state, { name, capacity }, deps);
  if (!result.ok) throw new Error(`测试前置创建批次失败：${result.error}`);
  return result;
}

function mustReserve(state: LedgerState, batchId: string, amount: string, deps: LedgerDeps, note = '') {
  const result = reserveCapacity(state, { batchId, amount, note }, deps);
  if (!result.ok) throw new Error(`测试前置预留失败：${result.error}`);
  return result;
}

function mustRecord(state: LedgerState, batchId: string, films: string, deps: LedgerDeps) {
  const result = recordUsage(state, { batchId, films }, deps);
  if (!result.ok) throw new Error(`测试前置登记失败：${result.error}`);
  return result;
}

describe('容量派生口径（已用 / 预留 / 可用）', () => {
  it('可用量 = 额定 − 已登记 − 有效预留；账面剩余不含预留', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const batch = created.value;
    let state = created.state;

    expect(usedCapacity(state, batch.id)).toBe(0);
    expect(reservedCapacity(state, batch.id)).toBe(0);
    expect(remainingCapacity(batch, state)).toBe(10);
    expect(availableCapacity(batch, state)).toBe(10);

    // 直接登记 3
    state = mustRecord(state, batch.id, '3', deps).state;
    expect(usedCapacity(state, batch.id)).toBe(3);
    expect(remainingCapacity(batch, state)).toBe(7);
    expect(availableCapacity(batch, state)).toBe(7);

    // 预留 4：已用不变，可用扣到 3，账面剩余仍为 7
    state = mustReserve(state, batch.id, '4', deps).state;
    expect(usedCapacity(state, batch.id)).toBe(3);
    expect(reservedCapacity(state, batch.id)).toBe(4);
    expect(remainingCapacity(batch, state)).toBe(7);
    expect(availableCapacity(batch, state)).toBe(3);
    // 有预留但未耗尽：状态仍为使用中
    expect(batchStatus(batch, state)).toBe('active');
  });

  it('多批次预留互不影响，按批次隔离汇总', () => {
    const deps = testDeps();
    const a = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const b = mustCreate(a.state, '定影液', '5', deps);
    let state = b.state;
    state = mustReserve(state, a.value.id, '6', deps).state;
    state = mustReserve(state, b.value.id, '2', deps).state;

    expect(reservedCapacity(state, a.value.id)).toBe(6);
    expect(availableCapacity(a.value, state)).toBe(4);
    expect(reservedCapacity(state, b.value.id)).toBe(2);
    expect(availableCapacity(b.value, state)).toBe(3);
    expect(batchReservations(state, a.value.id).map((r) => r.amount)).toEqual([6]);
    expect(batchReservations(state, b.value.id).map((r) => r.amount)).toEqual([2]);
  });
});

describe('reserveCapacity 命令', () => {
  function setup(capacity = '10') {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', capacity, deps);
    return { deps, batch: created.value, state: created.state };
  }

  it('批次不存在时拒绝预留', () => {
    const { deps, state } = setup();
    const result = reserveCapacity(state, { batchId: 'no-such-id', amount: '1' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('批次不存在或已被移除');
    expect(state.reservations).toHaveLength(0);
  });

  it('预留数量为空、非整数或非正整数时分别说明原因且不写入', () => {
    const { deps, batch, state } = setup();
    const cases: Array<[string, string]> = [
      ['', '请输入预留数量'],
      ['1.5', '预留数量必须为整数，不能含小数或字母'],
      ['abc', '预留数量必须为整数，不能含小数或字母'],
      ['0', '预留数量须为大于 0 的整数'],
      ['-2', '预留数量须为大于 0 的整数'],
    ];
    for (const [amount, message] of cases) {
      const result = reserveCapacity(state, { batchId: batch.id, amount }, deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(message);
      expect(state.reservations).toHaveLength(0);
    }
    expect(validateReserveAmountInput('9'.repeat(400))).toBe(
      '数值过大，无法精确记录，请填写较小的整数',
    );
  });

  it('预留超过当前可用量（扣除已有预留与登记）时拒绝且不写入', () => {
    const { deps, batch, state } = setup('10');
    let current = mustRecord(state, batch.id, '2', deps).state;
    current = mustReserve(current, batch.id, '5', deps).state;
    // 已用 2 + 预留 5 → 可用 3
    expect(availableCapacity(batch, current)).toBe(3);

    const over = reserveCapacity(current, { batchId: batch.id, amount: '4' }, deps);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toBe('超过可用容量：本批当前可用 3，无法预留 4');
    expect(current.reservations).toHaveLength(1);
    expect(reservedCapacity(current, batch.id)).toBe(5);

    // 恰好等于可用量 3：允许，可用量降为 0（全部占住，但账面剩余 8，状态仍使用中）
    const exact = reserveCapacity(current, { batchId: batch.id, amount: '3' }, deps);
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(availableCapacity(batch, exact.state)).toBe(0);
    expect(remainingCapacity(batch, exact.state)).toBe(8);
    expect(batchStatus(batch, exact.state)).toBe('active');
  });

  it('合法预留被冻结、备注去空白，且不修改传入状态', () => {
    const { deps, batch, state } = setup('10');
    const result = reserveCapacity(state, { batchId: batch.id, amount: ' 4 ', note: ' 待冲一卷 ' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amount).toBe(4);
    expect(result.value.note).toBe('待冲一卷');
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(state.reservations).toHaveLength(0);
    expect(result.state.reservations).toHaveLength(1);
    expect(() => {
      (result.value as { amount: number }).amount = 99;
    }).toThrow(TypeError);
  });
});

describe('settleReservation 命令（结算终结）', () => {
  function setup(capacity = '10') {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', capacity, deps);
    const reserved = mustReserve(created.state, created.value.id, '4', deps, '预留备注');
    return { deps, batch: created.value, reservation: reserved.value, state: reserved.state };
  }

  it('结算量为空、非整数、非正整数时拒绝，预留保留可重试', () => {
    const { deps, reservation, state } = setup();
    const cases: Array<[string, string]> = [
      ['', '请输入实际使用数量'],
      ['2.5', '结算数量必须为整数，不能含小数或字母'],
      ['x', '结算数量必须为整数，不能含小数或字母'],
      ['0', '结算数量须为大于 0 的整数'],
      ['-1', '结算数量须为大于 0 的整数'],
    ];
    for (const [films, message] of cases) {
      const result = settleReservation(state, { reservationId: reservation.id, films }, deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(message);
      // 预留仍在、无记录
      expect(state.reservations).toHaveLength(1);
      expect(state.records).toHaveLength(0);
    }
    expect(validateSettleAmountInput(String(2 ** 53 + 1))).toBe(
      '数值过大，无法精确记录，请填写较小的整数',
    );
  });

  it('结算量大于预留量时拒绝，预留与可用量保持不变', () => {
    const { deps, batch, reservation, state } = setup('10');
    expect(availableCapacity(batch, state)).toBe(6);

    const over = settleReservation(state, { reservationId: reservation.id, films: '5' }, deps);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toBe('结算数量超过预留量：本次预留 4，无法结算 5');
    // 半状态不留：预留还在、无使用记录、可用量不变
    expect(state.reservations.map((r) => r.id)).toEqual([reservation.id]);
    expect(state.records).toHaveLength(0);
    expect(reservedCapacity(state, batch.id)).toBe(4);
    expect(availableCapacity(batch, state)).toBe(6);
  });

  it('全额结算：追加不可修改记录并终结预留，记录默认带预留备注', () => {
    const { deps, batch, reservation, state } = setup('10');
    const result = settleReservation(state, { reservationId: reservation.id, films: '4' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.films).toBe(4);
    expect(result.value.note).toBe('预留备注');
    expect(result.value.remainingAfter).toBe(6);
    expect(Object.isFrozen(result.value)).toBe(true);
    // 预留终结：集合清空
    expect(result.state.reservations).toHaveLength(0);
    expect(batchReservations(result.state, batch.id)).toEqual([]);
    // 使用记录可在既有记录列表中追溯
    expect(batchRecords(result.state, batch.id).map((r) => r.films)).toEqual([4]);
    expect(usedCapacity(result.state, batch.id)).toBe(4);
    expect(remainingCapacity(batch, result.state)).toBe(6);
    expect(availableCapacity(batch, result.state)).toBe(6);
    // 纯函数：传入状态不变
    expect(state.reservations).toHaveLength(1);
    expect(state.records).toHaveLength(0);
  });

  it('部分结算：按实际用量入账，未用部分原子释放回可用量', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const batch = created.value;
    // 预留 4 后可用 6
    const reserved = mustReserve(created.state, batch.id, '4', deps).state;
    expect(availableCapacity(batch, reserved)).toBe(6);

    // 实际只用 3：记录 3，预留 4 整体移除，可用 = 10 − 3 = 7（释放 1）
    const settled = settleReservation(reserved, {
      reservationId: reserved.reservations[0].id,
      films: '3',
    }, deps);
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.films).toBe(3);
    expect(settled.value.remainingAfter).toBe(7);
    expect(settled.state.reservations).toHaveLength(0);
    expect(usedCapacity(settled.state, batch.id)).toBe(3);
    expect(availableCapacity(batch, settled.state)).toBe(7);

    // 释放出的容量可以被直接登记
    const direct = recordUsage(settled.state, { batchId: batch.id, films: '7' }, deps);
    expect(direct.ok).toBe(true);
  });

  it('重复终结：已结算的预留再次结算 / 取消都被拒绝，不会二次入账', () => {
    const { deps, reservation, state } = setup('10');
    const settled = settleReservation(state, { reservationId: reservation.id, films: '2' }, deps);
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;

    const settleAgain = settleReservation(settled.state, { reservationId: reservation.id, films: '1' }, deps);
    expect(settleAgain.ok).toBe(false);
    if (!settleAgain.ok) expect(settleAgain.error).toBe('预留不存在或已终结（已结算或已取消）');

    const cancelAfterSettle = cancelReservation(settled.state, { reservationId: reservation.id });
    expect(cancelAfterSettle.ok).toBe(false);
    if (!cancelAfterSettle.ok) {
      expect(cancelAfterSettle.error).toBe('预留不存在或已终结（已结算或已取消）');
    }
    // 只有第一次结算的一条记录
    expect(settled.state.records).toHaveLength(1);
    expect(settleAgain.ok ? null : settled.state.records).toHaveLength(1);
  });

  it('不存在的预留 id 结算时拒绝', () => {
    const { deps, state } = setup();
    const result = settleReservation(state, { reservationId: 'ghost', films: '1' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('预留不存在或已终结（已结算或已取消）');
    expect(state.records).toHaveLength(0);
  });

  it('结算支持显式备注覆盖预留备注', () => {
    const { deps, reservation, state } = setup('10');
    const result = settleReservation(state, {
      reservationId: reservation.id,
      films: '4',
      note: ' 实际四卷全部冲洗 ',
    }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.note).toBe('实际四卷全部冲洗');
  });
});

describe('cancelReservation 命令（取消终结）', () => {
  it('取消释放全部预留且不生成使用记录', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const batch = created.value;
    let state = mustReserve(created.state, batch.id, '4', deps, '将要取消').state;
    state = mustReserve(state, batch.id, '3', deps).state;
    expect(availableCapacity(batch, state)).toBe(3);

    const target = state.reservations[0];
    const outcome = cancelReservation(state, { reservationId: target.id });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.id).toBe(target.id);
    // 只移除目标预留，另一条仍在；不产生任何记录
    expect(outcome.state.reservations.map((r: CapacityReservation) => r.id)).toEqual([
      state.reservations[1].id,
    ]);
    expect(outcome.state.records).toHaveLength(0);
    expect(reservedCapacity(outcome.state, batch.id)).toBe(3);
    expect(availableCapacity(batch, outcome.state)).toBe(7);
    // 传入状态不变
    expect(state.reservations).toHaveLength(2);
  });

  it('重复取消 / 取消后再结算都被拒绝，容量与记录不变', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const reserved = mustReserve(created.state, created.value.id, '4', deps).state;
    const id = reserved.reservations[0].id;

    const cancelled = cancelReservation(reserved, { reservationId: id });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;

    const again = cancelReservation(cancelled.state, { reservationId: id });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe('预留不存在或已终结（已结算或已取消）');

    const settleAfterCancel = settleReservation(cancelled.state, { reservationId: id, films: '1' }, deps);
    expect(settleAfterCancel.ok).toBe(false);
    expect(cancelled.state.records).toHaveLength(0);
    expect(cancelled.state.reservations).toHaveLength(0);
    expect(availableCapacity(created.value, cancelled.state)).toBe(10);
  });
});

describe('预留与直接登记交错的容量裁决', () => {
  it('已预留的容量不能被直接登记先用掉；释放后才能用', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const batch = created.value;
    const reserved = mustReserve(created.state, batch.id, '6', deps).state;
    // 可用 4：直接登记 5 被拒
    const blocked = recordUsage(reserved, { batchId: batch.id, films: '5' }, deps);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toBe('超过可用容量：本批当前可用 4，无法登记 5');
    expect(reserved.records).toHaveLength(0);

    // 直接登记 4（恰好可用）成功：此时账面剩 6 全部被预留占住，可用 0
    const recorded = mustRecord(reserved, batch.id, '4', deps).state;
    expect(availableCapacity(batch, recorded)).toBe(0);
    // 再登记 1 被拒（即使账面还有 6）
    const blocked2 = recordUsage(recorded, { batchId: batch.id, films: '1' }, deps);
    expect(blocked2.ok).toBe(false);
    if (!blocked2.ok) expect(blocked2.error).toBe('超过可用容量：本批当前可用 0，无法登记 1');

    // 取消预留：6 全部释放，登记恢复可行
    const released = cancelReservation(recorded, { reservationId: recorded.reservations[0].id });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(availableCapacity(batch, released.state)).toBe(6);
    const final = mustRecord(released.state, batch.id, '6', deps).state;
    expect(usedCapacity(final, batch.id)).toBe(10);
    expect(batchStatus(batch, final)).toBe('exhausted');
  });

  it('预留 → 部分结算 → 释放余量，另一标签页口径下可用量连续非负', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '压力批次', '8', deps);
    const batch = created.value;
    let state = created.state;

    state = mustReserve(state, batch.id, '5', deps).state; // 可用 3
    state = mustReserve(state, batch.id, '2', deps).state; // 可用 1
    // 可用 1 时再预留 2：超额拒绝
    const over = reserveCapacity(state, { batchId: batch.id, amount: '2' }, deps);
    expect(over.ok).toBe(false);

    // 结算第一笔预留 5 中的 4：记录 4，两笔预留变一笔 2，可用 = 8 − 4 − 2 = 2
    const settle1 = settleReservation(state, {
      reservationId: state.reservations[0].id,
      films: '4',
    }, deps);
    expect(settle1.ok).toBe(true);
    if (!settle1.ok) return;
    state = settle1.state;
    expect(availableCapacity(batch, state)).toBe(2);
    expect(reservedCapacity(state, batch.id)).toBe(2);

    // 取消剩余预留 2：可用 = 账面剩余 4
    const cancel = cancelReservation(state, { reservationId: state.reservations[0].id });
    expect(cancel.ok).toBe(true);
    if (!cancel.ok) return;
    state = cancel.state;
    expect(availableCapacity(batch, state)).toBe(4);
    expect(remainingCapacity(batch, state)).toBe(4);

    // 全程不变量复核
    expect(usedCapacity(state, batch.id)).toBe(4);
    expect(state.records.map((r) => r.films)).toEqual([4]);
    expect(state.reservations).toEqual([]);
  });
});

/**
 * 药液处理容量台账（领域服务）。
 *
 * 与配液计算相互独立：这里跟踪一批药液按「等效胶片数」计的额定容量、
 * 逐次登记的处理用量、冲洗前的容量预留与剩余容量，避免凭记忆继续使用已耗尽的药液。
 *
 * 冲洗流程支持「先占容量、处理完再按实际用量入账」：
 * 操作员冲洗一卷胶片前先 reserveCapacity 占住药液批次的容量，
 * 处理完成后用 settleReservation 按实际用量结算（未用部分释放），
 * 放弃处理时用 cancelReservation 取消预留（全部释放、不生成使用记录），
 * 避免另一标签页在冲洗期间把余量先用掉。
 *
 * 契约 = 五个命令（纯函数，不修改传入状态，返回新状态）：
 * - createBatch：创建带名称与额定容量的药液批次，可附带一份配液来源快照；
 * - recordUsage：向指定批次直接登记一次处理用量，写入前按扣除有效预留后的可用量裁决；
 * - reserveCapacity：在指定批次上预留正整数容量，预留期间该部分不计入可用量；
 * - settleReservation：原子追加一条不可修改的使用记录并终结预留，
 *   结算量只接受不超过预留量的正数，未用部分随之释放；
 * - cancelReservation：释放全部预留且不生成使用记录。
 *
 * 使用记录一旦写入不可修改：命令只追加、不更新、不删除；
 * 累计用量 / 预留总量 / 可用容量 / 状态均由记录与有效预留推导，不单独存储。
 * 预留只保存「仍然有效」的：结算与取消都把预留从集合中移除（终结），
 * 终结后的预留不留历史条目；旧存档缺少预留字段时按空集合恢复。
 *
 * 配液来源快照（可选）：从配液计算结果区「存入容量台账」时，
 * 把同一次计算的稀释比例、目标总量、量筒容量、分罐数与浓缩液/清水体积
 * 逐字段拷贝固定保存，之后不随界面参数变化；手工创建的批次没有该字段。
 *
 * 校验失败时返回中文原因且不产生任何写入：
 * - 名称为空；
 * - 额定容量 / 胶片数量为空、非整数或非正整数；
 * - 数值超出安全整数范围（超长数字无法精确表示，显示会异常）；
 * - 直接登记数量超过当前可用容量（额定容量 − 已登记用量 − 有效预留）；
 * - 预留数量超过当前可用容量；
 * - 对不存在或已终结（已结算 / 已取消）的预留重复结算或取消；
 * - 结算数量为空 / 非整数 / 非正整数，或大于该预留的预留量；
 * - 附带的配液来源快照结构不完整或违反「浓缩液 + 清水 = 目标总量」。
 * 字段校验函数同时导出，界面可借此把错误放到对应字段下方，
 * 但命令本身仍是最终闸门（同样校验在命令内再执行一次）。
 */

/** 批次状态：使用中 / 已耗尽 */
export type BatchStatus = 'active' | 'exhausted';

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  active: '使用中',
  exhausted: '已耗尽',
};

export interface ChemicalBatch {
  id: string;
  /** 药液名称（非空，已去除首尾空白） */
  name: string;
  /** 额定容量：整批药液可处理的等效胶片总数（正整数） */
  capacity: number;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /**
   * 配液来源快照（可选）：创建时从同一次配液计算结果固定保存，
   * 之后不再变化；手工创建的批次没有该字段。
   */
  mixSource?: MixSourceSnapshot;
}

/**
 * 配液来源快照：一批药液「来自哪次配液计算」的完整参数与结果。
 * 字段名与 dilution.ts 的 MixResult 对齐，由界面从当次计算结果逐字段拷贝。
 */
export interface MixSourceSnapshot {
  /** 稀释式 1+n 的 n */
  n: number;
  /** 目标总量（mL） */
  total: number;
  /** 量筒容量（mL） */
  capacity: number;
  /** 显影罐数量（分罐数） */
  tanks: number;
  /** 取整后的浓缩液体积（mL） */
  concentrate: number;
  /** 清水体积（mL），恒满足 concentrate + water = total */
  water: number;
}

export interface UsageRecord {
  id: string;
  batchId: string;
  /** 本次处理的等效胶片数量（正整数） */
  films: number;
  /**
   * 备注（可为空字符串）。
   * 由预留结算生成的记录默认带上预留时的备注，便于追溯该条用量来自哪次预留。
   */
  note: string;
  /** 写入前重新计算出的、本次登记之后的可用容量（恒 ≥ 0） */
  remainingAfter: number;
  /** 登记时间（ISO 8601） */
  createdAt: string;
}

/**
 * 容量预留：冲洗前先占住的一段批次容量。
 * 预留期间其数量不计入任何标签页的可用量；
 * 结算（settleReservation）或取消（cancelReservation）后即终结，
 * 从状态中移除——这里只保存仍然有效（可结算 / 可取消）的预留。
 */
export interface CapacityReservation {
  id: string;
  batchId: string;
  /** 预留的等效胶片数量（正整数） */
  amount: number;
  /** 备注（可为空字符串），结算时默认带入使用记录 */
  note: string;
  /** 预留时间（ISO 8601） */
  createdAt: string;
}

export interface LedgerState {
  batches: ChemicalBatch[];
  records: UsageRecord[];
  /**
   * 当前有效的容量预留（按写入顺序排列）。
   * 旧版存档没有该字段：持久化读取时按空集合恢复。
   */
  reservations: CapacityReservation[];
}

export const EMPTY_LEDGER: LedgerState = { batches: [], records: [], reservations: [] };

/** 命令依赖：时间与 id 生成器可注入，便于测试复现。 */
export interface LedgerDeps {
  now: () => Date;
  nextId: () => string;
}

/** 生产环境默认依赖。 */
export function defaultLedgerDeps(): LedgerDeps {
  let counter = 0;
  return {
    now: () => new Date(),
    nextId: () => {
      counter += 1;
      return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    },
  };
}

export type CommandResult<T> =
  | { ok: true; value: T; state: LedgerState }
  | { ok: false; error: string };

/**
 * 严格解析整数字符串：拒绝空串、小数、非数字字符；
 * 超长数字（超过 Number.MAX_SAFE_INTEGER）也拒绝——
 * 这类数字无法精确表示（可能变为 Infinity 或被舍入），
 * 一旦入库会造成界面显示异常、持久化往返失败。
 */
function parseStrictInteger(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

/** 是否为「全是数字、但已超出安全整数范围」的超长输入（用于给出专用提示）。 */
function isUnsafeDigits(raw: string): boolean {
  const text = raw.trim();
  if (!/^[+-]?\d+$/.test(text)) return false;
  return !Number.isSafeInteger(Number.parseInt(text, 10));
}

/** 判断未知值是否为正的安全整数（用于快照结构校验）。 */
function isPositiveIntegerValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * 配液来源快照结构校验：六个数值均为正整数，
 * 且满足配液计算的核心不变量「浓缩液 + 清水 = 目标总量」。
 * 命令与持久化读取共用本校验。
 */
export function isMixSourceSnapshot(value: unknown): value is MixSourceSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    !isPositiveIntegerValue(candidate.n) ||
    !isPositiveIntegerValue(candidate.total) ||
    !isPositiveIntegerValue(candidate.capacity) ||
    !isPositiveIntegerValue(candidate.tanks) ||
    !isPositiveIntegerValue(candidate.concentrate) ||
    !isPositiveIntegerValue(candidate.water)
  ) {
    return false;
  }
  return candidate.concentrate + candidate.water === candidate.total;
}

/** 批次名称校验：空（含纯空白）不允许。 */
export function validateBatchName(name: string): string | undefined {
  if (name.trim() === '') return '请输入药液名称';
  return undefined;
}

/** 数字过大（超出安全整数范围）时的统一提示。 */
export const INTEGER_TOO_LARGE_MESSAGE = '数值过大，无法精确记录，请填写较小的整数';

/** 额定容量校验：可精确表示的正整数（拒绝超出安全整数范围的超长数字）。 */
export function validateCapacityInput(raw: string): string | undefined {
  if (raw.trim() === '') return '请输入额定容量';
  if (isUnsafeDigits(raw)) return INTEGER_TOO_LARGE_MESSAGE;
  const value = parseStrictInteger(raw);
  if (value === null) return '额定容量必须为整数，不能含小数或字母';
  if (value <= 0) return '额定容量须为大于 0 的整数';
  return undefined;
}

/** 登记数量校验：可精确表示的正整数（是否超过可用容量由 recordUsage 判定）。 */
export function validateFilmsInput(raw: string): string | undefined {
  if (raw.trim() === '') return '请输入等效胶片数量';
  if (isUnsafeDigits(raw)) return INTEGER_TOO_LARGE_MESSAGE;
  const value = parseStrictInteger(raw);
  if (value === null) return '数量必须为整数，不能含小数或字母';
  if (value <= 0) return '数量须为大于 0 的整数';
  return undefined;
}

/** 预留数量校验：可精确表示的正整数（是否超过可用容量由 reserveCapacity 判定）。 */
export function validateReserveAmountInput(raw: string): string | undefined {
  if (raw.trim() === '') return '请输入预留数量';
  if (isUnsafeDigits(raw)) return INTEGER_TOO_LARGE_MESSAGE;
  const value = parseStrictInteger(raw);
  if (value === null) return '预留数量必须为整数，不能含小数或字母';
  if (value <= 0) return '预留数量须为大于 0 的整数';
  return undefined;
}

/** 结算数量校验：可精确表示的正整数（是否超过预留量由 settleReservation 判定）。 */
export function validateSettleAmountInput(raw: string): string | undefined {
  if (raw.trim() === '') return '请输入实际使用数量';
  if (isUnsafeDigits(raw)) return INTEGER_TOO_LARGE_MESSAGE;
  const value = parseStrictInteger(raw);
  if (value === null) return '结算数量必须为整数，不能含小数或字母';
  if (value <= 0) return '结算数量须为大于 0 的整数';
  return undefined;
}

/** 某批次已登记用量之和（累计用量）。 */
export function usedCapacity(state: LedgerState, batchId: string): number {
  return state.records
    .filter((record) => record.batchId === batchId)
    .reduce((sum, record) => sum + record.films, 0);
}

/** 某批次当前有效预留之和（预留中、尚未结算或取消的容量）。 */
export function reservedCapacity(state: LedgerState, batchId: string): number {
  return state.reservations
    .filter((reservation) => reservation.batchId === batchId)
    .reduce((sum, reservation) => sum + reservation.amount, 0);
}

/**
 * 某批次账面剩余容量 = 额定容量 − 累计用量（与旧版台账含义一致，不受预留影响）。
 * 状态（使用中 / 已耗尽）继续由它推导：预留只是「先占」，不代表已经消耗。
 */
export function remainingCapacity(batch: ChemicalBatch, state: LedgerState): number {
  return batch.capacity - usedCapacity(state, batch.id);
}

/**
 * 某批次当前可用容量 = 额定容量 − 已登记用量 − 有效预留。
 * 直接登记与新建预留都必须按它裁决：另一标签页已占住的预留不能被先用掉。
 */
export function availableCapacity(batch: ChemicalBatch, state: LedgerState): number {
  return remainingCapacity(batch, state) - reservedCapacity(state, batch.id);
}

/** 状态由账面剩余量推导：剩余为 0 即已耗尽，否则使用中（预留不改变状态）。 */
export function batchStatus(batch: ChemicalBatch, state: LedgerState): BatchStatus {
  return remainingCapacity(batch, state) === 0 ? 'exhausted' : 'active';
}

/** 某批次的全部使用记录，按登记时间（写入顺序）排列。 */
export function batchRecords(state: LedgerState, batchId: string): UsageRecord[] {
  return state.records.filter((record) => record.batchId === batchId);
}

/** 某批次当前全部有效预留，按预留时间（写入顺序）排列。 */
export function batchReservations(state: LedgerState, batchId: string): CapacityReservation[] {
  return state.reservations.filter((reservation) => reservation.batchId === batchId);
}

export interface CreateBatchInput {
  name: string;
  /** 表单原始字符串，由命令内部校验 */
  capacity: string;
  /**
   * 可选：配液来源快照，必须取自同一次配液计算结果。
   * 命令会校验其结构完整性，不合格时拒绝创建（不写入任何数据）。
   */
  mixSource?: MixSourceSnapshot;
}

/**
 * 命令一：创建药液批次。
 * 名称为空、额定容量为空 / 非整数 / 非正整数，或附带的配液来源快照
 * 结构不完整时返回原因，不写入任何记录。
 * 快照通过校验后逐字段拷贝并冻结，自此与后续计算无关（固定保存）。
 */
export function createBatch(
  state: LedgerState,
  input: CreateBatchInput,
  deps: LedgerDeps,
): CommandResult<ChemicalBatch> {
  const nameError = validateBatchName(input.name);
  if (nameError) return { ok: false, error: nameError };
  const capacityError = validateCapacityInput(input.capacity);
  if (capacityError) return { ok: false, error: capacityError };
  if (input.mixSource !== undefined && !isMixSourceSnapshot(input.mixSource)) {
    return { ok: false, error: '配液来源数据不完整，请重新计算后再存入' };
  }

  const batch: ChemicalBatch = Object.freeze({
    id: deps.nextId(),
    name: input.name.trim(),
    capacity: parseStrictInteger(input.capacity)!,
    createdAt: deps.now().toISOString(),
    ...(input.mixSource === undefined
      ? {}
      : {
          mixSource: Object.freeze({
            n: input.mixSource.n,
            total: input.mixSource.total,
            capacity: input.mixSource.capacity,
            tanks: input.mixSource.tanks,
            concentrate: input.mixSource.concentrate,
            water: input.mixSource.water,
          }),
        }),
  });
  return {
    ok: true,
    value: batch,
    state: { ...state, batches: [...state.batches, batch] },
  };
}

export interface RecordUsageInput {
  batchId: string;
  /** 表单原始字符串，由命令内部校验 */
  films: string;
  note?: string;
}

/**
 * 命令二：直接登记一次处理用量（不经预留）。
 * 写入前重新计算可用容量（额定容量 − 已登记用量 − 有效预留）：
 * 数量为空 / 非整数 / 非正整数 / 超过可用容量时返回原因，不写入记录；
 * 成功后追加一条不可修改的使用记录，remainingAfter 记录登记之后的可用容量。
 * 已被有效预留占住的容量不能被直接登记先用掉。
 */
export function recordUsage(
  state: LedgerState,
  input: RecordUsageInput,
  deps: LedgerDeps,
): CommandResult<UsageRecord> {
  const batch = state.batches.find((candidate) => candidate.id === input.batchId);
  if (!batch) {
    return { ok: false, error: '批次不存在或已被移除' };
  }
  const filmsError = validateFilmsInput(input.films);
  if (filmsError) return { ok: false, error: filmsError };

  const films = parseStrictInteger(input.films)!;
  // 每条记录写入前重新计算可用量，而不是沿用界面上的旧值。
  const available = availableCapacity(batch, state);
  if (films > available) {
    return {
      ok: false,
      error: `超过可用容量：本批当前可用 ${available}，无法登记 ${films}`,
    };
  }
  const record: UsageRecord = Object.freeze({
    id: deps.nextId(),
    batchId: batch.id,
    films,
    note: (input.note ?? '').trim(),
    // 记账后的账面剩余（旧字段含义保持不变：额定 − 已登记用量）
    remainingAfter: remainingCapacity(batch, state) - films,
    createdAt: deps.now().toISOString(),
  });
  return {
    ok: true,
    value: record,
    state: { ...state, records: [...state.records, record] },
  };
}

export interface ReserveCapacityInput {
  batchId: string;
  /** 表单原始字符串，由命令内部校验 */
  amount: string;
  note?: string;
}

/**
 * 命令三：冲洗前预留容量。
 * 数量为空 / 非整数 / 非正整数 / 超过当前可用容量（额定 − 已登记 − 已预留）时
 * 返回原因，不写入预留；成功后追加一条有效预留，其他标签页据此看不到这部分容量。
 */
export function reserveCapacity(
  state: LedgerState,
  input: ReserveCapacityInput,
  deps: LedgerDeps,
): CommandResult<CapacityReservation> {
  const batch = state.batches.find((candidate) => candidate.id === input.batchId);
  if (!batch) {
    return { ok: false, error: '批次不存在或已被移除' };
  }
  const amountError = validateReserveAmountInput(input.amount);
  if (amountError) return { ok: false, error: amountError };

  const amount = parseStrictInteger(input.amount)!;
  const available = availableCapacity(batch, state);
  if (amount > available) {
    return {
      ok: false,
      error: `超过可用容量：本批当前可用 ${available}，无法预留 ${amount}`,
    };
  }
  const reservation: CapacityReservation = Object.freeze({
    id: deps.nextId(),
    batchId: batch.id,
    amount,
    note: (input.note ?? '').trim(),
    createdAt: deps.now().toISOString(),
  });
  return {
    ok: true,
    value: reservation,
    state: { ...state, reservations: [...state.reservations, reservation] },
  };
}

export interface SettleReservationInput {
  reservationId: string;
  /**
   * 表单原始字符串：本次实际使用数量。
   * 只接受不超过预留量的正数；未用部分（预留量 − 实际用量）随结算释放。
   */
  films: string;
  /**
   * 结算备注（可选）。
   * 不传时使用记录默认带上预留时的备注，便于把入账记录追溯到那次预留。
   */
  note?: string;
}

/**
 * 命令四：结算预留（终结动作）。
 * 原子地完成「追加不可修改的使用记录 + 移除预留」：
 * - 预留不存在（从未创建或已被结算 / 取消终结）→ 拒绝，重复终结不会二次入账；
 * - 结算数量为空 / 非整数 / 非正整数 / 大于预留量 → 拒绝，预留原样保留，可重试；
 * - 成功后使用记录写入 films（实际用量），预留整体移除，
 *   未用的 amount − films 立刻回到可用容量；
 * - 使用记录的 remainingAfter 与直接登记同口径（额定 − 已登记用量记账后的账面剩余）。
 */
export function settleReservation(
  state: LedgerState,
  input: SettleReservationInput,
  deps: LedgerDeps,
): CommandResult<UsageRecord> {
  const reservation = state.reservations.find((candidate) => candidate.id === input.reservationId);
  if (!reservation) {
    return { ok: false, error: '预留不存在或已终结（已结算或已取消）' };
  }
  const batch = state.batches.find((candidate) => candidate.id === reservation.batchId);
  if (!batch) {
    return { ok: false, error: '批次不存在或已被移除' };
  }
  const filmsError = validateSettleAmountInput(input.films);
  if (filmsError) return { ok: false, error: filmsError };

  const films = parseStrictInteger(input.films)!;
  if (films > reservation.amount) {
    return {
      ok: false,
      error: `结算数量超过预留量：本次预留 ${reservation.amount}，无法结算 ${films}`,
    };
  }

  // 记录追加与预留移除在同一次状态更新里完成（纯函数原子产出新状态），
  // 持久化层再整体写回：任一环失败都不会留下「已结算却无记录 / 记录入账但预留未释放」的半状态。
  const record: UsageRecord = Object.freeze({
    id: deps.nextId(),
    batchId: reservation.batchId,
    films,
    note: input.note === undefined ? reservation.note : input.note.trim(),
    remainingAfter: remainingCapacity(batch, state) - films,
    createdAt: deps.now().toISOString(),
  });
  return {
    ok: true,
    value: record,
    state: {
      ...state,
      records: [...state.records, record],
      reservations: state.reservations.filter((candidate) => candidate.id !== reservation.id),
    },
  };
}

export interface CancelReservationInput {
  reservationId: string;
}

/**
 * 命令五：取消预留（终结动作）。
 * 释放全部预留容量且不生成任何使用记录；
 * 预留不存在（从未创建或已被结算 / 取消终结）时拒绝，避免对同一预留重复终结。
 */
export function cancelReservation(
  state: LedgerState,
  input: CancelReservationInput,
): CommandResult<CapacityReservation> {
  const reservation = state.reservations.find((candidate) => candidate.id === input.reservationId);
  if (!reservation) {
    return { ok: false, error: '预留不存在或已终结（已结算或已取消）' };
  }
  return {
    ok: true,
    value: reservation,
    state: {
      ...state,
      reservations: state.reservations.filter((candidate) => candidate.id !== reservation.id),
    },
  };
}

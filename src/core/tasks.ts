/**
 * Scheduling.
 *
 * A bot needs things to happen later: a giveaway closes at midnight, a reminder
 * fires in twenty minutes, a status post repeats every weekday. `setInterval`
 * covers the trivial case and nothing else — it drifts with event-loop delay,
 * it has no calendar, and a throwing callback silently kills the timer.
 *
 * This module is a scheduler with three kinds of task — fixed interval, one-shot
 * at a wall-clock time, and cron — plus two properties that matter more than the
 * syntax: a failing task is reported and the schedule survives, and every timer
 * is tracked so `dispose()` leaves nothing running.
 *
 * The cron parser handles the standard five fields (minute hour day-of-month
 * month day-of-week) with `*`, lists, ranges, steps and a step-per-N wildcard.
 * Seconds and years are not supported, because a bot that schedules to the
 * second is a bot that will be wrong by a second.
 *
 * Pure Node, no engine import, so it is on the `lite` entry too.
 */

/** Thrown for a cron expression this parser will not accept. */
export class CronError extends Error {
  override readonly name = 'CronError';
}

/** A parsed five-field expression. */
export interface CronSchedule {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>;
  /** True when the day-of-month field was `*` — cron ORs the two day fields. */
  domWildcard: boolean;
  /** True when the day-of-week field was `*`. */
  dowWildcard: boolean;
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
] as const;

/** Expand one cron field into the set of values it matches. */
function parseField(raw: string, min: number, max: number, name: string): Set<number> {
  const values = new Set<number>();

  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (piece === '') throw new CronError(`empty ${name} field`);

    const [rangePart, stepPart, ...rest] = piece.split('/');
    if (rest.length > 0) throw new CronError(`${name}: too many "/" in "${piece}"`);

    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) {
        throw new CronError(`${name}: "${stepPart}" is not a positive step`);
      }
    }

    let start: number;
    let end: number;
    if (rangePart === undefined) {
      throw new CronError(`${name}: "${piece}" has no value`);
    } else if (rangePart === '*') {
      start = min;
      end = max;
    } else {
      const bounds = rangePart.split('-');
      if (bounds.length > 2) throw new CronError(`${name}: "${rangePart}" is not a range`);
      start = Number(bounds[0]);
      end = bounds.length === 2 ? Number(bounds[1]) : start;
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new CronError(`${name}: "${rangePart}" is not a number`);
      }
      // `5/15` in cron means "from 5, every 15", not "5 to 15".
      if (bounds.length === 1 && stepPart !== undefined) end = max;
    }

    if (start < min || start > max || end < min || end > max) {
      throw new CronError(`${name}: ${start}-${end} is outside ${min}-${max}`);
    }
    if (start > end) throw new CronError(`${name}: ${start} is after ${end}`);

    for (let v = start; v <= end; v += step) values.add(v);
  }

  if (values.size === 0) throw new CronError(`${name}: matches nothing`);
  return values;
}

/**
 * Parse a five-field cron expression.
 *
 * Day-of-week accepts 7 as an alias for Sunday and normalises it to 0, which is
 * what every crontab that mentions Sunday means.
 */
export function parseCron(expression: string): CronSchedule {
  const trimmed = expression.trim();
  if (trimmed === '') throw new CronError('empty expression');

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(`expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  }

  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];

  const dayOfWeek = parseField(dow, 0, 7, 'day-of-week');
  if (dayOfWeek.delete(7)) dayOfWeek.add(0);

  return {
    minute: parseField(minute, 0, 59, 'minute'),
    hour: parseField(hour, 0, 23, 'hour'),
    dayOfMonth: parseField(dom, 1, 31, 'day-of-month'),
    month: parseField(month, 1, 12, 'month'),
    dayOfWeek,
    domWildcard: dom === '*',
    dowWildcard: dow === '*',
  };
}

/**
 * Whether the date part of a schedule matches, ignoring time of day.
 *
 * Split out because the day-skipping search needs exactly this question: "is
 * there anything left to fire on this date?" Asking the full matcher instead —
 * which also tests minute and hour — reports a day with a 14:30 slot as
 * uninteresting at 10:16, and the search then skips straight past it.
 *
 * Day fields are OR'd when both are restricted, which is the crontab rule:
 * `0 0 13 * 5` means "the 13th, or any Friday", not "the Friday 13th".
 */
function dayMatches(schedule: CronSchedule, at: Date): boolean {
  if (!schedule.month.has(at.getMonth() + 1)) return false;

  const domMatch = schedule.dayOfMonth.has(at.getDate());
  const dowMatch = schedule.dayOfWeek.has(at.getDay());

  if (schedule.domWildcard && schedule.dowWildcard) return true;
  if (schedule.domWildcard) return dowMatch;
  if (schedule.dowWildcard) return domMatch;
  return domMatch || dowMatch;
}

/** Whether a schedule fires at the given local time, to the minute. */
export function cronMatches(schedule: CronSchedule, at: Date): boolean {
  if (!schedule.minute.has(at.getMinutes())) return false;
  if (!schedule.hour.has(at.getHours())) return false;
  return dayMatches(schedule, at);
}

const MINUTE = 60_000;
/** Four years of minutes: the longest gap a valid five-field cron can have. */
const SEARCH_LIMIT_MINUTES = 4 * 366 * 24 * 60;

/**
 * The next firing time strictly after `from`, or null.
 *
 * Scans minute by minute, but skips whole days the moment the date fields stop
 * matching — otherwise a once-a-year schedule would walk half a million
 * minutes to answer a question with a date in it.
 */
export function nextCronTime(expression: string | CronSchedule, from: Date = new Date()): Date | null {
  const schedule = typeof expression === 'string' ? parseCron(expression) : expression;

  // Start at the next whole minute; a schedule never fires in the past.
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let i = 0; i < SEARCH_LIMIT_MINUTES; i += 1) {
    if (!dayMatches(schedule, cursor)) {
      // Nothing on this date can fire: jump to the next midnight rather than
      // walking minute by minute through a day with no match.
      cursor.setHours(24, 0, 0, 0);
      continue;
    }
    if (schedule.hour.has(cursor.getHours()) && schedule.minute.has(cursor.getMinutes())) {
      return new Date(cursor.getTime());
    }
    cursor.setTime(cursor.getTime() + MINUTE);
  }
  return null;
}

/* ── scheduler ───────────────────────────────────────────────────────── */

export type TaskKind = 'interval' | 'once' | 'cron';

export interface TaskOptions {
  /** Label used in `list()` and in error reports. */
  name?: string;
  /** Run once immediately on registration, in addition to the schedule. */
  immediate?: boolean;
  /** Random extra delay up to this many ms, so tasks do not fire in lockstep. */
  jitterMs?: number;
  /** Called when the task throws or rejects. Defaults to `console.error`. */
  onError?: (error: unknown, task: ScheduledTask) => void;
}

export interface ScheduledTask {
  readonly id: number;
  readonly kind: TaskKind;
  readonly name: string;
  /** Interval in ms for `interval` tasks; null otherwise. */
  readonly everyMs: number | null;
  /** Cron expression for `cron` tasks; null otherwise. */
  readonly cron: string | null;
  /** Fires counted, including failed runs. */
  readonly runs: number;
  /** Runs that threw or rejected. */
  readonly failures: number;
  /** When the task last ran. */
  readonly lastRunAt: number | null;
  /** When the task is next due, or null once a one-shot has fired. */
  nextRunAt(): number | null;
  /** Stop this task. Safe to call more than once. */
  cancel(): void;
}

const jitter = (max: number): number => (max > 0 ? Math.floor(Math.random() * max) : 0);

/** Internal, mutable view of a task — what the scheduler actually holds. */
interface TaskRecord {
  readonly id: number;
  readonly kind: TaskKind;
  readonly name: string;
  readonly everyMs: number | null;
  readonly cron: string | null;
  runs: number;
  failures: number;
  lastRunAt: number | null;
  nextAt: number | null;
  onError?: (error: unknown, task: ScheduledTask) => void;
  /** Timer teardown installed by the registration method. */
  onCancel?: (() => void) | null;
  nextRunAt(): number | null;
  cancel(): void;
}

export class Scheduler {
  #tasks = new Map<number, TaskRecord>();
  #nextId = 1;
  #disposed = false;
  readonly #defaultOnError: (error: unknown, task: ScheduledTask) => void;

  constructor(options: { onError?: (error: unknown, task: ScheduledTask) => void } = {}) {
    this.#defaultOnError =
      options.onError ??
      ((error, task) => {
        console.error(`[scheduler] task "${task.name}" failed`, error);
      });
  }

  get size(): number {
    return this.#tasks.size;
  }

  /**
   * Run `fn` every `everyMs` milliseconds.
   *
   * A fixed rate, not a fixed delay: a slow task does not push the next one
   * further out. Missed ticks after a long pause are not caught up — a schedule
   * that fires a hundred times at once after the process was frozen is worse
   * than one that skips.
   */
  every(everyMs: number, fn: () => void | Promise<void>, options: TaskOptions = {}): ScheduledTask {
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      throw new RangeError(`every: interval must be positive, got ${everyMs}`);
    }
    this.#assertLive();

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const record = this.#makeRecord({
      kind: 'interval',
      name: options.name ?? `every ${everyMs}ms`,
      everyMs,
      cron: null,
      onError: options.onError,
    });

    const arm = (): void => {
      if (cancelled) return;
      const delay = everyMs + jitter(options.jitterMs ?? 0);
      record.nextAt = Date.now() + delay;
      timer = setTimeout(tick, delay);
      timer.unref?.();
    };

    const tick = (): void => {
      if (cancelled) return;
      // Re-arm before running: a task that throws must not take the schedule
      // with it, and a task that takes a second must not double up.
      arm();
      void this.#run(record, fn);
    };

    record.onCancel = () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      record.nextAt = null;
    };
    arm();

    if (options.immediate) void this.#run(record, fn);
    return record;
  }

  /** Run `fn` once, at a wall-clock time (Date, epoch ms, or parseable string). */
  at(
    when: Date | number | string,
    fn: () => void | Promise<void>,
    options: TaskOptions = {},
  ): ScheduledTask {
    this.#assertLive();
    const target = when instanceof Date ? when : new Date(when);
    if (Number.isNaN(target.getTime())) {
      throw new RangeError(`at: "${String(when)}" is not a date`);
    }

    const record = this.#makeRecord({
      kind: 'once',
      name: options.name ?? `at ${target.toISOString()}`,
      everyMs: null,
      cron: null,
      onError: options.onError,
    });

    const delay = Math.max(0, target.getTime() - Date.now());
    record.nextAt = Date.now() + delay;
    const timer = setTimeout(() => {
      record.nextAt = null;
      // Drop it from the registry before running, so a task that inspects
      // `list()` does not see itself still pending.
      this.#tasks.delete(record.id);
      void this.#run(record, fn);
    }, delay);
    timer.unref?.();

    record.onCancel = () => {
      clearTimeout(timer);
      record.nextAt = null;
    };
    return record;
  }

  /**
   * Run `fn` on a five-field cron schedule.
   *
   * Each firing re-reads the clock rather than adding a fixed 24h, so the job
   * tracks DST and stays on the wall-clock minute it was written for.
   */
  cron(
    expression: string,
    fn: () => void | Promise<void>,
    options: TaskOptions = {},
  ): ScheduledTask {
    this.#assertLive();
    // Fail on registration, not at the first tick.
    const schedule = parseCron(expression);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const record = this.#makeRecord({
      kind: 'cron',
      name: options.name ?? `cron ${expression}`,
      everyMs: null,
      cron: expression,
      onError: options.onError,
    });

    const arm = (): void => {
      if (cancelled) return;
      const next = nextCronTime(schedule);
      if (!next) return; // no future match: stay idle rather than spin

      const delay = Math.max(0, next.getTime() - Date.now());
      record.nextAt = Date.now() + delay;
      timer = setTimeout(
        () => {
          timer = null;
          if (cancelled) return;
          void this.#run(record, fn).finally(() => arm());
        },
        delay,
      );
      timer.unref?.();
    };

    record.onCancel = () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      record.nextAt = null;
    };
    arm();
    return record;
  }

  /** Run `fn` every `ms`, starting now, with the jitter a fleet needs. */
  heartbeat(ms: number, fn: () => void | Promise<void>, options: TaskOptions = {}): ScheduledTask {
    return this.every(ms, fn, { name: 'heartbeat', ...options, jitterMs: options.jitterMs ?? ms / 4, immediate: true });
  }

  #makeRecord(spec: {
    kind: TaskKind;
    name: string;
    everyMs: number | null;
    cron: string | null;
    onError?: (error: unknown, task: ScheduledTask) => void;
  }): TaskRecord {
    const self = this;
    const record: TaskRecord = {
      id: this.#nextId++,
      kind: spec.kind,
      name: spec.name,
      everyMs: spec.everyMs,
      cron: spec.cron,
      runs: 0,
      failures: 0,
      lastRunAt: null,
      nextAt: null,
      onError: spec.onError,
      nextRunAt(): number | null {
        return this.nextAt;
      },
      cancel(): void {
        this.onCancel?.();
        this.onCancel = null;
        self.#tasks.delete(this.id);
      },
    };

    this.#tasks.set(record.id, record);
    return record;
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error('scheduler is disposed');
  }

  /**
   * Run a task body, absorbing failure.
   *
   * A rejected promise that nobody handles terminates the process, so this is
   * not defensive coding — it is the only reason a failing job does not take the
   * bot down with it.
   */
  async #run(record: TaskRecord, fn: () => void | Promise<void>): Promise<void> {
    record.runs += 1;
    record.lastRunAt = Date.now();
    try {
      await fn();
    } catch (error) {
      record.failures += 1;
      try {
        (record.onError ?? this.#defaultOnError)(error, record);
      } catch {
        /* a failing error handler must not become an unhandled rejection */
      }
    }
  }

  /** Live tasks, in registration order. */
  list(): ScheduledTask[] {
    return [...this.#tasks.values()];
  }

  get(id: number): ScheduledTask | undefined {
    return this.#tasks.get(id);
  }

  cancel(id: number): boolean {
    const task = this.#tasks.get(id);
    if (!task) return false;
    task.cancel();
    this.#tasks.delete(id);
    return true;
  }

  /** Stop everything. Safe to call twice. */
  dispose(): void {
    this.#disposed = true;
    for (const task of [...this.#tasks.values()]) task.cancel();
    this.#tasks.clear();
  }
}

/**
 * 界面会话（``notes/web-design.md`` §5.5）—— **所有逻辑都在这儿，``.vue`` 只画**。
 *
 * 为什么逻辑不写在 ``.vue`` 里
 * --------------------------
 * ``.vue`` 现在**会被** ``vue-tsc`` 检查（见 ``notes/web-design.md`` §5.7），但规则仍然全放这里：
 * 这一层是纯 TS、不碰 DOM，能在 ``node`` 里被 ``tests/ui_session.test.ts`` 毫秒级钉住，
 * 而同样的断言搬进 DOM 既慢又会因为改样式而红。
 * 所以凡是「错了会静默算错」的东西
 * （取值 / 校验 / 取消 / 进度 / URL 同步 / 自动回填）一律放这里，
 * ``.vue`` 只负责把 ref 摆到 DOM 上、把点击接到方法上。
 *
 * 职责边界
 * --------
 * * **不碰 DOM**：不 ``querySelector``、不 ``focus``，也不读 ``location``
 *   （hash 由调用方通过 :meth:`UiSession.boot` 传进来，分享链接的基地址由
 *   ``options.href`` 提供）—— 这样整套状态机能在 ``node`` 里跑测试。
 * * **不碰 wasm 细节**：只调 :meth:`Scenario.run` / ``searchOptions`` /
 *   ``searchContext`` / ``advance`` 这些公开契约（§5.1）。
 *
 * 三条硬纪律（§5.6）
 * -----------------
 * 1. ``WasmRuntime`` / ``SearchPool`` / ``SeedSpec`` / 999 长的种子数组**绝不进
 *    ``reactive()``**：本类里它们都是普通字段（不挂任何响应式包装），只有
 *    ``Outcome`` 这个**纯数据**快照会进 :class:`ShallowRef`。
 * 2. 种子列表**不在 ``computed`` 里派生**：渲染用 ``result.ts`` 的
 *    ``seedText`` / ``seedListLines``，一次算完。
 * 3. 详情页的 JSON **切到那一页才算**（:meth:`UiSession.detailJson` 是方法不是
 *    ``computed``）。
 */

import {
  computed,
  ref,
  shallowRef,
  type ComputedRef,
  type Ref,
  type ShallowRef,
} from "vue";

import { Canceled } from "../core/errors";
import { CancelToken, type Progress } from "../core/progress";
import { allScenarios, getScenario } from "../scenarios/registry";
import { Note } from "../scenarios/scenario";
import type { InputField, InputSchema, Outcome, Scenario } from "../scenarios/scenario";
import type { WasmRuntime } from "../wasm/runtime";
import type { SearchPool } from "../worker/pool";
import {
  collect,
  firstErrorField,
  formGroups,
  initialForm,
  issues,
  mergeNotes,
  startSeedOf,
  writeForm,
  type FormGroup,
  type RawForm,
} from "./form";
import {
  conclusionOf,
  noteLines,
  previewView,
  seedBarText,
  tableRows,
  detailJson as renderDetailJson,
  type NoteLine,
  type PanelState,
  type PreviewView,
  type ResultRow,
} from "./result";
import {
  buildHash,
  decodeParams,
  encodeParams,
  formVersion,
  parseHash,
  shareUrl,
} from "./url";

/** 后端下拉里的可选项。Web 侧只有一份产物，所以只有一项。 */
export const BACKENDS: readonly string[] = Object.freeze(["wasm"]);

/** 日志最多留多少行（再多就丢掉最老的）。 */
export const LOG_LIMIT = 500;

/** 会话的构造参数。 */
export interface SessionOptions {
  /** 已加载好的 wasm 运行时；``null`` = 还在加载 / 加载失败（跑起来会给提示）。 */
  runtime?: WasmRuntime | null;
  /** worker 池；``null`` = 全同步（结果与并行逐位一致）。 */
  pool?: SearchPool | null;
  /** 取「当前页面地址」的函数（分享链接用）。默认读 ``location.href``。 */
  href?: () => string;
}

/** ``input type=number`` 上该写什么。非数值类型返回 ``null``（不写这两个属性）。 */
export function numericBounds(field: InputField): { min: number | null; max: number | null } {
  if (field.kind !== "int" && field.kind !== "float") return { min: null, max: null };
  return { min: field.min, max: field.max };
}

/** 界面会话：一个场景 + 一张表单 + 一轮运行的全部状态。 */
export class UiSession {
  /** 已注册的场景（下拉框的选项，顺序 = ``BUILTIN_ORDER``）。 */
  readonly scenarios: readonly Scenario[];
  /** 当前场景。 */
  readonly scenario: ShallowRef<Scenario>;
  /** 控件里的**原始**值（``string`` / ``boolean``）；提交时才转成输入值。 */
  readonly raw: Ref<RawForm>;
  /** 打开链接时解出来的提示（``warning``）。**下一轮运行前一直显示**。 */
  readonly linkNotes: Ref<readonly Note[]>;
  /** 最近一轮的提示（校验 + 场景 + 结果）。 */
  readonly notes: Ref<readonly Note[]>;
  /** 结果面板状态。 */
  readonly state: ShallowRef<PanelState>;
  /** 最近一次进度上报（``null`` = 没有在跑）。 */
  readonly progress: ShallowRef<Progress | null>;
  /** 有任务在跑（工具栏据此锁控件）。 */
  readonly running: Ref<boolean>;
  /** 已经点过「取消」但当前分段还没结束。 */
  readonly cancelRequested: Ref<boolean>;
  /** 最近一次运行的耗时（毫秒）。 */
  readonly lastMs: Ref<number | null>;
  /** 运行日志（新的一行在最后）。 */
  readonly log: Ref<string[]>;
  /** 需要聚焦的字段 key（出错时设置，``null`` = 不用动焦点）。 */
  readonly focusField: Ref<string | null>;
  /** wasm 加载失败的原因（非空时状态栏显示它）。 */
  readonly loadError: Ref<string>;
  /** 后端的自描述（``WasmRuntime.describe()``）；空 = 还没加载好。 */
  readonly runtimeInfo: Ref<string>;

  /** 后端下拉的当前值。 */
  readonly backend: Ref<string>;

  private readonly href: () => string;
  private wasm: WasmRuntime | null;
  private searchPool: SearchPool | null;
  private cancelToken: CancelToken | null = null;
  private seq = 0;

  constructor(options: SessionOptions = {}) {
    this.wasm = options.runtime ?? null;
    this.searchPool = options.pool ?? null;
    this.href = options.href ?? (() => (typeof location === "undefined" ? "" : location.href));

    this.scenarios = allScenarios();
    const first = this.scenarios[0];
    if (!first) {
      throw new Error(
        "场景注册表是空的：忘了 import \"./scenarios/index\"？它是注册场景的唯一入口",
      );
    }
    this.scenario = shallowRef(first);
    this.raw = ref<RawForm>(initialForm(first.schema()));
    this.linkNotes = shallowRef<readonly Note[]>([]);
    this.notes = shallowRef<readonly Note[]>([]);
    this.state = shallowRef<PanelState>({ kind: "idle" });
    this.progress = shallowRef<Progress | null>(null);
    this.running = ref(false);
    this.cancelRequested = ref(false);
    this.lastMs = ref<number | null>(null);
    this.log = ref<string[]>([]);
    this.focusField = ref<string | null>(null);
    this.loadError = ref("");
    this.runtimeInfo = ref("");
    this.backend = ref(BACKENDS[0] as string);
  }

  // ================================================================= 派生（纯）
  get schema(): ComputedRef<InputSchema> {
    return this._schema ??= computed(() => this.scenario.value.schema());
  }
  private _schema: ComputedRef<InputSchema> | undefined;

  /** 参数区要画的分组（已剔除工具栏字段，§5.3 规则 2/3）。 */
  get groups(): ComputedRef<FormGroup[]> {
    return this._groups ??= computed(() => formGroups(this.onFormSchema.value));
  }
  private _groups: ComputedRef<FormGroup[]> | undefined;

  /**
   * 属于窗口工具栏的字段（``toolbar && kind === "bool"``）。
   *
   * ⚠️ **当前一个都没有** —— 最后一个（``strength.auto_upshift``）和「枚举全部」
   * 一样搬回了参数栏，所以工具栏那段勾选框渲染是**空转**的。机制留着，是因为
   * ``toolbar`` 还是 schema 契约的一部分。
   */
  get toolbarFields(): ComputedRef<readonly InputField[]> {
    return this._toolbar ??= computed(() =>
      this.schema.value.fields.filter((f) => f.inToolbar),
    );
  }
  private _toolbar: ComputedRef<readonly InputField[]> | undefined;

  /** ``schema.onForm()``：剔掉工具栏字段后的表单。 */
  get onFormSchema(): ComputedRef<InputSchema> {
    return this._onForm ??= computed(() => this.schema.value.onForm());
  }
  private _onForm: ComputedRef<InputSchema> | undefined;

  /** 控件值 → 场景输入值（坏字段回落到默认值 + 记一条 ``FieldProblem``）。 */
  get collected(): ComputedRef<{ inputs: Record<string, unknown>; errors: Note[] }> {
    return this._collected ??= computed(() => {
      const { inputs, errors } = collect(this.schema.value, this.raw.value);
      return {
        inputs,
        errors: errors.map((e) => new Note({ level: "error", message: e.message, field: e.key })),
      };
    });
  }
  private _collected: ComputedRef<{ inputs: Record<string, unknown>; errors: Note[] }> | undefined;

  /** 当前输入值（每次改动都会重算；够快，纯函数）。 */
  get inputs(): ComputedRef<Record<string, unknown>> {
    return this._inputs ??= computed(() => this.collected.value.inputs);
  }
  private _inputs: ComputedRef<Record<string, unknown>> | undefined;

  /** 字段右边的动态展示值（``Scenario.fieldHints``，永不抛）。 */
  get hints(): ComputedRef<Readonly<Record<string, string>>> {
    return this._hints ??= computed(() => {
      try {
        return this.scenario.value.fieldHints(this.inputs.value);
      } catch (exc) {
        this.logLine(`fieldHints 抛了异常（已忽略）：${String(exc)}`);
        return {};
      }
    });
  }
  private _hints: ComputedRef<Readonly<Record<string, string>>> | undefined;

  /** 出错的字段集合（标签标红）。 */
  get badFields(): ComputedRef<ReadonlySet<string>> {
    return this._bad ??= computed(() => {
      const bad = new Set<string>();
      for (const group of [this.linkNotes.value, this.notes.value]) {
        for (const note of group) if (note.isError && note.field) bad.add(note.field);
      }
      return bad;
    });
  }
  private _bad: ComputedRef<ReadonlySet<string>> | undefined;

  /** 一句结论。 */
  get conclusion(): ComputedRef<{ text: string; danger: boolean }> {
    return this._conclusion ??= computed(() => conclusionOf(this.state.value));
  }
  private _conclusion: ComputedRef<{ text: string; danger: boolean }> | undefined;

  /** 有结果时的 ``Outcome``（没有就是 ``null``）。 */
  get outcome(): ComputedRef<Outcome | null> {
    return this._outcome ??= computed(() => {
      const state = this.state.value;
      return state.kind === "done" ? state.outcome : null;
    });
  }
  private _outcome: ComputedRef<Outcome | null> | undefined;

  /** 键值表的行。 */
  get rows(): ComputedRef<ResultRow[]> {
    return this._rows ??= computed(() => {
      const found = this.outcome.value;
      return found === null ? [] : tableRows(found);
    });
  }
  private _rows: ComputedRef<ResultRow[]> | undefined;

  /** 属性预览页该画什么。 */
  get preview(): ComputedRef<PreviewView> {
    return this._preview ??= computed(() => {
      const found = this.outcome.value;
      return found === null ? { kind: "blank" } : previewView(found);
    });
  }
  private _preview: ComputedRef<PreviewView> | undefined;

  /** 提示页的行（来源 = 链接提示 + 本轮提示）。 */
  get noteLinesView(): ComputedRef<NoteLine[]> {
    return this._noteLines ??= computed(() =>
      noteLines(mergeNotes(this.linkNotes.value, this.notes.value)),
    );
  }
  private _noteLines: ComputedRef<NoteLine[]> | undefined;

  /** 种子条那一行的文本（``null`` = 没有候选）。 */
  get seedBar(): ComputedRef<string | null> {
    return this._seedBar ??= computed(() => {
      const found = this.outcome.value;
      return found === null ? null : seedBarText(found.seeds);
    });
  }
  private _seedBar: ComputedRef<string | null> | undefined;

  /** 进度条的百分比；``null`` = 不定长（``total === 0`` 或还没开始）。 */
  get progressPercent(): ComputedRef<number | null> {
    return this._percent ??= computed(() => {
      const p = this.progress.value;
      if (!this.running.value || p === null || p.total <= 0) return null;
      return p.percent;
    });
  }
  private _percent: ComputedRef<number | null> | undefined;

  /** 状态栏那一行。 */
  get statusText(): ComputedRef<string> {
    return this._status ??= computed(() => {
      if (this.loadError.value) return this.loadError.value;
      if (this.cancelRequested.value) return "已请求取消，正在等当前分段结束…";
      const p = this.progress.value;
      if (this.running.value) {
        if (p === null) return "运行中…";
        const head = p.message ? `${p.message} ` : "";
        if (p.total > 0) return `${head}${p.done}/${p.total}（${p.percent.toFixed(1)}%）`;
        return `${head}${p.done}`;
      }
      const ms = this.lastMs.value;
      if (ms === null) return "就绪";
      return `${this.conclusion.value.text} · ${ms.toFixed(0)} ms`;
    });
  }
  private _status: ComputedRef<string> | undefined;

  // ================================================================= 生命周期
  /**
   * 后端加载完成后注入运行时。
   *
   * 加载**失败**也走这里一条路（``error`` 非空）—— 界面照常可用，跑的时候给一句
   * 明确的「没有后端」，而不是白屏。
   */
  setRuntime(runtime: WasmRuntime | null, pool: SearchPool | null = null, error = ""): void {
    this.wasm = runtime;
    this.searchPool = pool;
    this.loadError.value = error;
    if (runtime !== null) {
      try {
        this.runtimeInfo.value = runtime.describe();
      } catch (exc) {
        this.runtimeInfo.value = "";
        this.logLine(`describe() 失败（已忽略）：${String(exc)}`);
      }
      if (this.runtimeInfo.value) this.logLine(this.runtimeInfo.value);
    }
    if (error) this.logLine(`后端不可用：${error}`);
  }

  /**
   * 从 URL 恢复（页面加载时调一次）。
   *
   * 顺序很重要：**先**按 hash 里的 key 切场景，**再**用**那个场景的 schema** 解参数，
   * 最后把 hash 规范化写回去（顺手去掉不认识的键）。任何一步失败都只记日志、不抛
   * —— 一个手改坏了的链接不该白屏。
   */
  boot(hash: string): void {
    const route = parseHash(hash);
    if (route.key) {
      try {
        const next = getScenario(route.key);
        this.applyScenario(next, initialForm(next.schema()));
      } catch (exc) {
        this.logLine(
          `链接里的场景「${route.key}」不认识（${exc instanceof Error ? exc.message : String(exc)}），已退回 ${this.scenario.value.key}`,
        );
      }
    }
    const decoded = decodeParams(this.schema.value, route.params, formVersion(this.scenario.value));
    if (decoded.restored > 0) {
      this.raw.value = writeForm(this.schema.value, this.raw.value, decoded.inputs);
    }
    this.linkNotes.value = decoded.notes;
    for (const note of decoded.notes) this.logLine(`[链接] ${note.message}`);
    if (decoded.restored > 0) this.logLine(`从链接恢复了 ${decoded.restored} 个字段（不自动开跑）`);
    this.syncHash();
  }

  /** 切场景（工具栏下拉）。运行中忽略。 */
  selectScenario(key: string): void {
    if (this.running.value) {
      this.logLine("有任务在跑，忽略切换场景");
      return;
    }
    let next: Scenario;
    try {
      next = getScenario(key);
    } catch (exc) {
      this.logLine(String(exc instanceof Error ? exc.message : exc));
      return;
    }
    if (next === this.scenario.value) return;
    this.applyScenario(next, initialForm(next.schema()));
    this.linkNotes.value = [];
    this.syncHash();
  }

  /** 重置表单到默认值（不动场景、不清日志）。 */
  reset(): void {
    if (this.running.value) {
      this.logLine("有任务在跑，忽略重置");
      return;
    }
    this.raw.value = initialForm(this.schema.value);
    this.notes.value = [];
    this.linkNotes.value = [];
    this.state.value = { kind: "idle" };
    this.progress.value = null;
    this.lastMs.value = null;
    this.focusField.value = null;
    this.syncHash();
  }

  /** 改一个控件的值（``.vue`` 的输入事件接到这儿）。 */
  setValue(key: string, value: string | boolean): void {
    this.raw.value = { ...this.raw.value, [key]: value };
  }

  // ================================================================= 运行
  /** 收集一次校验结果（不跑）。出错时把焦点指向最靠上的坏字段。 */
  validateNow(): readonly Note[] {
    const scenario = this.scenario.value;
    const inputs = this.inputs.value;
    const merged = mergeNotes(
      this.collected.value.errors,
      issues(this.schema.value, inputs),
      scenario.validate(inputs),
    );
    this.notes.value = merged;
    this.focusField.value = firstErrorField(this.schema.value, [merged]);
    return merged;
  }

  /**
   * 跑一轮。
   *
   * **全局互斥**：wasm 实例内部有 scratch 等可变状态，同时只允许一个任务 —— 忙时
   * 直接拒绝并记日志（不是排队）。任何异常都变成 ``failed`` 状态并复位 UI，
   * 否则界面会永远卡在「运行中」。
   */
  async run(): Promise<void> {
    if (this.running.value) {
      this.logLine("已有任务在跑，这次提交被拒绝（wasm 同一时刻只支持一轮）");
      return;
    }
    const scenario = this.scenario.value;
    const schema = this.schema.value;
    const inputs = this.inputs.value;

    const merged = this.validateNow();
    if (merged.some((n) => n.isError)) {
      const count = merged.filter((n) => n.isError).length;
      this.logLine(`校验未通过（${count} 项），没有开跑`);
      this.syncHash();
      return;
    }

    const runtime = this.wasm;
    if (runtime === null) {
      const message = this.loadError.value || "还没有可用的 wasm 后端：页面刚打开时请等加载完成";
      this.state.value = { kind: "failed", message };
      this.notes.value = mergeNotes(merged, [new Note({ level: "error", message })]);
      this.logLine(`失败：${message}`);
      return;
    }

    const token = new CancelToken();
    this.cancelToken = token;
    this.cancelRequested.value = false;
    this.running.value = true;
    this.state.value = { kind: "idle" };
    this.progress.value = null;
    this.seq += 1;
    this.logLine(`#${this.seq} 开始：${scenario.key} · 起始种子 ${startSeedOf(inputs)}`);

    const ctx = scenario.searchContext(scenario.searchOptions(inputs));
    ctx.cancelToken = token;
    ctx.progressCb = (p) => {
      this.progress.value = p;
    };

    const t0 = performance.now();
    try {
      const outcome = await scenario.run(inputs, startSeedOf(inputs), {
        backend: runtime,
        pool: this.searchPool,
        ctx,
      });
      const ms = performance.now() - t0;
      this.state.value = { kind: "done", outcome };
      this.notes.value = mergeNotes(merged, outcome.notes);
      this.lastMs.value = ms;
      this.logLine(`#${this.seq} 完成：${conclusionOf(this.state.value).text} · ${ms.toFixed(0)} ms`);
      // 「算完自动准备下一轮」：只有声明了 advance() 的场景才回填（今天只有 strength）。
      const next = scenario.advance(outcome, inputs);
      if (next !== null) {
        this.raw.value = writeForm(schema, this.raw.value, next);
        this.logLine(`#${this.seq} 已按场景规则回填下一轮参数`);
      }
    } catch (exc) {
      if (exc instanceof Canceled) {
        this.notes.value = mergeNotes(merged, [
          new Note({ level: "warning", message: "搜索已取消" }),
        ]);
        this.logLine(`#${this.seq} 已取消`);
      } else {
        const message = exc instanceof Error ? exc.message : String(exc);
        this.state.value = { kind: "failed", message };
        this.notes.value = mergeNotes(merged, [new Note({ level: "error", message })]);
        this.lastMs.value = performance.now() - t0;
        this.logLine(`#${this.seq} 失败：${message}`);
      }
    } finally {
      this.running.value = false;
      this.cancelRequested.value = false;
      this.cancelToken = null;
      this.progress.value = null;
      this.syncHash();
    }
  }

  /** 请求取消。只有一次运行真的在跑时才有效。 */
  cancel(): void {
    const token = this.cancelToken;
    if (token === null) {
      this.logLine("当前没有在跑的任务");
      return;
    }
    if (this.cancelRequested.value) return;
    this.cancelRequested.value = true;
    token.cancel();
    this.logLine("已请求取消，正在等当前分段结束…");
  }

  // ================================================================= 其它
  /** 分享链接（**点了才读一次当前输入**，不要挂进 ``v-model`` 监听里）。 */
  shareLink(): string {
    return shareUrl(
      this.href(),
      this.scenario.value.key,
      this.schema.value,
      this.inputs.value,
      formVersion(this.scenario.value),
    );
  }

  /** 详情页的 JSON —— **切到那一页再调**（§5.6 第 3 条）。 */
  detailJson(): string {
    const found = this.outcome.value;
    return found === null ? "" : renderDetailJson(found);
  }

  /** 「查后端」：把当前后端的自描述写进日志（Web 侧只有 wasm 一个后端）。 */
  probeBackend(): void {
    const info = this.runtimeInfo.value;
    const pool = this.searchPool === null ? "没有 worker 池（全同步）" : `worker 池 ${this.searchPool.size} 个`;
    this.logLine(`后端 ${this.backend.value} · ${pool}`);
    this.logLine(info || `后端还没就绪${this.loadError.value ? `：${this.loadError.value}` : ""}`);
  }

  /** 把当前输入写回 hash（``replaceState``：**不新增历史项**，§5.8）。 */
  syncHash(): void {
    if (typeof history === "undefined" || typeof location === "undefined") return;
    const hash = buildHash(
      this.scenario.value.key,
      encodeParams(this.schema.value, this.inputs.value, formVersion(this.scenario.value)),
    );
    try {
      history.replaceState(null, "", hash);
    } catch (exc) {
      this.logLine(`同步 URL 失败（已忽略）：${String(exc)}`);
    }
  }

  logLine(text: string): void {
    const stamp = new Date().toISOString().slice(11, 19);
    const next = [...this.log.value, `${stamp}  ${text}`];
    this.log.value = next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next;
  }

  private applyScenario(next: Scenario, raw: RawForm): void {
    this.scenario.value = next;
    this.raw.value = raw;
    this.notes.value = [];
    this.state.value = { kind: "idle" };
    this.progress.value = null;
    this.lastMs.value = null;
    this.focusField.value = null;
  }
}

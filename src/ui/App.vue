<script setup lang="ts">
/**
 * 界面外壳（``notes/web-design.md`` §5.2）—— **只摆 DOM、只接事件，不含任何规则**。
 *
 * ✅ ``typecheck`` 是 ``vue-tsc --noEmit``（§5.7），所以**这个文件也在类型检查范围内**。
 * 但规矩没变：「怎么取值 / 怎么校验 / 怎么取消 / 什么时候写 URL」全部在 :mod:`./session`、
 * :mod:`./form`、:mod:`./result`、:mod:`./url` 这四个纯 TS 模块里 —— 它们能在 ``node`` 下
 * 被 ``tests/ui_*.test.ts`` 毫秒级钉住（**别在这里写死测试条数**，每加一条就过时一次）。
 * 这边只由 ``tests/ui_app.test.ts``（happy-dom + @vue/test-utils）钉**接线**，不重复钉规则。
 * 这里只允许出现三种东西：
 *
 * 1. 把 ``UiSession`` 的 ref 转成模板能用的绑定（``<script setup>`` 顶层 ref 会被
 *    自动解包，所以 ``raw`` 在模板里直接就是那个对象）；
 * 2. 把 DOM 事件翻译成 ``session.setValue / run / cancel / reset`` 调用；
 * 3. 布局与样式。
 *
 * 性能纪律（§5.6）：``Outcome`` 是纯数据快照，可以进 ``computed``；``WasmRuntime`` /
 * ``SearchPool`` / ``SeedSpec`` / 999 长的种子数组**不在这个文件里出现**（它们在
 * :mod:`./session` 里是普通字段，没挂响应式）。详情页的 JSON 只在切到那一页时算
 * （``detailText``），全量种子只在弹层里按 400 个一块渲染。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import type { InputField } from "../scenarios/scenario";
import { inlineIconUri } from "../singlefile";
import { entryWidth, helpOf, hintOf, hintProblemOf } from "./form";
import {
  backendLabel,
  LEVEL_LABEL,
  NOTES_EMPTY,
  PREVIEW_EMPTY,
  SEED_CHUNK,
  SEED_EMPTY,
  seedListLines,
} from "./result";
import { BACKENDS, UiSession } from "./session";

const props = defineProps<{ session: UiSession }>();
const s = props.session;

// ------------------------------------------------------------------ 绑定
const scenario = computed(() => s.scenario.value);
const scenarios = s.scenarios;
const groups = computed(() => s.groups.value);
const toolbarFields = computed(() => s.toolbarFields.value);
const raw = s.raw;
const hints = computed(() => s.hints.value);
const hintIssues = computed(() => s.hintIssues.value);
const bad = computed(() => s.badFields.value);
const busy = computed(() => s.running.value);
const state = computed(() => s.state.value);
const outcome = computed(() => s.outcome.value);
const conclusion = computed(() => s.conclusion.value);
const rows = computed(() => s.rows.value);
const preview = computed(() => s.preview.value);
const noteLines = computed(() => s.noteLinesView.value);
const seedBar = computed(() => s.seedBar.value);
const logs = computed(() => s.log.value);
const status = computed(() => s.statusText.value);
const pct = computed(() => s.progressPercent.value);
const elapsed = computed(() => s.lastMs.value);
const failMessage = computed(() => (state.value.kind === "failed" ? state.value.message : ""));
const backend = computed({
  get: () => s.backend.value,
  set: (value: string) => {
    s.backend.value = value;
  },
});
const emblemSrc = computed(() => inlineIconUri() ?? "./assets/zm3_icon.png");

// ------------------------------------------------------------------ 表单
function onValue(event: Event, key: string): void {
  const el = event.target as HTMLInputElement | HTMLSelectElement;
  s.setValue(key, el.value);
}

function onBool(event: Event, key: string): void {
  const el = event.target as HTMLInputElement;
  s.setValue(key, el.checked);
}

function onScenario(event: Event): void {
  s.selectScenario((event.target as HTMLSelectElement).value);
}

function widthOf(field: InputField): string {
  return `${entryWidth(field)}ch`;
}

/**
 * 控件类型：只有 ``int`` 用 ``<input type="number">``。
 *
 * ⚠️ ``float``（成长和）**必须**是 ``text``。``type="number"`` 上小数点能不能打进
 * 由**引擎 / locale** 决定：本机实测 Chromium 在 ``6.`` 这个中间态下 ``value`` 只读到 ``6``，
 * 另一些引擎直接吞掉这个键（用户看到的就是「按下 `.` 不出现，光标反而往左退一格」）。
 * 而解析本来就全走 :func:`coerce`（NFKC 归一 + ``Number``），不需要原生 number 语义。
 */
function typeOf(field: InputField): string {
  return field.kind === "int" ? "number" : "text";
}
/** 软键盘类型：``text`` 的小数框不写这个会在手机上弹字母键盘。 */
function inputModeOf(field: InputField): "decimal" | undefined {
  return field.kind === "float" ? "decimal" : undefined;
}
/** ``min`` / ``max`` 只写在 ``type="number"``（即 ``int``）上 —— 文本控件不认这两个属性。 */
function minOf(field: InputField): number | undefined {
  return typeOf(field) === "number" ? (field.min ?? undefined) : undefined;
}
function maxOf(field: InputField): number | undefined {
  return typeOf(field) === "number" ? (field.max ?? undefined) : undefined;
}
function hintTextOf(field: InputField): string {
  // 「这一格为什么算不出来」优先于「正常时该显示什么」—— 填错的那几格用短原因
  // 取代展示值本身，其余格子不受影响（`fieldHintIssues` 是逐属性判据）。
  return hintProblemOf(hintIssues.value, field.key) ?? hintOf(hints.value, field.key);
}
function isBad(key: string): boolean {
  return bad.value.has(key);
}
/** 展示值那一格自己填错了（与 `isBad`「运行校验失败」不是一回事）。 */
function isHintBad(key: string): boolean {
  return hintProblemOf(hintIssues.value, key) !== undefined;
}

/** 底部提示条：鼠标划过 / 聚焦过的字段的静态说明（``field.help``，与动态展示值分开）。 */
const hintKey = ref<string | null>(null);
const hintBarText = computed(() => {
  const key = hintKey.value;
  if (key === null) return "F7 = 运行，Esc = 取消；「复制分享链接」可以把当前参数发给别人";
  const field = s.schema.value.get(key);
  return field === null ? "" : helpOf(field);
});

// ------------------------------------------------------------------ 焦点
watch(
  () => s.focusField.value,
  (key) => {
    if (key === null) return;
    const el = document.querySelector<HTMLElement>(`[data-field="${key}"]`);
    if (el === null) return;
    el.focus();
    // ⚠️ 不要用 ``el.scrollIntoView()``：它会把**所有**祖先滚动容器都滚一遍 —— 而老
    // Blink（Chromium 70）会给 ``overflow:hidden`` 的 ``.shell`` 算出 phantom 溢出
    // （``scrollHeight`` 比 ``clientHeight`` 大几像素），``overflow:hidden`` 盒子按规范
    // **可以被编程滚动** ⇒ 整个外壳被顶出视口，看起来就是「内容一多界面就错位」。
    // 所以手动只滚字段所在的窗格（rect 中心差 + ``scrollTop``），绝不波及祖先。
    const pane = el.closest(".scroll") ?? el.closest(".tabbody");
    if (pane !== null) {
      const paneRect = pane.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      pane.scrollTop += elRect.top + elRect.height / 2 - (paneRect.top + paneRect.height / 2);
    }
  },
);

// ------------------------------------------------------------------ 外壳滚动锁死
/**
 * 老内核（Chromium 70）会 phantom 溢出 × ``overflow:hidden`` 可编程滚动 ⇒ 任何走
 * ``scrollIntoView`` / 焦点 / 锚点的代码路径都可能把 ``.shell`` 或根滚动器顶出对齐。
 * 实测 **CSS 全线无效**（``min-height:0`` / ``overflow:hidden`` / ``sticky`` 都压不住），
 * 只能兜底：shell 与 window 各挂一个 ``scroll`` 监听把位置按回 0，再配 **rAF 轮询** ——
 * Chrome 70 里被编程滚动的 ``overflow:hidden`` 盒子**不派发 ``scroll`` 事件**，
 * 只靠事件会漏（实测确认），轮询是必需的而非优化。现代内核 scrollTop 恒 0 ⇒ 零写入。
 */
const shellEl = ref<HTMLElement | null>(null);
let shellRaf = 0;

function resetShellScroll(): void {
  const el = shellEl.value;
  if (el !== null && el.scrollTop !== 0) el.scrollTop = 0;
}

function onShellScroll(): void {
  resetShellScroll();
}

function onWindowScroll(): void {
  if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
}

function lockShellLoop(): void {
  resetShellScroll();
  shellRaf = window.requestAnimationFrame(lockShellLoop);
}

// ------------------------------------------------------------------ 标签页
const TABS: ReadonlyArray<readonly [string, string]> = [
  ["result", "结果"],
  ["notes", "提示"],
  ["detail", "详情"],
  ["log", "日志"],
];
const tab = ref("result");

/** 只在「详情」页可见时序列化（§5.6 第 3 条）。 */
const detailText = computed(() => (tab.value === "detail" ? s.detailJson() : ""));

// ------------------------------------------------------------------ 种子弹层
const overlay = ref(false);
const shownChunks = ref(1);

/** 全量种子按 :data:`SEED_CHUNK`（400）个一块，每块内部按逗号折行。 */
const seedChunks = computed<string[][]>(() => {
  const found = outcome.value;
  if (found === null || found.seeds.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < found.seeds.length; i += SEED_CHUNK) {
    chunks.push(seedListLines(found.seeds.slice(i, i + SEED_CHUNK)));
  }
  return chunks;
});
const visibleChunks = computed(() => seedChunks.value.slice(0, shownChunks.value));

function openSeeds(): void {
  shownChunks.value = 1;
  overlay.value = true;
}

// ------------------------------------------------------------------ 剪贴板
const flash = ref("");

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flash.value = "已复制到剪贴板";
  } catch {
    // 非安全上下文（http）或没有权限：把原文摆出来让用户自己复制，而不是假装成功。
    flash.value = text;
  }
  window.setTimeout(() => {
    if (flash.value === "已复制到剪贴板") flash.value = "";
  }, 3000);
}

function copyLink(): void {
  void copyText(s.shareLink());
}

function copyLog(): void {
  void copyText(logs.value.join("\n"));
}

/**
 * 「查后端」：把后端自描述写进日志，**并切到「日志」页**。
 *
 * 对齐 tkinter 参考实现 ``window.py::check_backends``（先 ``self.book.select(1)`` 再写日志）。
 * 少了这一步，用户停在「结果」页时点了按钮**看不到任何反应**，会以为按钮坏了。
 */
function probeBackend(): void {
  s.probeBackend();
  tab.value = "log";
}

function copySeeds(): void {
  const found = outcome.value;
  if (found !== null) void copyText(found.seeds.join(","));
}

// ------------------------------------------------------------------ 分栏拖动
const ratio = ref(0.52);
const splitEl = ref<HTMLElement | null>(null);
let dragging = false;

function dragStart(event: PointerEvent): void {
  dragging = true;
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
}

function dragMove(event: PointerEvent): void {
  if (!dragging || splitEl.value === null) return;
  const rect = splitEl.value.getBoundingClientRect();
  const next = (event.clientX - rect.left) / rect.width;
  ratio.value = Math.min(0.72, Math.max(0.28, next));
}

function dragEnd(): void {
  dragging = false;
}

// ------------------------------------------------------------------ 快捷键
function onKey(event: KeyboardEvent): void {
  if (event.key === "F7") {
    event.preventDefault();
    void s.run();
    return;
  }
  if (event.key !== "Escape") return;
  if (overlay.value) {
    overlay.value = false;
    return;
  }
  if (busy.value) {
    event.preventDefault();
    s.cancel();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("scroll", onWindowScroll);
  const shell = shellEl.value;
  if (shell !== null) shell.addEventListener("scroll", onShellScroll);
  shellRaf = window.requestAnimationFrame(lockShellLoop);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("scroll", onWindowScroll);
  const shell = shellEl.value;
  if (shell !== null) shell.removeEventListener("scroll", onShellScroll);
  window.cancelAnimationFrame(shellRaf);
});
</script>

<template>
  <div ref="shellEl" class="shell">
    <!-- row-top 仙侠古典紧凑标题条 -->
    <div class="app-masthead">
      <div class="brand">
        <img
          class="brand-emblem"
          :src="emblemSrc"
          alt="造梦西游3"
          title="造梦西游3 随机数计算器"
        />
        <div class="brand-titles">
          <h1 class="brand-name">造梦西游3 <span>随机数计算器</span></h1>
          <p class="brand-subtitle">deepseek制作 · 游戏机制: 非♂ & 沼泽</p>
        </div>
      </div>
      <div class="masthead-decor">
        <a
          href="./mechanics.html"
          target="_blank"
          rel="noopener noreferrer"
          class="decor-tag decor-link"
          title="在新标签页打开"
        >
          游戏机制介绍
        </a>
        <span class="decor-dot">◆</span>
        <a
          href="./rngcalc.html"
          download="zaomeng-rngcalc-local.html"
          class="decor-tag decor-link"
          title="下载单文件离线版（内置 WASM，双击即用）"
        >
          离线版下载
        </a>
        <span class="decor-dot">◆</span>
        <a
          href="./rngcalc.legacy.html"
          download="zaomeng-rngcalc-legacy-local.html"
          class="decor-tag decor-link"
          title="下载「旧浏览器版」单文件离线版（es2017 语法 + 纯 MVP wasm，兼容 Chromium 70 级老引擎）"
        >
          旧浏览器版
        </a>
      </div>
    </div>

    <!-- row0 工具栏 -->
    <header class="toolbar">
      <label class="pick">
        场景
        <select :value="scenario.key" :disabled="busy" @change="onScenario">
          <option v-for="item in scenarios" :key="item.key" :value="item.key">
            {{ item.label || item.key }}
          </option>
        </select>
      </label>
      <label class="pick">
        后端
        <select v-model="backend" disabled>
          <option v-for="name in BACKENDS" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <button type="button" class="primary" :disabled="busy" title="F7" @click="s.run()">
        运行
      </button>
      <button type="button" :disabled="!busy" title="Esc" @click="s.cancel()">取消</button>
      <button type="button" :disabled="busy" @click="s.reset()">重置</button>
      <button type="button" @click="copyLink()">复制分享链接</button>
      <button type="button" @click="probeBackend()">查后端</button>
      <span class="spring"></span>
      <!-- 工具栏开关（``inToolbar``）：现在**一个都没有** —— 「枚举全部」与「自动升档」
           先后搬回了参数栏（勾选框和它管的那几个输入摆一起才看得懂）。这段渲染留着
           是因为 ``toolbar`` 还是 schema 契约的一部分。 -->
      <label
        v-for="field in toolbarFields"
        :key="field.key"
        class="toolbar-bool"
        :title="helpOf(field)"
      >
        <input
          type="checkbox"
          :data-field="field.key"
          :checked="raw[field.key] === true"
          :disabled="busy"
          @change="onBool($event, field.key)"
        />
        {{ field.label }}
      </label>
    </header>

    <!-- row1 进度：total = 0 时不定长 -->
    <div class="progress">
      <div
        class="bar"
        :class="{ unknown: pct === null && busy }"
        :style="pct === null ? {} : { width: `${pct}%` }"
      ></div>
    </div>

    <!-- row2 左右分栏 -->
    <main ref="splitEl" class="split">
      <section class="pane params" :style="{ flexBasis: `${ratio * 100}%` }">
        <h2 class="pane-title">参数</h2>
        <div class="scroll">
          <p class="hintline">{{ scenario.hint }}</p>

          <fieldset v-for="group in groups" :key="group.group" class="group">
            <legend>{{ group.title }}</legend>

            <!-- 表格组：字段名 | 动态展示值 | 控件（右边留弹性列） -->
            <table v-if="group.table" class="grid">
              <thead>
                <tr>
                  <th v-for="(head, index) in group.header" :key="index">{{ head }}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="field in group.fields" :key="field.key">
                  <td :class="{ bad: isBad(field.key) }" :title="field.key">
                    {{ field.label }}<span v-if="field.required" class="req">*</span>
                  </td>
                  <td
                    class="show"
                    :class="{ bad: isHintBad(field.key) }"
                    :data-hint="field.key"
                  >
                    {{ hintTextOf(field) }}
                  </td>
                  <td class="ctrl">
                    <input
                      v-if="field.kind === 'bool'"
                      type="checkbox"
                      :data-field="field.key"
                      :checked="raw[field.key] === true"
                      :disabled="busy"
                      @change="onBool($event, field.key)"
                    />
                    <select
                      v-else-if="field.kind === 'choice'"
                      :data-field="field.key"
                      :value="raw[field.key]"
                      :disabled="busy"
                      @change="onValue($event, field.key)"
                      @focus="hintKey = field.key"
                    >
                      <option v-for="choice in field.choices" :key="choice" :value="choice">
                        {{ choice }}
                      </option>
                    </select>
                    <input
                      v-else
                      :data-field="field.key"
                      :type="typeOf(field)"
                      :inputmode="inputModeOf(field)"
                      :value="raw[field.key]"
                      :min="minOf(field)"
                      :max="maxOf(field)"
                      :disabled="busy"
                      :style="{ width: widthOf(field) }"
                      @input="onValue($event, field.key)"
                      @focus="hintKey = field.key"
                    />
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- 普通组：标签 | 动态展示值 | 控件 -->
            <div v-else class="rows">
              <div v-for="field in group.fields" :key="field.key" class="row">
                <label
                  class="cell label"
                  :class="{ bad: isBad(field.key) }"
                  :for="`fld-${field.key}`"
                  :title="field.key"
                >
                  {{ field.label }}<span v-if="field.required" class="req">*</span>
                </label>
                <span
                  class="cell show"
                  :class="{ bad: isHintBad(field.key) }"
                  :data-hint="field.key"
                >
                  {{ hintTextOf(field) }}
                </span>
                <span class="cell ctrl">
                  <input
                    v-if="field.kind === 'bool'"
                    :id="`fld-${field.key}`"
                    type="checkbox"
                    :data-field="field.key"
                    :checked="raw[field.key] === true"
                    :disabled="busy"
                    @change="onBool($event, field.key)"
                  />
                  <select
                    v-else-if="field.kind === 'choice'"
                    :id="`fld-${field.key}`"
                    :data-field="field.key"
                    :value="raw[field.key]"
                    :disabled="busy"
                    @change="onValue($event, field.key)"
                    @focus="hintKey = field.key"
                  >
                    <option v-for="choice in field.choices" :key="choice" :value="choice">
                      {{ choice }}
                    </option>
                  </select>
                  <input
                    v-else
                    :id="`fld-${field.key}`"
                    :data-field="field.key"
                    :type="typeOf(field)"
                    :inputmode="inputModeOf(field)"
                    :value="raw[field.key]"
                    :min="minOf(field)"
                    :max="maxOf(field)"
                    :disabled="busy"
                    :style="{ width: widthOf(field) }"
                    @input="onValue($event, field.key)"
                    @focus="hintKey = field.key"
                  />
                </span>
              </div>
            </div>
          </fieldset>
        </div>
      </section>

      <div
        class="divider"
        title="拖动调整左右宽度"
        @pointerdown="dragStart"
        @pointermove="dragMove"
        @pointerup="dragEnd"
        @pointercancel="dragEnd"
      ></div>

      <section class="pane result">
        <nav class="tabs">
          <button
            v-for="[key, label] in TABS"
            :key="key"
            type="button"
            :class="{ active: tab === key }"
            @click="tab = key"
          >
            {{ label }}
            <span v-if="key === 'notes' && noteLines.length > 0" class="pill">
              {{ noteLines.length }}
            </span>
          </button>
        </nav>

        <!-- 结果 -->
        <div v-show="tab === 'result'" class="tabbody">
          <p class="conclusion" :class="{ danger: conclusion.danger }">{{ conclusion.text }}</p>
          <p v-if="failMessage" class="failure">{{ failMessage }}</p>
          <p v-if="outcome" class="meta">
            后端 {{ backendLabel(outcome.backend) }} · 用时
            {{ elapsed === null ? "—" : `${elapsed.toFixed(0)} ms` }}
          </p>

          <table v-if="rows.length > 0" class="kv">
            <tbody>
              <tr v-for="row in rows" :key="row.label">
                <th>{{ row.label }}</th>
                <td>{{ row.value }}</td>
              </tr>
            </tbody>
          </table>

          <div v-if="outcome" class="seedbar">
            <span v-if="seedBar === null" class="muted">{{ SEED_EMPTY }}</span>
            <template v-else>
              <code>{{ seedBar }}</code>
              <span class="muted">共 {{ outcome.seeds.length }} 个</span>
              <button type="button" @click="openSeeds()">查看全部</button>
            </template>
          </div>

          <div class="preview">
            <h3>属性预览</h3>
            <pre v-if="preview.kind === 'table'">{{ preview.lines.join("\n") }}</pre>
            <pre v-else-if="preview.kind === 'raw'">{{ preview.text }}</pre>
            <p v-else-if="preview.kind === 'empty'" class="muted">{{ PREVIEW_EMPTY }}</p>
          </div>
        </div>

        <!-- 提示 -->
        <div v-show="tab === 'notes'" class="tabbody">
          <p v-if="noteLines.length === 0" class="muted">{{ NOTES_EMPTY }}</p>
          <ul v-else class="notes">
            <li v-for="(line, index) in noteLines" :key="index" :class="line.level">
              <span class="tag">{{ LEVEL_LABEL[line.level] ?? line.level }}</span>
              <span class="prefix">{{ line.prefix }}</span>
              <span>{{ line.message }}</span>
            </li>
          </ul>
        </div>

        <!-- 详情（切到这一页才序列化） -->
        <div v-show="tab === 'detail'" class="tabbody">
          <pre v-if="detailText">{{ detailText }}</pre>
          <p v-else class="muted">还没有结果。</p>
        </div>

        <!-- 日志 -->
        <div v-show="tab === 'log'" class="tabbody">
          <div class="tabtools">
            <button type="button" @click="copyLog()">复制日志</button>
            <span class="muted">{{ logs.length }} 行</span>
          </div>
          <pre class="log">{{ logs.join("\n") }}</pre>
        </div>
      </section>
    </main>

    <!-- row3 提示条 -->
    <footer class="hintbar">
      <span>{{ hintBarText }}</span>
      <span class="spring"></span>
      <span v-if="flash" class="flash">{{ flash }}</span>
    </footer>

    <!-- row4 状态栏 -->
    <div class="statusbar">
      <span>{{ status }}</span>
      <span class="spring"></span>
      <span class="muted">场景 {{ scenario.key }} · 表单版本 {{ scenario.version }}</span>
    </div>

    <!-- 种子全量弹层：分块 400 渲染 -->
    <div v-if="overlay" class="overlay" @click.self="overlay = false">
      <div class="modal">
        <header>
          <strong>全部候选（{{ outcome === null ? 0 : outcome.seeds.length }} 个）</strong>
          <button type="button" @click="copySeeds()">复制全部</button>
          <button type="button" @click="overlay = false">关闭（Esc）</button>
        </header>
        <div class="modalbody">
          <pre v-for="(chunk, index) in visibleChunks" :key="index">{{ chunk.join("\n") }}</pre>
          <p v-if="visibleChunks.length < seedChunks.length" class="muted">
            <button type="button" @click="shownChunks += 1">再显示 400 个</button>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
  color: #ece0c3;
  background: radial-gradient(ellipse at 50% 0%, #1e3a7a 0%, #162e69 40%, #0d172e 100%);
  overflow: hidden;
}

/* ------------------------------------------------------------------ 仙侠古典紧凑标题条 */
.app-masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 14px;
  background: linear-gradient(180deg, rgba(35, 28, 17, 0.95) 0%, rgba(22, 17, 10, 0.98) 100%);
  border-bottom: 2px solid #7d5f05;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
  flex-wrap: wrap;
  gap: 8px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-emblem {
  height: 48px;
  width: auto;
  max-width: 360px;
  object-fit: contain;
  vertical-align: middle;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.75)) drop-shadow(0 0 6px rgba(255, 215, 0, 0.25));
  user-select: none;
}

.brand-titles {
  display: flex;
  flex-direction: column;
}

.brand-name {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: #ffde10;
  text-shadow: 0 1px 3px #000, 0 0 8px rgba(255, 222, 16, 0.4);
  line-height: 1.2;
}

.brand-name span {
  color: #ece0c3;
  font-size: 13px;
  font-weight: normal;
  margin-left: 6px;
}

.brand-subtitle {
  margin: 2px 0 0;
  font-size: 11px;
  color: #a89b82;
  letter-spacing: 1px;
}

.masthead-decor {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #c5b79a;
}

.decor-tag {
  padding: 2px 8px;
  background: rgba(255, 222, 16, 0.08);
  border: 1px solid rgba(255, 222, 16, 0.25);
  border-radius: 3px;
  color: #d8c9a6;
}

.decor-link {
  color: #d8c9a6;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
}

.decor-link:hover {
  background: rgba(255, 222, 16, 0.22);
  border-color: #ffd700;
  color: #ffffff;
  box-shadow: 0 0 8px rgba(255, 215, 0, 0.5);
  text-decoration: none;
}

.decor-dot {
  color: #f39c12;
  font-size: 10px;
}

/* ------------------------------------------------------------------ 工具栏 */
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 2px solid #5a492e;
  background: linear-gradient(180deg, #352b1b 0%, #241d13 100%);
  box-shadow: inset 0 1px 0 rgba(255, 235, 170, 0.12), 0 2px 6px rgba(0, 0, 0, 0.4);
  flex-wrap: wrap;
}

.pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  color: #ffde10;
  font-weight: 600;
  text-shadow: 0 1px 2px #000;
}

.pick select {
  background: #17130e;
  color: #fdf6e2;
  border: 1px solid #756345;
  border-radius: 4px;
  padding: 3px 8px;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.7);
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.pick select:focus {
  border-color: #f39c12;
  box-shadow: 0 0 6px rgba(243, 156, 18, 0.6);
}

.spring {
  /* 基准 0：理由同 .tabbody（老内核把内容尺寸泄漏进 flex 分配）。 */
  flex: 1 1 0%;
}

/* ------------------------------------------------------------------ 仙侠按钮体系 */
button {
  font: inherit;
  padding: 4px 12px;
  border: 1px solid #756345;
  border-radius: 4px;
  background: linear-gradient(180deg, #443725 0%, #2b2216 100%);
  color: #ece0c3;
  cursor: pointer;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 2px 4px rgba(0, 0, 0, 0.35);
  transition: all 0.15s ease;
  user-select: none;
}

button:hover:not(:disabled) {
  background: linear-gradient(180deg, #57462f 0%, #382c1d 100%);
  border-color: #c9b382;
  color: #ffffff;
  box-shadow: 0 0 8px rgba(201, 179, 130, 0.4);
}

button:active:not(:disabled) {
  background: linear-gradient(180deg, #241d13 0%, #3a2e1d 100%);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.6);
  transform: translateY(1px);
}

button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
}

/* 主操作按钮（金黄琥珀光泽） */
button.primary {
  border-color: #ffd700;
  background: linear-gradient(180deg, #ffe066 0%, #f39c12 50%, #d35400 100%);
  color: #ffffff;
  font-weight: 700;
  text-shadow: 0 1px 2px #5c2600, 0 0 4px rgba(0, 0, 0, 0.8);
  box-shadow: 0 0 10px rgba(255, 215, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.4), 0 2px 4px rgba(0, 0, 0, 0.5);
}

button.primary:hover:not(:disabled) {
  background: linear-gradient(180deg, #fff099 0%, #f8b332 50%, #e65c00 100%);
  box-shadow: 0 0 16px rgba(255, 222, 16, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.6);
}

button.primary:active:not(:disabled) {
  background: linear-gradient(180deg, #b84300 0%, #e67e22 100%);
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.7);
}

.toolbar-bool {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  color: #ece0c3;
}

/* ------------------------------------------------------------------ 进度条 */
/* 固定横行：显式禁止收缩（老内核把内容高度泄漏进 flex 分配时，这些行会被压碎）。 */
.app-masthead,
.toolbar,
.progress,
.hintbar,
.statusbar,
.tabs {
  flex-shrink: 0;
}

.progress {
  height: 6px;
  background: #14100a;
  border-top: 1px solid #3d3222;
  border-bottom: 1px solid #231c12;
  overflow: hidden;
}

.progress .bar {
  height: 100%;
  width: 0;
  background: linear-gradient(90deg, #f39c12, #ffde10, #f39c12);
  box-shadow: 0 0 8px rgba(255, 222, 16, 0.8);
  transition: width 0.12s linear;
}

.progress .bar.unknown {
  width: 30%;
  animation: slide 1.2s ease-in-out infinite;
}

@keyframes slide {
  0% {
    margin-left: -30%;
  }
  100% {
    margin-left: 100%;
  }
}

/* ------------------------------------------------------------------ 分栏容器 */
.split {
  flex: 1 1 0%;
  display: flex;
  min-height: 0;
}

.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: rgba(28, 23, 15, 0.92);
  /* Chromium 70 只认带前缀的（无前缀的是 Chrome 76）；认不出来就退化成不模糊，不影响使用。 */
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  box-shadow: inset 0 0 30px rgba(0, 0, 0, 0.5);
}

.params {
  flex: 0 0 52%;
  min-width: 320px;
  border-right: 2px solid #5a4b33;
}

.result {
  /* 基准 0：理由同 .tabbody（老内核把内容尺寸泄漏进 flex 分配，横向同理会挤压参数窗格）。 */
  flex: 1 1 0%;
  min-width: 320px;
}

.pane-title {
  flex-shrink: 0;
  margin: 0;
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 700;
  color: #ffde10;
  background: linear-gradient(180deg, #382f1f 0%, #261f14 100%);
  border-bottom: 1px solid #6b5a3e;
  text-shadow: 0 1px 2px #000;
  display: flex;
  align-items: center;
}

.pane-title::before {
  content: "❖";
  margin-right: 6px;
  color: #f39c12;
  font-size: 11px;
}

.scroll {
  /* 基准 0：理由同 .tabbody（老内核内容高度泄漏）。 */
  flex: 1 1 0%;
  overflow: auto;
  padding: 10px 14px 20px;
}

.hintline {
  margin: 0 0 10px;
  color: #c5b79a;
  font-size: 12px;
  line-height: 1.5;
  background: rgba(43, 37, 23, 0.6);
  padding: 6px 10px;
  border-radius: 4px;
  border-left: 3px solid #ffde10;
}

/* ------------------------------------------------------------------ 分组框与表单 */
.group {
  margin: 0 0 12px;
  border: 1px solid #6e5e41;
  border-radius: 5px;
  padding: 8px 10px 10px;
  background: rgba(38, 31, 21, 0.75);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}

.group legend {
  padding: 0 8px;
  color: #ffde10;
  font-weight: 700;
  font-size: 12px;
  text-shadow: 0 1px 2px #000;
  background: #33291b;
  border: 1px solid #7d6b49;
  border-radius: 3px;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row {
  display: grid;
  grid-template-columns: minmax(96px, max-content) minmax(0, 1fr) max-content;
  align-items: center;
  gap: 8px;
}

.cell {
  min-width: 0;
}

.label {
  text-align: right;
  color: #e5d7ba;
  font-weight: 500;
}

.show {
  color: #c5b79a;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * 「这一格有问题」——标签列（运行校验失败）与展示值列（目标范围填错、显示的是
 * `fieldHintIssues` 给的短原因）共用。写在这里是因为它在 `.show` 之后：同特异度
 * 下靠后者覆盖 `color` / `font-weight`，展示值那一格才会真的变红。
 */
.bad {
  color: #ff5252;
  font-weight: 700;
  text-shadow: 0 0 6px rgba(255, 82, 82, 0.6);
}

.req {
  color: #ff5252;
  margin-left: 2px;
}

.grid {
  border-collapse: collapse;
  width: 100%;
}

.grid th {
  text-align: left;
  font-weight: 600;
  color: #ffde10;
  border-bottom: 1px solid #7d6b49;
  background: #2b2517;
  padding: 4px 8px;
  text-shadow: 0 1px 2px #000;
}

.grid td {
  padding: 4px 8px;
  vertical-align: middle;
  border-bottom: 1px solid rgba(125, 107, 73, 0.3);
}

.grid td.ctrl {
  width: 1%;
}

input[type="text"],
input[type="number"],
select {
  font: inherit;
  padding: 3px 6px;
  border: 1px solid #756345;
  border-radius: 3px;
  background: #17130e;
  color: #fdf6e2;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.7);
  min-width: 4ch;
  transition: border-color 0.15s, box-shadow 0.15s;
}

input[type="text"]:focus,
input[type="number"]:focus,
select:focus {
  border-color: #f39c12;
  box-shadow: 0 0 6px rgba(243, 156, 18, 0.6), inset 0 1px 3px rgba(0, 0, 0, 0.7);
  outline: none;
}

input[type="checkbox"] {
  accent-color: #f39c12;
  cursor: pointer;
}

.divider {
  flex: 0 0 6px;
  cursor: col-resize;
  background: linear-gradient(to right, #241d13, #6b5a3e, #241d13);
  position: relative;
  transition: background 0.15s;
}

.divider:hover {
  background: #f39c12;
  box-shadow: 0 0 8px rgba(243, 156, 18, 0.7);
}

/* ------------------------------------------------------------------ 选项卡 */
.tabs {
  display: flex;
  gap: 4px;
  padding: 6px 8px 0;
  border-bottom: 2px solid #7d5f05;
  background: linear-gradient(180deg, #382f1f 0%, #261f14 100%);
}

.tabs button {
  border-radius: 5px 5px 0 0;
  border: 1px solid #6b5a3e;
  border-bottom-color: transparent;
  background: #2e2518;
  color: #c5b79a;
  padding: 4px 12px;
}

.tabs button.active {
  background: #473922;
  border-color: #ffde10;
  border-bottom-color: #473922;
  color: #ffde10;
  font-weight: 700;
  box-shadow: 0 -2px 6px rgba(255, 222, 16, 0.25);
}

.pill {
  display: inline-block;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 8px;
  background: #d35400;
  color: #fff;
  font-size: 11px;
  border: 1px solid #ffde10;
}

/* ⚠️ 基准必须写 0 而不是 auto：Chromium 70（LayoutNG 之前）的老 flex 算法会把
   滚动内容的高度（详情 JSON 可达 18000px+）当成基准向上传播，把标题条/工具栏/
   标签行全部压碎成细线。现代引擎按可用空间分配，不受影响；写 0 两边行为一致。 */
.tabbody {
  flex: 1 1 0%;
  min-height: 0;
  overflow: auto;
  padding: 10px 14px;
}

.tabtools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

/* ------------------------------------------------------------------ 结论与结果呈现 */
.conclusion {
  margin: 0 0 10px;
  font-size: 16px;
  font-weight: 700;
  color: #ffde10;
  text-shadow: 0 1px 3px #000, 0 0 8px rgba(255, 222, 16, 0.4);
  background: rgba(50, 40, 25, 0.7);
  padding: 8px 12px;
  border-left: 4px solid #ffde10;
  border-radius: 0 4px 4px 0;
}

.conclusion.danger {
  color: #ff5252;
  border-left-color: #ff5252;
  text-shadow: 0 1px 3px #000, 0 0 8px rgba(255, 82, 82, 0.4);
}

.failure {
  margin: 0 0 8px;
  color: #ff5252;
  background: rgba(80, 20, 20, 0.6);
  padding: 6px 10px;
  border-radius: 4px;
  border: 1px solid #ff5252;
}

.meta {
  margin: 0 0 10px;
  color: #c5b79a;
  font-size: 12px;
}

.kv {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 12px;
  background: rgba(35, 28, 18, 0.8);
  border: 1px solid #5a4b33;
  border-radius: 4px;
  overflow: hidden;
}

.kv th {
  text-align: left;
  padding: 4px 10px;
  color: #ffde10;
  font-weight: 600;
  border-bottom: 1px solid #4a3d2a;
  background: rgba(50, 40, 25, 0.6);
}

.kv td {
  padding: 4px 10px;
  color: #ece0c3;
  border-bottom: 1px solid #4a3d2a;
}

.seedbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  background: rgba(30, 24, 15, 0.9);
  border: 1px solid #6b5a3e;
  border-radius: 4px;
  padding: 6px 10px;
}

.seedbar code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #ffde10;
  background: #16120b;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid #4a3d2a;
}

.preview h3 {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 700;
  color: #ffde10;
  text-shadow: 0 1px 2px #000;
}

.preview h3::before {
  content: "❖";
  margin-right: 6px;
  color: #f39c12;
  font-size: 11px;
}

pre {
  margin: 0;
  font-family: Consolas, "Cascadia Mono", monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  background: rgba(18, 14, 9, 0.95);
  border: 1px solid #6e5e41;
  border-radius: 4px;
  padding: 8px 12px;
  color: #ece0c3;
  box-shadow: inset 0 1px 5px rgba(0, 0, 0, 0.8);
  line-height: 1.5;
}

.muted {
  color: #a89b82;
}

.notes {
  margin: 0;
  padding: 0;
  list-style: none;
}

.notes li {
  display: flex;
  gap: 6px;
  padding: 4px 0;
  align-items: baseline;
  border-bottom: 1px dashed rgba(125, 107, 73, 0.25);
}

.notes li.warning {
  color: #ffd166;
}

.notes li.error {
  color: #ff6b6b;
}

.notes .tag {
  flex: 0 0 auto;
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.08);
}

.notes .prefix {
  flex: 0 0 auto;
  color: #c5b79a;
  font-family: Consolas, monospace;
  font-size: 12px;
}

.log {
  color: #ece0c3;
}

/* ------------------------------------------------------------------ 底栏 */
.hintbar {
  display: flex;
  gap: 10px;
  padding: 4px 12px;
  border-top: 1px solid #5a4b33;
  background: linear-gradient(180deg, #2a2317 0%, #1f1910 100%);
  color: #c5b79a;
  font-size: 12px;
}

.flash {
  color: #4cd964;
  font-weight: 700;
  text-shadow: 0 0 6px rgba(76, 217, 100, 0.6);
}

.statusbar {
  display: flex;
  gap: 10px;
  padding: 3px 12px;
  border-top: 1px solid #3d3222;
  background: #19140e;
  color: #a89b82;
  font-size: 12px;
}

/* ------------------------------------------------------------------ 弹层 */
.overlay {
  position: fixed;
  /* ⚠️ 不要写成 `inset: 0`（Chrome 87）：四个长写等价，且到处都认。 */
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: rgba(10, 16, 30, 0.75);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}

.modal {
  display: flex;
  flex-direction: column;
  /* `min(80vw, 900px)` 是 Chrome 79；拆成 `width` + `max-width` 完全等价：
     80vw < 900px 时两者都是 80vw，否则被 max-width 封在 900px。 */
  width: 80vw;
  max-width: 900px;
  max-height: 80vh;
  background: linear-gradient(180deg, #302619 0%, #1c160e 100%);
  border: 2px solid #80765c;
  border-radius: 8px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.8), 0 0 20px rgba(255, 215, 0, 0.15);
  color: #ece0c3;
  overflow: hidden;
}

.modal header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: linear-gradient(180deg, #3d3120 0%, #2b2216 100%);
  border-bottom: 1px solid #6b5a3e;
  color: #ffde10;
  text-shadow: 0 1px 2px #000;
}

.modal header strong {
  /* 基准 0：理由同 .tabbody（老内核把内容尺寸泄漏进 flex 分配）。 */
  flex: 1 1 0%;
}

.modalbody {
  /* 基准 0：理由同 .tabbody（老内核内容高度泄漏）。 */
  flex: 1 1 0%;
  overflow: auto;
  padding: 10px 14px;
}

.modalbody pre {
  padding: 4px 0;
  border-bottom: 1px dashed #544630;
  background: transparent;
  border: none;
  box-shadow: none;
}

/* ------------------------------------------------------------------ 滚动条 */
.scroll::-webkit-scrollbar,
.tabbody::-webkit-scrollbar,
.modalbody::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.scroll::-webkit-scrollbar-track,
.tabbody::-webkit-scrollbar-track,
.modalbody::-webkit-scrollbar-track {
  background: #17120a;
}

.scroll::-webkit-scrollbar-thumb,
.tabbody::-webkit-scrollbar-thumb,
.modalbody::-webkit-scrollbar-thumb {
  background: #5a4b33;
  border-radius: 4px;
}

.scroll::-webkit-scrollbar-thumb:hover,
.tabbody::-webkit-scrollbar-thumb:hover,
.modalbody::-webkit-scrollbar-thumb:hover {
  background: #7d6b49;
}

/* ------------------------------------------------------------------ 移动端竖屏响应式适配 */
@media (max-width: 720px) {
  /* 标题条紧凑 */
  .app-masthead {
    padding: 6px 10px;
    gap: 6px;
  }

  .brand-emblem {
    height: 36px;
    max-width: 45vw;
  }

  .brand-name {
    font-size: 13px;
  }

  .brand-name span {
    font-size: 11px;
    margin-left: 4px;
  }

  .brand-subtitle {
    font-size: 10px;
    letter-spacing: 0.5px;
  }

  .masthead-decor {
    font-size: 11px;
    gap: 6px;
  }

  .decor-tag {
    padding: 2px 6px;
  }

  /* 工具栏更紧凑 */
  .toolbar {
    padding: 4px 8px;
    gap: 4px;
  }

  .toolbar button {
    padding: 3px 8px;
    font-size: 12px;
  }

  .pick {
    font-size: 12px;
    gap: 4px;
  }

  .pick select {
    padding: 2px 4px;
    font-size: 12px;
  }

  /* 分栏转为上下堆叠 */
  .split {
    flex-direction: column;
  }

  .divider {
    display: none;
  }

  .pane {
    min-width: 0;
  }

  .params {
    flex: 1 1 50% !important;
    min-width: 0;
    min-height: 120px;
    border-right: none;
    border-bottom: 2px solid #5a4b33;
  }

  .result {
    flex: 1 1 50%;
    min-width: 0;
    min-height: 120px;
  }

  .scroll {
    padding: 8px 10px 14px;
  }

  .tabbody {
    padding: 8px 10px;
  }

  /* 表单分组与行自适应 */
  .group {
    margin: 0 0 8px;
    padding: 6px 8px 8px;
    max-width: 100%;
    box-sizing: border-box;
    overflow-x: auto;
  }

  .row {
    grid-template-columns: minmax(72px, auto) minmax(0, 1fr) auto;
    gap: 6px;
  }

  .cell.label {
    font-size: 12px;
  }

  .cell.show {
    font-size: 11px;
  }

  .cell.ctrl {
    max-width: 58vw;
    display: flex;
    justify-content: flex-end;
  }

  /* 移动端输入框字号 >= 16px，防止 iOS 聚焦时自动缩放页面 */
  input[type="text"],
  input[type="number"],
  select {
    font-size: 16px;
    box-sizing: border-box;
    max-width: 100%;
  }

  .tabs button {
    padding: 4px 8px;
    font-size: 12px;
  }

  .conclusion {
    font-size: 14px;
    padding: 6px 10px;
  }

  .seedbar {
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 8px;
  }

  .seedbar code {
    max-width: 100%;
  }

  .kv th,
  .kv td {
    padding: 4px 6px;
    font-size: 12px;
  }

  pre {
    font-size: 11px;
    padding: 6px 8px;
  }

  .hintbar,
  .statusbar {
    padding: 3px 8px;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hintbar span:first-child,
  .statusbar span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .modal {
    width: 95vw;
    max-height: 88vh;
  }

  .modal header {
    padding: 6px 10px;
    font-size: 12px;
  }

  .modalbody {
    padding: 8px 10px;
  }
}

/* ------------------------------------------------------------------ 老引擎兜底（Chromium 70 类） */
/*
  ⚠️ flex 容器的 `gap` 是 **Chrome 84** 才有的，Chromium 70 上不认 —— 而且它不报错，
  只是元素**全挤在一起**（能用，但很难看）。这里用 `margin` 补，并且**只在
  `html.no-flex-gap` 下生效**：那个类是 `src/compat/css.ts` 的运行时探针挂的，
  现代引擎根本不挂 ⇒ 这段 CSS 在现代浏览器上一条都不生效，不会和 `gap` 叠加。

  为什么不用 `@supports (gap: 1px)`：Chrome 70 的 **grid** gap 会让那条声明直接成立，
  flex 的场景被误判成「支持」。探针量的是真实布局，绕开了这个坑。

  为什么用 `> * + *`：它精确等于「真 `gap` 会作用到的那些元素」（第一个子元素没有间距，
  而纯空白的文本节点不算 flex 项），所以条件渲染出来的子元素不会错位。
  `flex-wrap: wrap` 的容器在换行处会多一个行首间隙 —— 有意接受的取舍。

  ⚠️ 下面的数字逐条对应上面的 `gap:`：改一处就要一起改（老引擎上不生效时没有任何提示）。

  `.row` 不在表里：它是 **grid**，grid 的 `gap` 从 Chrome 57 就有。
*/
html.no-flex-gap .app-masthead > * + *,
html.no-flex-gap .masthead-decor > * + *,
html.no-flex-gap .tabtools > * + *,
html.no-flex-gap .seedbar > * + *,
html.no-flex-gap .modal header > * + * {
  margin-left: 8px;
}

html.no-flex-gap .brand > * + *,
html.no-flex-gap .hintbar > * + *,
html.no-flex-gap .statusbar > * + * {
  margin-left: 10px;
}

html.no-flex-gap .toolbar > * + *,
html.no-flex-gap .notes li > * + * {
  margin-left: 6px;
}

html.no-flex-gap .tabs > * + * {
  margin-left: 4px;
}

/*
  ⚠️ `.pick` / `.toolbar-bool` 不能用 `> * + *`：它们只有一个元素子节点（`select` / `input`），
  前面那段文字是**匿名 flex 项** —— 真 `gap` 会算上它，而 `* + *` 只数元素。所以直接给控件加。
  （前提就是这个「一个元素子节点」的形状，将来加了第二个元素要回头改。）
*/
html.no-flex-gap .pick > select {
  margin-left: 6px;
}

html.no-flex-gap .toolbar-bool > input {
  margin-left: 4px;
}

/* 唯一的 column 方向容器：间距落在主轴（竖直）上，所以是 `margin-top`。 */
html.no-flex-gap .rows > * + * {
  margin-top: 6px;
}

/* 移动端断点里改过间距的那几个，兜底跟着换（值见上面的 `@media (max-width: 720px)`）。 */
@media (max-width: 720px) {
  html.no-flex-gap .app-masthead > * + *,
  html.no-flex-gap .masthead-decor > * + *,
  html.no-flex-gap .seedbar > * + * {
    margin-left: 6px;
  }

  html.no-flex-gap .toolbar > * + *,
  html.no-flex-gap .pick > select {
    margin-left: 4px;
  }
}
</style>

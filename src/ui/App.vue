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
import { entryWidth, helpOf, hintOf } from "./form";
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

/** ``int`` / ``float`` 才写 ``min`` / ``max`` 属性（其它类型返回 ``undefined`` = 不写）。 */
function minOf(field: InputField): number | undefined {
  return field.kind === "int" || field.kind === "float" ? (field.min ?? undefined) : undefined;
}
function maxOf(field: InputField): number | undefined {
  return field.kind === "int" || field.kind === "float" ? (field.max ?? undefined) : undefined;
}
function typeOf(field: InputField): string {
  return field.kind === "text" ? "text" : "number";
}
function hintTextOf(field: InputField): string {
  return hintOf(hints.value, field.key);
}
function isBad(key: string): boolean {
  return bad.value.has(key);
}

/** 底部提示条：鼠标划过 / 聚焦过的字段的静态说明（``field.help``，与动态展示值分开）。 */
const hintKey = ref<string | null>(null);
const hintBarText = computed(() => {
  const key = hintKey.value;
  if (key === null) return "F5 = 运行，Esc = 取消；「复制分享链接」可以把当前参数发给别人";
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
    el.scrollIntoView({ block: "center" });
  },
);

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
  if (event.key === "F5") {
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

onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="shell">
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
      <button type="button" class="primary" :disabled="busy" title="F5" @click="s.run()">
        运行
      </button>
      <button type="button" :disabled="!busy" title="Esc" @click="s.cancel()">取消</button>
      <button type="button" :disabled="busy" @click="s.reset()">重置</button>
      <button type="button" @click="copyLink()">复制分享链接</button>
      <button type="button" @click="s.probeBackend()">查后端</button>
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
                  <td class="show">{{ hintTextOf(field) }}</td>
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
                <span class="cell show">{{ hintTextOf(field) }}</span>
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
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 13px;
  color: #1f2328;
  background: #f6f7f9;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid #d5d8dd;
  background: #fff;
  flex-wrap: wrap;
}

.pick {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.spring {
  flex: 1 1 auto;
}

button {
  font: inherit;
  padding: 3px 10px;
  border: 1px solid #c3c7cd;
  border-radius: 4px;
  background: #fbfbfc;
  cursor: pointer;
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

button.primary {
  border-color: #1a6cd0;
  background: #1a6cd0;
  color: #fff;
}

.toolbar-bool {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.progress {
  height: 6px;
  background: #e6e8eb;
  overflow: hidden;
}

.progress .bar {
  height: 100%;
  width: 0;
  background: #1a6cd0;
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

.split {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
}

.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #fff;
}

.params {
  flex: 0 0 52%;
  min-width: 320px;
  border-right: 1px solid #d5d8dd;
}

.result {
  flex: 1 1 auto;
  min-width: 320px;
}

.pane-title {
  margin: 0;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  color: #57606a;
  border-bottom: 1px solid #e6e8eb;
}

.scroll {
  overflow: auto;
  padding: 8px 10px 16px;
}

.hintline {
  margin: 0 0 8px;
  color: #57606a;
}

.group {
  margin: 0 0 10px;
  border: 1px solid #dfe2e6;
  border-radius: 4px;
  padding: 6px 8px 8px;
}

.group legend {
  padding: 0 4px;
  color: #57606a;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
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
  color: #24292f;
}

.show {
  color: #6e7781;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bad {
  color: #b3261e;
  font-weight: 600;
}

.req {
  color: #b3261e;
  margin-left: 2px;
}

.grid {
  border-collapse: collapse;
  width: 100%;
}

.grid th {
  text-align: left;
  font-weight: 600;
  color: #57606a;
  border-bottom: 1px solid #e6e8eb;
  padding: 2px 6px;
}

.grid td {
  padding: 2px 6px;
  vertical-align: middle;
}

.grid td.ctrl {
  width: 1%;
}

input[type="text"],
input[type="number"],
select {
  font: inherit;
  padding: 1px 4px;
  border: 1px solid #c3c7cd;
  border-radius: 3px;
  background: #fff;
  min-width: 4ch;
}

.divider {
  flex: 0 0 5px;
  cursor: col-resize;
  background: linear-gradient(to right, #e6e8eb, #f6f7f9, #e6e8eb);
}

.divider:hover {
  background: #cfe0f5;
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 4px 6px 0;
  border-bottom: 1px solid #d5d8dd;
  background: #fff;
}

.tabs button {
  border-radius: 4px 4px 0 0;
  border-bottom-color: transparent;
}

.tabs button.active {
  background: #eef4fd;
  border-color: #1a6cd0;
  color: #1a6cd0;
}

.pill {
  display: inline-block;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 8px;
  background: #1a6cd0;
  color: #fff;
  font-size: 11px;
}

.tabbody {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 8px 10px;
}

.tabtools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.conclusion {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
}

.conclusion.danger {
  color: #b3261e;
}

.failure {
  margin: 0 0 6px;
  color: #b3261e;
}

.meta {
  margin: 0 0 8px;
  color: #6e7781;
  font-size: 12px;
}

.kv {
  border-collapse: collapse;
  margin-bottom: 10px;
}

.kv th {
  text-align: left;
  padding: 1px 12px 1px 0;
  color: #57606a;
  font-weight: 500;
}

.kv td {
  padding: 1px 0;
}

.seedbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.seedbar code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview h3 {
  margin: 0 0 4px;
  font-size: 12px;
  color: #57606a;
}

pre {
  margin: 0;
  font-family: Consolas, "Cascadia Mono", monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.muted {
  color: #6e7781;
}

.notes {
  margin: 0;
  padding: 0;
  list-style: none;
}

.notes li {
  display: flex;
  gap: 6px;
  padding: 2px 0;
  align-items: baseline;
}

.notes li.warning {
  color: #8a5300;
}

.notes li.error {
  color: #b3261e;
}

.notes .tag {
  flex: 0 0 auto;
  font-weight: 600;
}

.notes .prefix {
  flex: 0 0 auto;
  color: #6e7781;
  font-family: Consolas, monospace;
  font-size: 12px;
}

.log {
  color: #24292f;
}

.hintbar {
  display: flex;
  gap: 10px;
  padding: 4px 10px;
  border-top: 1px solid #d5d8dd;
  background: #fff;
  color: #57606a;
  font-size: 12px;
}

.flash {
  color: #1a7f37;
  font-weight: 600;
}

.statusbar {
  display: flex;
  gap: 10px;
  padding: 3px 10px;
  border-top: 1px solid #e6e8eb;
  background: #fbfbfc;
  color: #24292f;
  font-size: 12px;
}

.overlay {
  position: fixed;
  inset: 0;
  background: rgba(31, 35, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}

.modal {
  display: flex;
  flex-direction: column;
  width: min(80vw, 900px);
  max-height: 80vh;
  background: #fff;
  border-radius: 6px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}

.modal header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid #e6e8eb;
}

.modal header strong {
  flex: 1 1 auto;
}

.modalbody {
  overflow: auto;
  padding: 8px 10px;
}

.modalbody pre {
  padding: 4px 0;
  border-bottom: 1px dashed #e6e8eb;
}
</style>

/**
 * ``src_forge/core/errors.py`` 的 1:1 翻译。
 *
 * Python 侧的错误类型靠 ``isinstance`` 分支；TS 里没有多继承异常体系，
 * 所以用 ``name`` 字段 + ``instanceof`` 双保险。
 */

/** 输入本身不合法（区间数量越界、上下界反了、文本解析失败……）。 */
export class SpecError extends Error {
  override readonly name: string = "SpecError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, SpecError.prototype);
  }
}

/** 后端不可用 / 未实现某能力（对应 Python 的 ``BackendUnavailable``）。 */
export class BackendUnavailable extends Error {
  override readonly name: string = "BackendUnavailable";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, BackendUnavailable.prototype);
  }
}

/** 任务被用户取消（对应 Python 的 ``Canceled``）。 */
export class Canceled extends Error {
  override readonly name: string = "Canceled";
  constructor(message = "已取消") {
    super(message);
    Object.setPrototypeOf(this, Canceled.prototype);
  }
}

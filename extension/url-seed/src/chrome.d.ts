/**
 * 只声明本扩展**真的用到**的那一小片 ``chrome.*`` API。
 *
 * 为什么不装 ``@types/chrome``：本仓库对新增依赖很克制（``web/package.json`` 的
 * ``dependencies`` 只有 ``vue``），而这里要用的面非常窄 —— ``webRequest`` 的观察回调、
 * ``storage.local``、``scripting.registerContentScripts``、``permissions``、``tabs.query``、
 * ``runtime`` 的消息通道。手写这几张签名比拉一个几 MB 的 ``@types/chrome`` 划算，
 * 而且能顺带把「哪些 API 是被允许的」钉死：想用别的就得先在这里加声明。
 *
 * ⚠️ 声明是**环境**（``declare global``），不是模块。要被 TS 看见必须落在
 * ``tsconfig.json`` 的 ``include`` 里（``web/tsconfig.json`` 里已加 ``"extension"``）；
 * 单靠 import 引不到它，所以**任何**用到 ``chrome`` 的扩展源文件都依赖这条隐式前提。
 *
 * ⚠️ 所有取值都可能返回 ``undefined``/``null``：MV3 下 API 缺失（旧版 Chrome、
 * 被策略禁用）是常态，调用方必须自己兜。这里刻意**不**把返回类型写成非空。
 */

declare namespace chrome {
  /** ``runtime.lastError``：回调式 API 里读它才不会打印「Unchecked lastError」。 */
  interface LastError {
    readonly message?: string;
  }

  namespace runtime {
    const id: string | undefined;
    const lastError: LastError | undefined;
    /** 扩展的 ``manifest.json``（``version`` 等）。 */
    const getManifest: () => { version?: string };
    /** 打开 ``options.html``。 */
    const openOptionsPage: (callback?: () => void) => void;
    const getURL: (path: string) => string;
    const sendMessage: (message: unknown, callback?: (response: unknown) => void) => void;
    /**
     * ⚠️ 返回 ``true`` 才表示「异步回复」—— 返回值必须**恰好**是 ``true``
     * （返回 ``Promise`` 会抛「The message port closed before a response was received」）。
     */
    const onMessage: {
      addListener: (
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ) => void;
    };
    interface MessageSender {
      /** 发消息的那个标签页（内容脚本发来时有值）。 */
      readonly tab?: { readonly id?: number; readonly url?: string };
      readonly url?: string;
      readonly id?: string;
    }
  }

  namespace storage {
    interface StorageArea {
      get(keys: string | string[] | null, callback: (items: Record<string, unknown>) => void): void;
      set(items: Record<string, unknown>, callback?: () => void): void;
      remove(keys: string | string[], callback?: () => void): void;
    }
    interface StorageChange {
      readonly oldValue?: unknown;
      readonly newValue?: unknown;
    }
    interface StorageAreaChangedEvent {
      addListener: (
        callback: (changes: Record<string, StorageChange>, areaName: string) => void,
      ) => void;
      removeListener: (
        callback: (changes: Record<string, StorageChange>, areaName: string) => void,
      ) => void;
    }
    const local: StorageArea;
    const onChanged: StorageAreaChangedEvent;
  }

  namespace webRequest {
    interface RequestDetails {
      readonly requestId: string;
      readonly url: string;
      readonly method: string;
      readonly type: string;
      /** ``-1`` = 不是某个标签页发起的（SW / 预取 / 其它扩展）。 */
      readonly tabId: number;
      readonly frameId: number;
      /** 导航后用 ``requestId`` 关联的导航 id（Chrome 106+）。 */
      readonly documentId?: string;
      readonly initiator?: string;
      readonly timeStamp: number;
    }
    interface RequestFilter {
      urls: string[];
      types?: string[];
    }
    /**
     * 只观察（不阻塞）—— MV3 里 ``webRequestBlocking`` 基本不可用，本扩展也**不需要**
     * 改写请求，故 ``opt_extraInfoSpec`` 一律省略。
     */
    const onBeforeRequest: {
      addListener: (callback: (details: RequestDetails) => void, filter: RequestFilter) => void;
      removeListener: (callback: (details: RequestDetails) => void) => void;
      hasListener: (callback: (details: RequestDetails) => void) => boolean;
    };
  }

  namespace scripting {
    interface RegisteredContentScript {
      id: string;
      matches: string[];
      js: string[];
      css?: string[];
      runAt?: "document_start" | "document_end" | "document_idle";
      allFrames?: boolean;
      persistAcrossSessions?: boolean;
      world?: "ISOLATED" | "MAIN";
    }
    const registerContentScripts: (
      scripts: RegisteredContentScript[],
      callback?: () => void,
    ) => void;
    const updateContentScripts: (
      scripts: RegisteredContentScript[],
      callback?: () => void,
    ) => void;
    const unregisterContentScripts: (
      filter?: { ids?: string[] } | null,
      callback?: () => void,
    ) => void;
    const getRegisteredContentScripts: (
      filter?: { ids?: string[] } | null,
      callback?: (scripts: RegisteredContentScript[]) => void,
    ) => void;
    const executeScript: (injection: {
      target: { tabId: number; allFrames?: boolean };
      files?: string[];
      func?: (...args: never[]) => unknown;
    }) => Promise<unknown[]>;
  }

  namespace permissions {
    const contains: (permissions: { origins?: string[] }, callback: (result: boolean) => void) => void;
    const request: (permissions: { origins?: string[] }, callback: (granted: boolean) => void) => void;
    const remove: (permissions: { origins?: string[] }, callback: (removed: boolean) => void) => void;
    interface PermissionsAddedEvent {
      addListener: (callback: (permissions: { origins?: string[] }) => void) => void;
    }
    const onAdded: PermissionsAddedEvent;
    const onRemoved: PermissionsAddedEvent;
  }

  namespace tabs {
    interface Tab {
      readonly id?: number;
      readonly url?: string;
      readonly title?: string;
      readonly active?: boolean;
    }
    const query: (
      queryInfo: { active?: boolean; currentWindow?: boolean },
      callback: (tabs: Tab[]) => void,
    ) => void;
    const sendMessage: (tabId: number, message: unknown, callback?: (response: unknown) => void) => void;
    /** 与本文其他声明保持一致用**回调式**（``lastError`` 好集中处理）。 */
    const reload: (
      tabId: number,
      props?: { bypassCache?: boolean },
      callback?: () => void,
    ) => void;
    const onRemoved: { addListener: (callback: (tabId: number) => void) => void };
    interface TabUpdateInfo {
      /** 只有 URL 真的变了才有这个字段（普通刷新通常不带）。 */
      readonly url?: string;
      /** ``loading`` / ``complete``。 */
      readonly status?: string;
    }
    const onUpdated: {
      addListener: (
        callback: (tabId: number, changeInfo: TabUpdateInfo, tab: Tab) => void,
      ) => void;
    };
    /**
     * **MV2 才有的**按需注入（``chrome.tabs.executeScript``）。MV3 里这个 API 已下线，
     * 取而代之的是 ``scripting.executeScript``（见上面的 ``namespace scripting``）。
     * MV2 档的背景页靠它在导航时把内容脚本塞进已授权的站点（:mod:`./background`）。
     *
     * ⚠️ 与 ``scripting`` 那套的两点差别：**回调式**；而且 ``runAt`` 是真的有用 ——
     * ``scripting.executeScript`` 是「调用即注入」，没有时机参数。
     */
    const executeScript: (
      tabId: number,
      details: {
        file: string;
        runAt?: "document_start" | "document_end" | "document_idle";
        allFrames?: boolean;
      },
      callback?: (result: unknown[]) => void,
    ) => void;
  }
}

# `web/assets/` —— 文档配图

放 README / 文档里引用的截图与示意图（例如站点首页 [`../README.md`](../README.md)
里各场景的示例截图）。

- **引用写法**：从 `web/README.md` 里写 `assets/xxx.png`（相对 `web/` 的路径）。
- **不进 `dist/`**：vite 的 `publicDir` 是 `public/`，所以本目录只是源码仓库里的文档素材，
  不会被构建，也不会发布到站点。
- **不触发重建**：本目录不在 `.github/workflows/pages.yml` 的 `paths:` 里 —— 换图不需要
  重跑一遍 Pages 构建。
- **行尾**：`.gitattributes` 已把 `*.png` 标为 `binary`，不会有 CRLF 转换问题。
- **体积**：提交前顺手压一下（截图 PNG 很容易上几百 KB，README 首页会直接加载）。

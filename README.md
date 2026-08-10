# PixivCrawler

PixivCrawler 是面向 Windows 10/11 x64 的个人 Pixiv 作品归档工具。它使用独立的
Electron 登录会话，只访问当前账号能够正常查看的作品，并提供作品链接、作者作品和
当前账号收藏和主题/标签搜索四种下载入口。搜索支持关键词或 Pixiv 标签页链接，可按最低收藏数、
浏览数和点赞数筛选，并将下载数量限制为最多 100 张图片；中文等译名精确命中 Pixiv 官方标签候选时，
会自动使用对应的主标签搜索。

## 下载

- [下载安装版（Windows x64）](https://github.com/Yestugit/PixivCrawler/releases/download/v0.1.0/PixivCrawler-0.1.0-x64.exe)
- [下载免安装版（Windows x64 ZIP）](https://github.com/Yestugit/PixivCrawler/releases/download/v0.1.0/PixivCrawler-0.1.0-x64.zip)
- [查看全部 Releases](https://github.com/Yestugit/PixivCrawler/releases)

## 开发

需要 Node.js 22 或更高版本。

```powershell
npm install
npm run fetch:ffmpeg
npm run dev
```

`fetch:ffmpeg` 下载固定版本的 BtbN Windows x64 LGPL shared 构建并验证 SHA-256。
如果 GitHub 大文件下载中断，可直接重新运行，脚本会使用 `.part` 文件续传。

## 验证与打包

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run package:win
```

打包命令生成 NSIS 安装包和 ZIP 便携包。ZIP 解压版会把应用数据保存在程序旁的
`data` 目录；安装版使用 `%LOCALAPPDATA%/PixivCrawler`。也可在可执行文件旁创建
空的 `portable.flag` 文件，强制启用便携数据目录。

## 设计说明

- 登录 Cookie 只保留在 Chromium 的持久化会话中，不复制到界面或 SQLite。
- Pixiv 站点 AJAX 接口并非稳定公开 API；所有响应均经过运行时校验，结构变化会显示
  明确的适配器错误。
- 图片先写入 `.part`，支持 Range 续传，完成后原子改名；SQLite 和 `artwork.json`
  分别负责任务恢复/去重与开放归档元数据。
- 默认请求节奏保守，遇到 429 会遵循 `Retry-After` 或长时间指数退避。

本项目与 pixiv Inc. 无关。使用者应遵守 Pixiv 服务条款、作者权利和当地法律。

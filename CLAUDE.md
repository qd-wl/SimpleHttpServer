# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

一个基于 Node.js + Express 的单文件文件服务器：支持上传/下载、目录树、文件夹管理、回收站、搜索、空间占用统计和操作日志。无用户认证系统，仅适用于受信任网络环境。

## 常用命令

```bash
npm install    # 安装依赖
npm start      # 生产模式启动 (node server.js)
npm run dev    # 开发模式启动 (nodemon，自动重启)
```

- 端口通过 `.env` 中的 `PORT` 配置（默认 3000）。
- 没有测试套件、没有 lint 配置。
- 无构建步骤：前端是纯静态 HTML/JS/CSS，直接由 Express 提供。

## 架构

代码只有两个核心文件，没有框架分层：

- **`server.js`**：全部后端逻辑（Express 路由 + 文件系统操作），单文件、无路由拆分、无 controller/service 分层。
- **`public/index.html`**：全部前端逻辑（HTML + 内联 `<style>` + 内联 `<script>`），原生 JS，无构建工具、无前端框架。前后端通过 `/api/*` 的 `fetch` 调用通信。

### 三个持久化目录（运行时生成，已被 gitignore）

- `uploads/`：所有用户文件和文件夹的实际存储根目录。
- `trash/`：软删除后的文件实际存放位置；`trash/_meta.json` 记录原始路径、删除时间等元数据，用于还原。
- `logs/YYYY-MM-DD.log`：按天分文件的操作日志（NDJSON，一行一条 JSON），启动时通过 `loadLogs()` 全部读入内存数组 `operationLogs`（上限 `MAX_LOGS = 1000`）。

### 路径安全模型

所有涉及路径的 API 都必须通过 `resolveUploadPath(relativePath)`（server.js）解析，它会：
1. `path.normalize` 后 `path.resolve` 到 `UPLOAD_DIR` 下的绝对路径。
2. 校验解析结果没有跳出 `UPLOAD_DIR`（防目录穿越），否则抛出 `无效路径`。
3. 返回 `{ fullPath, relativePath }`，其中 `relativePath` 是相对于 uploads 根、用 `/` 分隔的规范化路径。

新增涉及文件系统路径的接口时，必须复用 `resolveUploadPath`，不要自行拼接路径。文件/文件夹命名相关的校验统一走 `validateItemName`（禁止路径分隔符）。

### 回收站机制

删除文件/文件夹（`DELETE /api/delete`）不会真正删除，而是：
1. `fs.renameSync` 移动到 `trash/<timestamp>_<原文件名>`；
2. 在 `trash/_meta.json` 中记一条以时间戳 id 为 key 的元数据（原路径、原名、是否文件夹、大小、删除时间）。

还原（`POST /api/trash/restore`）按元数据把文件移回原路径，若目标已存在则自动加序号重命名。只有在回收站里执行"彻底删除"（`DELETE /api/trash/delete`）或"清空回收站"（`DELETE /api/trash/clear`）才会调用 `fs.unlinkSync`/`fs.rmSync` 真正删除文件。

### 操作日志

几乎所有写操作（上传、创建文件夹、下载、删除、还原、彻底删除、重命名等）都会调用 `addLog(req, action, details)`：同时追加到内存数组 `operationLogs`（供 `GET /api/logs` 返回）和写入当天的日志文件。新增写操作时应同样调用 `addLog` 以保持日志完整性。

### 上传冲突处理

`multer` 的 `filename` 回调根据 `req.query.mode`（`replace` | `keep`）决定同名文件处理方式：`replace` 直接覆盖；`keep` 在文件名后追加递增序号（如 `文件 2.txt`）直到不冲突。前端在上传前会先调用 `GET /api/check-file` 探测冲突，再弹窗询问用户选择替换/保留两者/跳过。

## 关键约定

- 中文文件名处理：`multer` 收到的 `file.originalname` 需要 `Buffer.from(..., 'latin1').toString('utf8')` 转码，否则中文文件名会乱码。
- 所有 API 错误响应中，路径相关错误（`无效路径`、名称校验失败）返回 400，其余返回 500。
- 目录树接口 `GET /api/tree`（`buildTree`）与文件列表接口 `GET /api/files` 是两套独立的递归/单层遍历逻辑，修改目录展示相关功能时两处都要考虑。

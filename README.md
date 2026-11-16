# dsh-chat-work-tabs

给 **DeepSeek Harness（DSH）** 加上「聊天 / 工作」双入口。聊天模式直连 [chat.deepseek.com](https://chat.deepseek.com) 的网页接口，用的是你自己登录的账号——不是 API Key。

> 非官方项目。与 DeepSeek 官方无关，使用自己的账号，账号风险自担。

---

## 功能

- **新会话页双入口**：输入框上方「聊天 / 工作」切换
- **聊天页**：独立聊天界面，带对话历史、Markdown 渲染、停止回复
- **深度思考 / 智能搜索**：两个开关，对应网页端的 `thinking_enabled` 与 `search_enabled`
- **文件上传**：回形针按钮，走网页端的上传与解析接口
- **侧边栏「聊天」区**：列出网页账号的对话历史，可搜索、可拖拽调整高度
- **`deepseek-web` provider**：模型列表里只有**一个**条目，不污染选择器
- **纯对话 preset**：`chat` 预设不含任何工具，聊天模式读不到文件、跑不了命令

## 运行要求

- DSH（DeepSeek Harness）
- 一个已登录 chat.deepseek.com 的账号

## 安装

把本目录作为 bundle 装进 DSH profile（推荐用插件管理的 `install_bundle`，或本地 link 安装）。装好后重启 DSH。

## 凭据

### 方式一：一键登录（推荐）

侧边栏「聊天」分组右边的 🔌 按钮，或在列表报错时点「连接账号」。

会弹出一个**独立的浏览器窗口**（使用临时配置目录，不碰你日常浏览器的数据），在里面正常登录即可。登录成功后插件自动读取 token 与 HttpOnly cookie、写文件、关闭窗口并刷新列表。

- 需要本机有 Edge 或 Chrome；可用 `DSH_CHAT_BROWSER` 环境变量指定浏览器路径
- 用的是你自己登录的账号，凭据只写在本机 `$DSH_HOME`
- 未登录的访客也会拿到 userToken，因此插件会用 `users/current` 校验，确认是真实账号才接受

### 方式二：手动填写

插件读取 `$DSH_HOME/deepseek-web-auth.json`（默认 `~/.dsh/deepseek-web-auth.json`）：

```json
{
  "userToken": "{\"value\":\"<64 位 token>\",\"__version\":\"0\"}",
  "cookie": "ds_session_id=<uuid>; smidV2=...; ..."
}
```

获取方式：

1. 浏览器登录 chat.deepseek.com
2. DevTools → Console → `localStorage.userToken`（`userToken` 可以直接整体粘进去，代码会解包）
3. DevTools → Application → Cookies → `chat.deepseek.com`，复制需要的 cookie 拼成一行
   - `ds_session_id` 是 **HttpOnly**，`document.cookie` 里看不到，必须在 Cookies 面板复制

**没有 refresh token**，过期后重新登录一次即可。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host：注册 `deepseek-web` provider、启动回环桥 |
| `client.js` | 前端：双入口、聊天页、侧边栏历史区 |
| `lib/api.js` | 网页协议：PoW、SSE 解析、文件上传 |
| `lib/pow.js` + `lib/sha3_wasm_bg.wasm` | 工作量证明 |
| `lib/adapter.js` | LLM Adapter 实现 |
| `lib/history.js` | 会话列表与历史消息 |
| `lib/bridge.js` | `127.0.0.1:45871` 回环服务，供前端读写 |
| `cordis.patch.yml` | 声明 `preset-chat` 与插件本身 |

## 已知限制

- **只能聊天**：网页接口没有工具调用/函数调用能力
- **桥只监听本机**，CORS 仅放行 `http://127.0.0.1:*`、`http://localhost:*`、`dsh-app://app`
- 两个开关通过 `reasoningEffort`（`off` / `think` / `search` / `think-search`）传递，因此若在别处手动选到该 provider，会看到一个四档的思考档位控件
- 侧边栏与聊天层依赖官方 DOM 类名（`.mP3x-q_mainPanel`、`.an3WzG_root` 等），**DSH 升级后可能失效**
- `lib/sha3_wasm_bg.wasm` 取自 DeepSeek 网页端，用于通过其 PoW 校验，版权归 DeepSeek 所有

## License

MIT（不含 `lib/sha3_wasm_bg.wasm`）

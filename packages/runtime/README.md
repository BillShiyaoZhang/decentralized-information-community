# @information-community/runtime 0.1.0

可选的受治理社区运行时，运行在 Node 24.12+ 的 24.x，使用 SQLite。核心包 `@information-community/core@0.2.0` 仍可独立用于纯图和静态网站。

本包提供具名密码 + TOTP MFA、会话撤销、不可变内容与证据修订、配置式发布策略，以及隔离的私有工作流。无需复制平台的 server、scripts、adapters 或管理界面源码。参考界面包含公开搜索、登录和通用维护操作，也可用同源 API 接自己的页面。

## 固定产物安装

本包尚未发布到 npm registry。在平台仓库运行 `npm run package:runtime`，将产生两个 `.tgz`：

```sh
npm install --offline --ignore-scripts --no-audit --no-fund \
  ./vendor/information-community-core-0.2.0.tgz \
  ./vendor/information-community-runtime-0.1.0.tgz
npx --no-install community-runtime build
npx --no-install community-runtime start
```

使用方提供 `runtime.config.json` 和 `business.json`。完整可运行示例位于平台仓库 `examples/runtime/`，包括数据、配置、可选页面及 Docker 声明。运行数据目录由使用方配置，绝不放到已安装包目录。

```json
{
  "schemaVersion": 1,
  "mode": "server",
  "communityId": "my-community",
  "businessFile": "business.json",
  "contentFile": "content.json",
  "dataDirectory": ".runtime",
  "site": { "brand": "我的社区" },
  "uiDirectory": "ui",
  "maintenanceIntervalMs": 60000
}
```

`business.json` 的 `schemaVersion` 为 1，包含 `content` 策略和 `roles` 权限映射，可选 `lifecycle` 工作流。也可用 `contentProfileFile` / `lifecycleFile` 引用相对于业务配置文件的 JSON。所有配置路径限制在使用方目录中；`RUNTIME_CONFIG` 可以选择配置入口。`contentFile` 只在空数据库首次打开时导入，不发布内容，也不覆盖已有数据库。

## 具名身份与权限

设置私有 `RUNTIME_MFA_KEY` 为随机的 32 字节十六进制密钥。启用私有记录时同时设置 `RUNTIME_KEYRING`：

```json
{"activeVersion":"v1","keys":{"v1":"<64 hex characters>"}}
```

密钥由运行环境注入，不放入业务配置、产物、Git 或日志。CLI 的 `bootstrap <private-account.json>` 接受 `{id,displayName,password,totpSecret,roles}`；密码至少 14 字符，TOTP secret 是至少 32 字符的 Base32 值。可用包导出的 `generateTotpSecret()` 创建密钥，再注册到用户的验证器。引导操作不通过 HTTP 暴露。

密码使用 scrypt 加盐派生；TOTP secret 使用 AES-256-GCM，AAD 绑定账户 ID。登录必须同时提供密码和验证器验证码，已使用的 TOTP 时间步不可重放。失败计数保存在数据库，单账户及全局失败请求均有限流。会话 token 为 32 字节随机值，数据库只保存 SHA-256；最长 8 小时，空闲 30 分钟失效。每个受保护操作都在事务内检查账户、会话及权限，读取整个请求体之后才验证，避免撤销期间上传的请求获得旧权限。

`roles` 是角色名到权限数组的映射；角色名由使用方定义。支持 `content:read`、`content:edit`、`content:publish`、`content:visibility`、`lifecycle:self`、`lifecycle:manage`、`accounts:manage` 和 `operations:manage`。提交数据里的 author/reviewer 不授予权限。审计主体来自服务端验证的具名身份。

也可向 `createRuntimeApp` 注入可信 `auth.provider.authenticate(state, token, {now})`。它必须在事务内同步返回具名、已验证 MFA 且检查过撤销状态的 principal；异步结果被拒绝。这是可信本地验证器接口，不是允许客户端传入 principal 的接口，也不是完整 OIDC 客户端。开箱即用的可运行身份路线是内置 provider。

## HTTP / DTO / 错误契约 v1

所有响应使用 `Cache-Control: no-store`。生产环境应由同源 HTTPS 入口提供服务。受治理服务器只提供显式路由和构建所得 UI 资源，不将数据目录或任意静态目录映射成公开文件。

| 路由 | 契约 |
| --- | --- |
| `POST /api/auth/login` | `{accountId,password,code}` → `{token,expiresAt,principal}` |
| `GET /api/auth/me` | 有效 Bearer 会话 → principal |
| `POST /api/auth/logout` | 撤销当前设备会话，保留同意和私有记录 |
| `POST /api/auth/revoke` | `{sessionId}`；其他用户会话要求 `accounts:manage` |
| `POST /api/content/import` | content interchange v1；需要 `content:edit` |
| `POST /api/content/publish` | `{entityId,revisionId,expectedVersion}`；需要 `content:publish` |
| `POST /api/content/hide` | `{entityId,expectedVersion,hidden}`；需要 `content:visibility` |
| `POST /api/content/source` | `{entityId,expectedVersion,disposition}`；active / withdrawn / rights-expired |
| `GET /api/graph`, `/data/graph.json` | 同一个受控公开 Graph v1 投影 |
| `GET /api/list`, `/api/search?q=...&scope=...` | 当前可公开节点 DTO；scope 为 JSON 维度映射 |
| `GET /api/entities/:id`, `/:id/detail`, `/:id/history` | 公开详情或曾发布且当前仍可见的历史 DTO |
| `GET /api/revisions/:revisionId` | 按精确修订读取；同时检查实体当前与目标修订可公开性 |
| `GET /api/editor/revisions/:revisionId` | `content:read` 可读完整私有内容修订 |
| `GET /api/neighborhood?id=...&depth=...`, `/api/analysis` | 对同一个公开投影执行图计算 |
| `GET /api/export` | `kind: public-content-projection` 的白名单公开 DTO |
| `POST /api/private/command` | 可配置私有生命周期命令，见下文 |
| `GET /api/private/list` | 管理者可读摘要，无载荷、正文或内部备注 |
| `GET /api/private/:id` | 所有者或管理者可读详情；解密及读取审计在事务内完成 |
| `GET /api/public-results` | 配置允许的结果码/标签，只关联当前可公开实体及修订 |

发布、导入及可重放的私有写操作要求 `Idempotency-Key`（8–200 字符）。键按“主体 + 操作 + 键”隔离，并绑定规范化输入摘要。相同输入返回已保存结果，不重复审核；不同输入返回 `IDEMPOTENCY_CONFLICT`。撤回、退出及私有迁移不保存可重放结果。权限、版本、证据规则、指针切换、审计和结果都在同一个 SQLite 事务内提交，失败全部回滚。

错误为 `{error: string, code: string}`。401 表示无有效身份，403 表示权限/同意拒绝，409 表示并发或幂等冲突，410 表示私有数据过期，422 表示发布规则拒绝。引用错误使用 `REFERENCE_MISSING`、`REFERENCE_ENTITY`、`REFERENCE_POSITION`；不可变修改使用 `IMMUTABLE`。调用者应判断 `code`，不解析消息文案。无权公开的详情统一返回 404。

## 不可变内容与证据

模块 schemaVersion 为 1。实体 `{id,type,...externalFields}` 与修订 `{id,entityId,number,parentRevisionId,createdAt,data,extensions?}` 分离；实体的并发 version、公开指针、曾发布修订列表、隐藏状态属于运行时状态，不能通过普通导入写入。

导入格式是 `{schemaVersion:1,entities:[],revisions:[],citations:[],links:[]}`。修订、引用和关系只能追加；已有 ID 内容相等时幂等，不同则拒绝，不能删除。引用必须与内容修订同时创建，不能之后为旧修订补写证据。导入可以保留外部修订号、ID、父链、引用顺序和受支持扩展字段。

引用格式为 `{id,revisionId,sentenceId,sourceEntityId,sourceRevisionId,position,order}`，验证内容句子、来源实体、精确来源修订及位置。摘录位置 `{kind:'text',start,end}` 使用 JavaScript UTF-16 的左闭右开索引；链接型位置为 `{kind:'link'}`。来源新建修订不会改变旧答案的引用。

`entityTypes` 按 `role: content/source` 声明类型。领域 schema 支持 type、required、properties、additionalProperties、enum、items、长度/数量及数值界限，拒绝未知 schema 关键字，不宣称实现完整 JSON Schema。事实句种类、写入时是否要求引用、证据模式、摘录权利依据均可配置。

link-only 来源严格限制字段，只保存标题、URL 和外部身份元信息；正文、截图、内容哈希及可夹带正文的任意扩展字段被拒绝。excerpt 要求有效的配置权利依据与引用记录；权利过期会阻断公开。平台执行声明的约束，不自动判断内容事实或替代权利审核。

校园示例配置逐句引用，禁止 `impact: high` 和 `origin: ai_draft` 发布；人工点击也不能发布该 AI 修订，必须创建新的正式人工修订。复核逾期保留警示。范围在维度内 OR、维度间 AND，universal 总适用，主动筛选时 unknown 不匹配。检索支持配置别名。

`exportContent` 是包含完整私有历史的 SDK 迁移接口，只供可信离线操作或已鉴权服务器使用。公开导出不会包含未发布父修订、内部扩展、账户、审计或私有记录，因此不是完整备份，也不能冒充可往返恢复的历史快照。

## 私有工作流与生命周期

`business.lifecycle.workflows[type]` 配置初始状态、允许状态变化、终止状态、决定码、固定公开结果、retentionMs、requireConsent、purpose、consentVersion 和资格字段。HTTP 命令包括：

- `consent`：`{type,version,accepted,eligibility}`，返回 consentEpoch。
- `create`：`{id?,type,consentEpoch,payload,entityId?,revisionId?,externalId?}`。
- `transition`：`{id,expectedVersion,status,assignee?,decisionCode?,note?}`。
- `withdraw`：撤回当前主体，销毁载荷与关联，并使所有设备会话失效。
- `logout`：只使当前设备退出，不撤回同意。
- `retain`：重复安全的到期清理；`task`：调用可信维护提供方并记录成功/失败。
- `import`：仅空私有模块接受完整版本化快照；验证密文并使会话/幂等记录失效。

私有正文与内部备注整体 AES-256-GCM 加密。默认 AAD 为 `information-community:lifecycle:v1:<record ID>`。普通摘要不包含 payload；授权详情读取必须成功写入审计才返回明文。API 写入在事务中检查最新同意 epoch，撤回先提交则所有随后执行的在途写入都失败。已过期记录在清理任务运行前也不能读取详情。

清理将当前数据库的密文、主体/内容关联、外部标识、指派、决定和公开结果置空，并清除可关联审计和幂等记录。存储不是包含私有载荷的不可变状态快照，SQLite 启用 secure_delete。文件系统旧备份与其他存储副本仍必须按部署者保留策略清理；平台不声称可以回收外部复制品。

`community-runtime maintain` 使用内部维护身份，不依赖业务角色名。配置 maintenanceIntervalMs 后，服务器执行同一清理任务。自定义同步 taskProvider 可接外部备份健康证据；异常只记录稳定错误码，不记录敏感异常文本。异步任务应由外部执行器完成后提供已完成的结果，不在数据库事务中等待网络请求。

迁移旧指南密文时，`legacyIntakeKey`、`importLegacyIntakeEnvelope` 保留 `research-intake:v1:<ID>` 与旧 keyVersion。`migratePrivateRecord` 在 ID 改变时要求显式解密后重新加密，不能仅换 ID 复制密文。D1 表和校园字段的映射由使用方维护。

## 存储、迁移与升级

`RuntimeStore(filename,{communityId,modules})` 提供 `read()`、`transact(callback,{expectedRevision?})`、`backup()`、`restore(backup,options)` 和 `close()`。read 返回隔离副本；事务使用 `BEGIN IMMEDIATE`，拒绝异步 callback/返回值，所有模块验证成功才持久化。业务数据库、配置与 UI 都位于消费目录；安装升级不会覆盖它们。

可选扩展在 runtime config 的 `extensions` 中列出可信本地 ES module 路径；模块 default export：

```js
export default {
  name: 'business-extra', contractVersion: 1, schemaVersion: 2,
  initialState: () => ({ records: [] }),
  migrations: { 2: previous => ({ ...previous, records: previous.records ?? [] }) },
  validate(data, previous) { /* 同步验证数据及跨版本不可变条件 */ },
  validateState(state, previous) { /* 可选跨模块引用约束 */ }
};
```

模块数据在 `state.modules[name]`，schema 版本在 `state.moduleVersions[name]`；按目标版本依次执行 migrations。缺少迁移、模块缺失、降级或验证失败都拒绝打开，整次升级回滚。模块和 provider 是受信部署代码，不从请求体加载，不适合执行不可信插件。

runtime 0.1.x 支持运行时契约 1、内容/身份/生命周期 schema 1 和 core 0.2.0。0.x 次版本升级应先用副本验证；数据库迁移后不能直接用旧包降级，需恢复升级前备份或提供新的前向迁移。当前实现针对小型单库社区，事务同步执行，不提供多区域复制、跨库事务或 D1 在线适配器。

角色和生命周期配置随启动加载。内容 profile 作为已存数据的解释规则被固定；修改配置后，启动会提示 `CONFIGURATION_CHANGED`。用 `community-runtime configure-content` 显式校验所有历史再原子应用，失败保留原配置状态。收窄发布规则立即影响公开投影，不能通过修改规则偷偷改写旧修订。

备份命令要求显式新输出文件，不覆盖已有文件。私有备份包含内容状态、审计和密文，密钥另行保管；仅允许向空数据库恢复。恢复永远使所有会话与幂等结果失效，并清理到期数据。备份有私有主体时，必须提供已核对的撤回清单：

```sh
community-runtime backup /private/current-backup.json
community-runtime restore /private/current-backup.json /private/withdrawal-review.json
```

review 文件格式为 `{"withdrawnSubjectIds":["account-id"]}`。显式空数组代表管理员已核对没有额外撤回；未提供时拒绝恢复有主体的备份。该清单必须来自备份之外的当前删除登记：旧备份本身无法知道后来发生的撤回。恢复失败完整回滚；成功后用新会话重新登录。

## 公开性与页面扩展

受治理数据只支持在线服务模式。每次列表、详情、历史、图、检索、统计和导出都计算同一公开策略，无需要异步刷新的独立索引。隐藏实体或撤回来源后，平台随后处理的请求立即不可读取；已发送给读者的内容无法撤销。

`build` 只生成没有内容快照的 UI shell，`uiDirectory` 中可放 HTML/JS/CSS/SVG 页面，通过同源 API 取数据。扩展页面属于公开资源，不应写入秘密或硬编码受限内容。构建拒绝含未知旧产物的输出目录，防止旧 graph.json 或旧扩展页面残留；受治理 runtime 不提供含内容的静态发布命令。轻量 Graph v1 的 Pages 路线仍使用原来的工具。

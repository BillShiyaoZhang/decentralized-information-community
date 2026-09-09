# @information-community/runtime 0.3.0

可选的受治理社区运行时，运行在 Node 24.12+ 的 24.x，使用 SQLite。核心包 `@information-community/core@0.2.0` 仍可独立用于纯图和静态网站。

本包提供具名密码 + TOTP MFA、会话撤销、不可变内容与证据修订、配置式发布策略，以及隔离的私有工作流。无需复制平台的 server、scripts、adapters 或管理界面源码。参考界面包含公开搜索、登录和通用维护操作，也可用同源 API 接自己的页面。

## 固定产物安装

本包尚未发布到 npm registry。在平台仓库运行 `npm run package:runtime`，将产生两个 `.tgz`：

```sh
npm install --offline --ignore-scripts --no-audit --no-fund \
  ./vendor/information-community-core-0.2.0.tgz \
  ./vendor/information-community-runtime-0.3.0.tgz
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

也可向 `createRuntimeApp` 注入可信 `auth.provider`，或在 runtime config 中设置 `identityProvider` 为消费目录内的 ES module 路径，default export 为提供方。`authenticate(state, token, {now,participantsConfig})` 必须在事务内同步验证凭据和撤销状态；客户端不能提交 principal。MFA 身份返回 `{id,roles,sessionId,mfa:true}`；邀请身份明确返回 `{id,roles,sessionId,mfa:false,assurance:'invitation',eligibility}`，其中资格已经服务端核验。若有 subjectId，必须等于 id。

提供方还需同步实现 `revokeSession(state,principal,{sessionId,now,policy})`、`revokeSubject(state,subjectId,{now})` 和 `prepareRestore(state,options)`；私有 import 需要 `invalidateAll(state,{now})`。所有钩子只修改传入 state，不在事务外进行网络或其他不可回滚的写入。退出、撤回和恢复调用对应提供方，缺少钩子或返回 Promise 会拒绝操作；钩子抛错使整次事务回滚。SDK 恢复必须将同一个 provider 传给 `store.restore(backup,{provider,...review})`，CLI 自动衔接。提供方应独立核对当前撤销登记并使旧凭据全部失效；平台同时拒绝已撤回的主体。内置身份路线无需使用方实现这些钩子。

## 具名账户维护与恢复

0.3.0 提供可审计的**离线本地账户维护**。具备数据库所在主机写权限且经过业务授权的操作员，先设置 `RUNTIME_OPERATOR_ID` 为自己的稳定身份，再调用 `community-runtime accounts` 查看白名单账户摘要，或 `community-runtime account <private-change.json>` 执行变更。操作员 ID 是审计归属，由部署者核验；它不是密码、MFA 或主机权限的替代品。维护文件仅在受信主机保存并按凭据保管策略清理，不放入版本控制或公开 UI；命令行只传文件路径，不传秘密值。

```powershell
$env:RUNTIME_OPERATOR_ID = 'operations:alice'
npx --no-install community-runtime accounts
npx --no-install community-runtime account private-change.json
```

所有变更保持原 account/actor ID、显示名和内容/审计归属，要求显式 `accountId` 与刚读取的 `expectedVersion`。每次成功变更递增账户版本，并使该账户全部设备会话和主体级幂等结果失效；其他账户不受影响。重复提交旧版本或并发冲突返回 `ACCOUNT_VERSION_CONFLICT`，不会重复更新。命令结果仅含 `{id,displayName,roles,active,version,credentialsRequired,revokedAt}`，审计只记具名操作员、操作和目标标识，秘密不进入审计或重试缓存。无效私有 JSON 的诊断也不输出文件片段。

| action | 维护文件额外字段 | 行为 |
| --- | --- | --- |
| `credentials` | `password?`, `totpSecret?`，至少一个 | 轮换密码、TOTP 或同时替换；保留角色与停用状态 |
| `roles` | `roles: [...]` | 修改角色，并使旧会话立即失效 |
| `status` | `active: false/true` | 普通停用或重新启用；不清除同意，不建立永久撤销记录 |
| `revoke-sessions` | 无 | 退出目标账户全部设备；保持角色、状态和凭据 |

例如私有维护文件：

```json
{"action":"credentials","accountId":"editor-one","expectedVersion":0,"password":"<new-random-password>","totpSecret":"<new-Base32-secret>"}
```

替换占位符后执行；密码至少 14 字符，TOTP secret 使用 `generateTotpSecret()` 生成并安全登记到账户所有者的验证器。丢失 MFA 时，由业务核验身份及授权，再由具名离线操作员重新登记 TOTP；无需旧密码或旧验证码，也不需要修改密码散列或 MFA 密文。这个版本选择管理员重新引导作为恢复机制，不签发恢复码，不开放匿名找回或 HTTP 凭据维护入口。仅更新密码时保留 TOTP 重放计数；同一实际 HMAC 密钥的不同 Base32 表达也不能重置已用验证码计数。

SDK 对应 `inspectAccountsOffline(store,{operatorId})` 和 `maintainAccountOffline(store,input,{operatorId,mfaKey,now?})`；密码单独轮换无需 MFA 解密密钥，TOTP 变更需要配置密钥。调用方必须是有数据库访问权的可信离线代码，不能把这些函数直接包成接收客户端 operatorId 的路由。CLI 在配置外部 identityProvider 时拒绝本地账户维护；外部提供方由自己的管理服务维护，内置恢复锁定策略仍保护备份中的本地账户。

永久撤销与普通停用严格分离：`revokeIdentitySubject` 与隐私撤回为主体保留永久撤销记录，即使只启用 auth 模块也不能通过重新启用、凭据重置或 bootstrap 复活。恢复旧备份时，所有内置账户的密码派生值和 MFA 密文清空，`credentialsRequired:true`；必须经过新的具名审核并同时提供新密码和新 TOTP 才能登录，单独启用 active 不会解锁。原 ID、历史归属和普通停用状态保留；已永久撤销账户不能重新引导。

## 可选邀请参与者与受限匿名报告

0.2.0 增加 `business.participants` 与 `business.anonymousReports`，默认关闭。标准 CLI 自动注册对应 schema 1 模块；SDK 手动使用 `participantsModule` / `reportsModule`，并传给 `createRuntimeApp` 的 `auth.participants` / `anonymousReports`。例如：

```json
{
  "participants": {
    "role": "participant", "invitationTtlMs": 86400000,
    "sessionTtlMs": 28800000, "idleTtlMs": 1800000,
    "selfService": { "actions": ["consent", "create", "withdraw", "logout", "list"], "types": ["private_intake"] }
  },
  "anonymousReports": {
    "type": "report", "fields": { "message": { "maxLength": 2000, "required": true } },
    "rateLimit": { "max": 20, "windowMs": 60000 }, "receiptTtlMs": 604800000
  }
}
```

邀请由具备 MFA 与 `accounts:manage` 的管理员签发，或通过离线 `community-runtime invite reviewed-eligibility.json`。输入仅 `{subjectId?,eligibility:{...已审核布尔字段}}`；省略主体 ID 时平台生成 `participant:` 前缀 ID。已有主体的新邀请用于另一设备，不能重新登记已撤回主体。CLI 返回一次性 token，交付给已审核参与者；不要把输出写入公共日志。客户端仅提交 token 兑换，会话不注册密码或 TOTP。邀请与会话由平台生成 32 字节随机值，只存哈希；兑换、期限与重放判断在同一事务内。邀请最长七天、会话最长一天、空闲期限最长一小时，配置可缩短。

错误签发的单张邀请可通过 `community-runtime cancel-invitation invitation.json`（设置具名 RUNTIME_OPERATOR_ID）或管理员 HTTP 取消，输入 `{invitationId}`。SDK 使用事务内 `cancelParticipantInvitation(state,input,{now})`。取消不改变主体资格、其他邀请或已有设备；已兑换或已过期邀请不能作为待兑换邀请取消。重复取消返回同一取消状态。

邀请身份只允许明确配置的 self 动作和工作流类型，权限映射仍须含 `lifecycle:self`。即使误给参与者角色配置管理权限，也不能调用编辑发布、队列、账户或运维入口。参与者 consent 的资格来自凭据中已审核的 eligibility，不能由请求的 eligibility 字段提升。撤回清理记录并永久撤销该主体的全部设备和未兑换邀请；单设备退出保留同意。读取完整请求体后再次在事务中认证，因此上传期间退出/撤回会阻断后续写入。

`lifecycleSelfList(state,principal,{config,participants,policy,now})` 与本人列表 API 返回白名单状态摘要（含配置允许的 result），过滤所有权、到期、撤回与同意资格；未关联公开内容的待处理记录也能返回。摘要无需密钥或正文解密，不包含内部备注、指派或原始决定码。邀请身份不开放私有详情。

匿名报告是独立的最小字符串 DTO 入口，只接受 `fields` 配置的字段和长度；目标工作流必须无需研究同意或资格。它不会创建可登录账户，也不开放通用私有命令。数据库中的全局窗口限流跨重启生效，不信任客户端 IP 转发头。成功返回 `{receipt,expiresAt}`，仅持高熵回执者可读该报告的摘要；回执通过 Authorization Bearer 传输，不放 URL。可省略 Idempotency-Key；需要安全重试时，客户端先用加密随机数生成 32 字节 base64url 键（43 字符），同一请求复用它。平台保存键哈希和加密回执以供同一 DTO 重试，冲突拒绝，成功重放不占用额外配额。不要使用常见短键，否则请求会被拒绝。回执、幂等响应均随 TTL 失效，恢复使旧回执失效。

启用参与者后的恢复还要求当前 `revokedSubjectIds` 登记，格式例如 `{"withdrawnSubjectIds":[],"revokedSubjectIds":[]}`；显式空数组表示已经核对。恢复清除所有旧邀请和会话，即使它们在备份中未过期；撤销登记中备份未知的 ID 也会保留为永久撤销记录。重新访问需要审核后签发新邀请。旧备份应先按原模块配置恢复，再启用新增模块；数据库中已有模块时不可直接删掉相应配置或降级为旧包。

## HTTP / DTO / 错误契约 v1

所有响应使用 `Cache-Control: no-store`。生产环境应由同源 HTTPS 入口提供服务。受治理服务器只提供显式路由和构建所得 UI 资源，不将数据目录或任意静态目录映射成公开文件。

| 路由 | 契约 |
| --- | --- |
| `POST /api/auth/login` | `{accountId,password,code}` → `{token,expiresAt,principal}` |
| `GET /api/auth/me` | 有效 Bearer 会话 → principal |
| `POST /api/auth/logout` | 撤销当前设备会话，保留同意和私有记录 |
| `POST /api/auth/revoke` | `{sessionId}`；其他用户会话要求 `accounts:manage` |
| `POST /api/participants/invitations` | MFA + `accounts:manage`；`{subjectId?,eligibility}` → 一次性邀请，不缓存 token |
| `POST /api/participants/cancel-invitation` | MFA + `accounts:manage`；`{invitationId}` → 仅取消指定未兑换邀请，保留其他设备与邀请 |
| `POST /api/participants/redeem` | `{token}` → 邀请参与者会话；不接受角色或 MFA 字段 |
| `POST /api/participants/revoke` | MFA + `accounts:manage`；`{subjectId}` → 永久撤销主体凭据 |
| `GET /api/private/self` | 配置开放的本人状态摘要，使用 Bearer 会话 |
| `POST /api/reports` | 配置开放的匿名最小 DTO → `{receipt,expiresAt}` |
| `GET /api/reports/status` | Bearer 回执 → 单份报告状态摘要，无正文和备注 |
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
| `GET /api/private/:id` | MFA 所有者或管理者可读详情；解密及读取审计在事务内完成 |
| `GET /api/public-results` | 配置允许的结果码/标签，只关联当前可公开实体及修订 |

发布、导入及可重放的私有写操作要求 `Idempotency-Key`（8–200 字符）。键按“主体 + 操作 + 键”隔离，并绑定规范化输入摘要。相同输入返回已保存结果，不重复审核；不同输入返回 `IDEMPOTENCY_CONFLICT`。撤回、退出及私有迁移不保存可重放结果。权限、版本、证据规则、指针切换、审计和结果都在同一个 SQLite 事务内提交，失败全部回滚。

错误为 `{error: string, code: string}`。401 表示无有效身份，403 表示权限/同意拒绝，409 表示并发或幂等冲突，410 表示私有数据过期，422 表示发布规则拒绝。引用错误使用 `REFERENCE_MISSING`、`REFERENCE_ENTITY`、`REFERENCE_POSITION`；不可变修改使用 `IMMUTABLE`。调用者应判断 `code`，不解析消息文案。无权公开的详情统一返回 404。

## 不可变内容与证据

模块 schemaVersion 为 1。实体 `{id,type,...externalFields}` 与修订 `{id,entityId,number,parentRevisionId,createdAt,data,extensions?}` 分离；实体的并发 version、公开指针、曾发布修订列表、隐藏状态属于运行时状态，不能通过普通导入写入。

导入格式是 `{schemaVersion:1,entities:[],revisions:[],citations:[],links:[]}`。修订、引用和关系只能追加；已有 ID 内容相等时幂等，不同则拒绝，不能删除。引用必须与内容修订同时创建，不能之后为旧修订补写证据。导入可以保留外部修订号、ID、父链、引用顺序和受支持扩展字段。

引用格式为 `{id,revisionId,sentenceId,sourceEntityId,sourceRevisionId,position,order}`，验证内容句子、来源实体、精确来源修订及位置。摘录位置 `{kind:'text',start,end}` 使用 JavaScript UTF-16 的左闭右开索引；链接型位置为 `{kind:'link'}`。来源新建修订不会改变旧答案的引用。

`entityTypes` 按 `role: content/source` 声明类型。领域 schema 支持 type、required、properties、additionalProperties、enum、items、长度/数量及数值界限，拒绝未知 schema 关键字，不宣称实现完整 JSON Schema。事实句种类、写入时是否要求引用、证据模式、摘录权利依据均可配置。

link-only 来源严格限制字段，只保存标题、URL、来源元信息和可选到期时间；正文、截图、内容哈希及可夹带正文的任意扩展字段被拒绝。excerpt 要求有效的配置权利依据与引用记录。两种来源都通过 `data.rights.expiresAt` 声明到期时间，并在 `now >= expiresAt` 时阻断发布与所有公开读取，包括历史、图计算及公开导出；无需额外定时隐藏任务。平台执行声明的约束，不自动判断内容事实或替代权利审核。

从 0.1.1 起，link-only 的 `rights` 只允许可选 `expiresAt`，值为有效 UTC ISO 时间；不需要摘录模式的 basis/reference，也不允许夹带任何其他字段。例如来源修订的 data：

```json
{"title":"学校主页","url":"https://example.org/university","mode":"link-only","rights":{"expiresAt":"2099-01-01T00:00:00Z"}}
```

旧数据不带 rights/到期时间时保留原有语义。迁移指南的 `rights_expires_at` 时，应将非空 Unix 秒转换为 UTC ISO，保存到上述字段；无到期时间则省略。不要丢弃已有期限，也不要为表达期限把来源改成 excerpt。期限属于不可变来源修订，后续更改需建立新修订及相应引用。

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
- `import`：仅空私有模块接受完整版本化快照；验证密文、引用及当前工作流语义，成功后使会话/幂等记录失效。

工作流导入与正常写入复用相同的语义校验：type/status 必须存在于当前配置，decisionCode 必须属于允许决定码，终态需要决定码；publicResult 必须与该决定码对应的配置结果完全一致。没有决定码或没有配置结果时，只允许 publicResult 为 null。已清理记录的决定码与结果保持 null，不因保留终态而被误判为缺少决定。任何不兼容记录都会拒绝整个导入，保留原会话、数据、审计和幂等状态；旧记录需由使用方显式映射到当前工作流，不能在导入时默许任意结果文本。

SDK 的 `lifecyclePublicResults(state, { config: business.lifecycle, now })` 需要显式传入当前工作流配置。缺配置、状态不兼容或结果不匹配时不返回该结果；有效结果的 code/label 从配置生成。HTTP 入口自动传入部署配置。可信离线完整 restore 仍按原有信任边界接受结构有效的历史状态，但恢复的记录同样不能绕过公开投影的配置检查。

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

runtime 0.3.0 使用运行时契约 1、auth schema 2、其他内置模块 schema 1 和 core 0.2.0。打开旧数据库或恢复旧备份时，auth schema 1 自动原子迁移到 2；正常升级保留活跃账户的凭据与会话，恢复备份则强制重新引导凭据。旧版没有可恢复停用契约，因此历史 `active:false` 保守迁移为永久撤销，防止复活旧版仅以停用标记执行的主体撤销。若存在业务自定义状态，请先核对迁移副本。0.x 次版本升级应先用副本验证；schema 升级后旧包会拒绝打开，不能直接降级。当前实现针对小型单库社区，事务同步执行，不提供多区域复制、跨库事务或 D1 在线适配器。

0.1.0 → 0.1.1 不需要数据库 schema 迁移。新增 link-only 到期元数据需要 0.1.1 或更新版本读取；直接使用 `lifecyclePublicResults` 的应用必须补传 config，否则安全地返回空列表。私有 import 现在会拒绝过去曾被放行的不兼容快照，应先在迁移映射中修正，而不是放宽公开校验。

角色和生命周期配置随启动加载。内容 profile 作为已存数据的解释规则被固定；修改配置后，启动会提示 `CONFIGURATION_CHANGED`。用 `community-runtime configure-content` 显式校验所有历史再原子应用，失败保留原配置状态。收窄发布规则立即影响公开投影，不能通过修改规则偷偷改写旧修订。

备份命令要求显式新输出文件，不覆盖已有文件。私有备份包含内容状态、审计和密文，密钥另行保管；仅允许向空数据库恢复。恢复永远使所有会话与幂等结果失效，并清理到期数据。备份有私有主体时，必须提供已核对的撤回清单：

```sh
community-runtime backup /private/current-backup.json
community-runtime restore /private/current-backup.json /private/withdrawal-review.json
```

review 文件格式为 `{"withdrawnSubjectIds":["account-id"],"revokedSubjectIds":["permanently-revoked-id"]}`。有具名账户或邀请主体时必须提供当前 revokedSubjectIds；有私有同意主体时还需 withdrawnSubjectIds。显式空数组代表已经核对，缺少所需清单会拒绝恢复。清单必须来自备份之外的当前删除/撤销登记，未知 ID 也保留为永久撤销记录。恢复失败完整回滚；成功后内置具名账户须先经离线完整凭据重新引导，再登录，旧凭据不会静默恢复可用。

## 公开性与页面扩展

受治理数据只支持在线服务模式。每次列表、详情、历史、图、检索、统计和导出都计算同一公开策略，无需要异步刷新的独立索引。隐藏实体或撤回来源后，平台随后处理的请求立即不可读取；已发送给读者的内容无法撤销。

`build` 只生成没有内容快照的 UI shell，`uiDirectory` 中可放 HTML/JS/CSS/SVG 页面，通过同源 API 取数据。扩展页面属于公开资源，不应写入秘密或硬编码受限内容。构建拒绝含未知旧产物的输出目录，防止旧 graph.json 或旧扩展页面残留；受治理 runtime 不提供含内容的静态发布命令。轻量 Graph v1 的 Pages 路线仍使用原来的工具。

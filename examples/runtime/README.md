# 仓库外消费示例

复制本目录到独立仓库，维护数据、JSON 业务配置、可选 UI 和部署声明即可。示例的 `content-profile.json` 演示校园规则，`content.json` 含合成的旧 D1 ID、父修订、逐句引用和摘录许可，不是生产校园内容。

1. 在平台仓库执行 `npm run package:runtime`。
2. 将两个 `.tgz` 放入消费目录 `vendor/`。
3. 在消费目录运行 `npm install --offline --ignore-scripts --no-audit --no-fund`，提交依赖声明、vendor 和 lockfile。
4. 为运行环境设置随机 `RUNTIME_MFA_KEY`（64 hex）及 `RUNTIME_KEYRING`（参见包文档）。
5. 创建仅本机可读的 `private-account.json`，包含具名账户 id/displayName、强密码、验证器已登记的 Base32 totpSecret 与角色。维护示例可赋 content_editor 和 content_reviewer；私有流程按需加 participant/pilot_operator。
6. 执行 `npm run bootstrap -- private-account.json`，随后删除本机引导文件；MFA secret 不出现在应用日志。
7. `npm run build` 后 `npm start`，打开 http://127.0.0.1:4180。初次导入不会发布；使用密码与 MFA 登录，在发布操作中提交下面的 JSON。

```json
{"entityId":"guide-answer","revisionId":"answer-revision-17","expectedVersion":0}
```

此后搜索“西浦”能找到示例答案，重启仍保留公开指针。选择来源处置，提交 `{"entityId":"guide-source","expectedVersion":0,"disposition":"withdrawn"}`，答案会同时从公开查询、历史、图计算和导出消失。来源新建修订也不会改写旧答案的固定证据引用。

报告闭环：以 participant 提交私有命令 `{"action":"create","id":"report-1","type":"report","consentEpoch":0,"entityId":"guide-answer","revisionId":"answer-revision-17","payload":{"message":"需复核"}}`；管理者可先将其从 submitted 改到 triage，再携带新 expectedVersion 改到 resolved 并给出 corrected 决定码。内部备注加密，公开处理结果仅在相关内容可公开时显示。

研究线索使用 private_intake 类型。参与者无需具名密码/TOTP 账户：管理者线下核验资格后，将 `{"eligibility":{"eligible":true,"adult":true}}` 写入私有审核文件，执行 `npx --no-install community-runtime invite reviewed-eligibility.json`，安全交付一次性 token。打开 `/extensions/participate.html` 兑换邀请，确认同意，提交线索并查看本人状态。另一个设备由管理者为相同 subjectId 签发新邀请；同一邀请不能重用。页面只保存内存会话，刷新后需新邀请。withdraw 清理载荷和关联并退出所有设备；logout 只退出本设备。

资格来自管理员签发记录，页面不能自报提升。示例 consent 文本仅演示流程，正式同意文本、资格核验、字段、保留时间和试点口径由消费仓库维护。编辑发布及私有队列管理依然使用具名 MFA；需要在线签发邀请的管理员另配 `accounts:manage`。

同一页面的匿名隐私报告无需加入研究，仅接受 message（最多 2000 字符），返回高熵状态回执。只有持回执者可查询该报告的摘要。示例按全库每分钟 20 次限制，匿名入口不能调用通用私有命令。业务 JSON 可禁用或调整这两条可选路线。

恢复启用参与者的备份需核对当前撤回及凭据撤销登记，并传入 `{"withdrawnSubjectIds":[],"revokedSubjectIds":[]}`；空数组同样表示已核对。恢复后所有旧邀请、会话及匿名回执失效，撤回主体不能重新签发。

具名账户维护使用 runtime 0.3.0 的离线命令，不需要另写账户服务。在经过业务授权的受信主机设置 `RUNTIME_OPERATOR_ID` 为实际操作员身份，执行 `npx --no-install community-runtime accounts` 获取 account ID 和 version，再执行 `npx --no-install community-runtime account private-change.json`。例如维护文件为 `{"action":"credentials","accountId":"editor-one","expectedVersion":0,"password":"<new-random-password>","totpSecret":"<new-Base32-secret>"}`；真实秘密仅放私有文件，并安全交付新验证器密钥。凭据轮换保持同一 actor ID 和历史归属，同时退出该账户全部设备。

同一命令支持 `roles`（附 roles 数组）、`status`（附 active 布尔值）和 `revoke-sessions`，均要求最新 expectedVersion。普通停用可重新启用，永久撤销或隐私撤回不能重新激活。MFA 丢失由操作员完成核验后重新引导，没有匿名找回入口。备份恢复会清空所有具名账户凭据：读取 accounts 中的新 version 后，同时重新配置密码和 TOTP；只重新启用状态不解锁账户。具名账户备份即使未开启参与者模块，也要求当前 revokedSubjectIds 清单。

升级会将 auth schema 1 迁移到 2；旧版 active:false 保守视为永久撤销，升级前应核对副本。错误的未兑换邀请可用 `cancel-invitation invitation.json` 单独取消，文件只含 invitationId，其他设备和邀请保留。

Docker 部署先完成引导，使私有账户进入持久化 volume。可先 `docker compose run --rm -v <private-account-file>:/run/account.json:ro community npm run bootstrap -- /run/account.json`，随后 `docker compose up --build -d`。环境变量通过部署环境或未提交的 .env 注入。Dockerfile 不复制引导文件、备份或本地数据；volume 保存运行时状态。

独立安装、构建、具名 MFA 写入、重启及替换包的自动验收见平台的 `tests/runtime-package.test.mjs`；其他模块测试验证回滚、引用、隐私、恢复和生命周期。完整协议见安装包 README 与平台 `docs/runtime.md`。

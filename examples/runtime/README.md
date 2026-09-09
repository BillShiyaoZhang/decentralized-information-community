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

研究线索使用 private_intake 类型，先提交当前版本的 consent、确认 eligible/adult，再带返回的 consentEpoch 创建。withdraw 清理载荷和关联并退出所有设备；logout 只退出本设备。说明、资格、同意文本、字段、保留时间和试点业务口径由消费仓库决定。

Docker 部署先完成引导，使私有账户进入持久化 volume。可先 `docker compose run --rm -v <private-account-file>:/run/account.json:ro community npm run bootstrap -- /run/account.json`，随后 `docker compose up --build -d`。环境变量通过部署环境或未提交的 .env 注入。Dockerfile 不复制引导文件、备份或本地数据；volume 保存运行时状态。

独立安装、构建、具名 MFA 写入、重启及替换包的自动验收见平台的 `tests/runtime-package.test.mjs`；其他模块测试验证回滚、引用、隐私、恢复和生命周期。完整协议见安装包 README 与平台 `docs/runtime.md`。

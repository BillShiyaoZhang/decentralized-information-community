# 可选 runtime 与平台需求

2026-09-09，评估 issue [#3](https://github.com/BillShiyaoZhang/decentralized-information-community/issues/3)、[#4](https://github.com/BillShiyaoZhang/decentralized-information-community/issues/4)、[#5](https://github.com/BillShiyaoZhang/decentralized-information-community/issues/5)、[#6](https://github.com/BillShiyaoZhang/decentralized-information-community/issues/6)：均合理。基线 6a567f4 的 core 只能独立分发纯函数，server 依赖仓库源码、共享写令牌和全图快照；确实不能承接指南已有的不可变证据、审核或私有工作流。四项允许可选模块、可替代存储和在线服务部署，没有要求给静态图应用强加全部业务限制。

当前实现为 `@information-community/runtime@0.3.0` + `@information-community/core@0.2.0` 固定 tgz、Node 24.12 和 SQLite。受治理内容走服务端；原 core、Pages 与轻量服务器继续独立使用。

| Issue | 实现和验收入口 |
| --- | --- |
| #3 外部消费/配置/存储迁移 | runtime CLI、SQLite 事务、版本化模块接口、独立示例、runtime-package/store/build/restore 测试 |
| #4 不可变修订/固定证据 | content 模块、领域 profile、精确引用、原子导入与 content 测试 |
| #5 真实身份/发布/公开读取 | 内置密码+TOTP MFA provider、配置权限、事务审核与幂等、统一投影、auth/http 测试 |
| #6 私有工作流/撤回/生命周期 | lifecycle 模块、AES-GCM、同意 epoch、状态机、清理任务、受控迁移、lifecycle/restore 测试 |

上手见 [独立消费示例](../examples/runtime/README.md)，具体 API、配置、DTO、版本和迁移契约见 [runtime 包文档](../packages/runtime/README.md)。

## 0.1.1：新增评论复核

[#4 新评论](https://github.com/BillShiyaoZhang/decentralized-information-community/issues/4#issuecomment-5600652340) 合理：0.1.0 的 link-only 白名单拒绝到期字段，来源可用性又只对 excerpt 判断期限，迁移时会丢失原有公开约束。0.1.1 支持 link-only 的 `data.rights.expiresAt`，保留无正文模式，在到期前/等于/之后统一执行列表、历史、修订直达、导出和图派生读取策略。

[#6 新评论](https://github.com/BillShiyaoZhang/decentralized-information-community/issues/6#issuecomment-5600635340) 合理：普通工作流管理导入不是可信离线完整恢复，不能把快照提供的任意结果视为已批准文案。0.1.1 让 import 复用正常写入的类型、状态、决定码与结果映射校验，错误快照完整回滚；公开投影要求当前配置，重新验证并从配置生成结果。合法配置结果仍可导入、备份和恢复。

两项修复不改变数据库 schema；SDK 直接调用 `lifecyclePublicResults` 时需要传入 `{ config: business.lifecycle, now }`。HTTP 与 CLI 服务已自动接入当前业务配置，详见包文档中的升级说明。

## 0.2.0：参与者身份与受限匿名报告

[#7](https://github.com/BillShiyaoZhang/decentralized-information-community/issues/7) 合理：资格已核验的邀请参与者不应伪装成具名 MFA 编辑；参与者本人活动摘要和受限匿名隐私报告也不能由管理者列表或公开结果替代。

新增可选 participants / reports 模块、按操作的邀请认证保证级别、一次性邀请、设备会话、永久主体撤销、撤回联动、本人摘要与匿名回执。发布/编辑/队列/账户/运维继续要求 MFA。标准 CLI 装载 JSON 策略和可选可信身份提供方，消费示例提供少量 HTML/JS 页面。资格核验、同意文本和业务窗口仍由消费方维护。

恢复需要独立当前撤销登记，并使旧邀请、会话与回执失效；自定义提供方的认证、退出、撤回与恢复钩子均在同步事务中执行，失败完整回滚。具体配置和接口见包文档。

## 0.3.0：具名账户维护与安全恢复

[#8](https://github.com/BillShiyaoZhang/decentralized-information-community/issues/8) 合理：创建账户与永久主体撤销不能替代既有账户的凭据轮换、可恢复停用和 MFA 丢失后的恢复。采用 issue 允许的具名受信离线 SDK/CLI 路线，保持稳定 actor ID；不要求指南维护密码散列、MFA 密文或会话数组。

新增账户摘要、密码/TOTP 维护、角色调整、普通停用/启用和目标全部会话撤销。账户版本检查、凭据、会话、目标幂等记录及具名审计同步提交，错误和重复旧版本请求原子拒绝。管理员离线重新引导是明确的 MFA 恢复机制；HTTP 不开放凭据维护。单独取消未兑换邀请的非阻塞补项也已完成。

auth schema 升级为 2，其他模块保持 1。打开旧库保留活跃账户；旧版 active:false 保守迁移为永久撤销。恢复旧备份要求独立当前撤销登记，清除所有内置具名凭据并强制完整重新引导；普通启用不能绕过该要求，已永久撤回的主体不可重建。正常升级与备份恢复使用同一原子模块迁移路径。

## 指南接入边界

平台执行通用机制：存储事务、不可变 ID/父链/引用、身份验证、授权、发布、读取投影、加密队列和生命周期。指南维护 Topic/AnswerCard 等字段映射、来源权利依据、角色分配、逐句证据规则、适用范围、别名、警示文案、状态枚举、同意说明与保留参数。

现有 D1 的 SQL schema 不由平台猜测转换。使用方把 ArtifactRevision / AnswerCardRevision / SentenceCitation 等映射为 content interchange v1，保持旧 ID、修订号、父链和顺序。导入只能创建未发布实体；审核发布由正常 API 执行。完整运行时备份可保留既有公开指针与审计，但恢复是空库上的显式离线行政操作，清除旧会话并执行撤回对账。

私有记录的外部 ID 和密钥版本应保留；指南现有 `research-intake:v1:<record ID>` AAD 有专门转换帮助函数。需要改 ID 时必须解密后重新加密。尚未把真实指南的数据、账户或运行部署迁入本仓库；示例和测试使用合成数据，不会修改相邻业务仓库。

## 兼容性与限制

runtime 是第一版可验收产物，尚未发布 npm registry。它提供单库 SQLite 路线，不提供 D1 在线驱动、多区域复制或账号自助找回。账户引导由离线 CLI 执行，正常登录与会话撤销由包内服务执行。迁移、恢复、密钥保管和 TLS 入口由受信部署者管理。

公开导出是经过可见性筛选的 DTO，不是私有备份。静态构建只生成无内容的页面，不能把受治理内容部署到永久静态副本后仍声称支持立即撤回。原 Pages 模式仍适用于已明确可公开、通过 Git 维护的图数据。

旧备份不知道之后的撤回事实；有私有主体的恢复要求来自当前删除登记的显式核对清单，并在同一事务清理过期载荷。外部历史备份的保留/销毁和健康证据可由维护提供方管理。该边界避免将当前库的删除误称为对外部副本的远程删除。

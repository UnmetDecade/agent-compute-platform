# 按角色智能分配

ITSS 保留调度器、构建机、租约、fencing、工件、工作流这套执行模型，
只把"按任务类型派发"换成**按业务角色分配**：用户定义角色、把角色分配给已注册的
构建机、发布计划；调度器按这些规则把请求路由到对应角色。它不会在每次请求时
临时推断目标机器。

运维只需要写两段自然语言：每个角色"做什么、怎么操作"，以及整个项目的
**分配计划**（"什么样的请求交给谁，之后交给谁"）。调度器在保存计划时把这段话
**编译一次**成确定性规则并存下来，之后每次请求都按存下的规则匹配；运行期不调用
模型推断路由。编译结果会在界面上展开给运维确认，确认后再激活。

English: [role-allocation.md](role-allocation.md)

## 两个角色维度

| 维度 | 取值 | 由谁决定 |
| --- | --- | --- |
| 执行角色 | `scheduler`、`builder` | 镜像 / 实例配置 |
| 业务角色 | `ui-dev`、`driver-dev`、`code-review`、`test-bench` … | 用户，运行时配置 |

构建机容器只以 `ROLE_ID=builder` 启动并上报能力集；业务角色是数据库里的行
（`business_roles`）和分配关系（`instance_roles`）。镜像里不写死"界面""驱动"
之类角色，所以同一镜像可服务任意项目。

能力（capability）仍是物理事实：`repo:write` 表示这台机器可写主仓库，
`board:v851s` 表示接了板子。业务角色声明它需要的能力；构建机当前没有该能力时，
分配会被拒绝。

## 数据模型

```sql
business_roles   (role_key PK, project, name, description, operation_prompt,
                  required_capabilities[], allowed_paths[], workdir_template, enabled)
instance_roles   (instance_id → role_instances, role_key → business_roles,
                  weight, assigned_by, assigned_at)          -- 用户分配
allocation_plans (plan_id PK, project, name, version,
                  status DRAFT|ACTIVE|DISABLED, document jsonb, document_text)
tasks            (…, business_role, plan_id)
```

`operation_prompt` 是运维写的角色操作说明（自然语言），创建角色时只需要
项目、显示名称、说明和它；`role_key` 由调度器从名称推导（中文名取哈希后缀），
默认 workdir 是 `/work/{project}/work/{role}`，能力和允许路径留空。需要精细控制时
仍可通过 API/manifest 显式给出这些字段。

`document_text` 是运维写的分配计划原文，`document` 是编译后的规则文档。两者都保存：
原文用于再次编辑和审计，规则才是真正执行的依据。

每个项目同一时间最多一个 `ACTIVE` 计划。激活计划时，每条规则编译成一个
`workflow_templates` 行（`plan.<plan_id>.<rule_id>`），请求直接启动这套工作流，
复用平台既有的状态机、重试与事件。

## 计划文档

```jsonc
{
  "rules": [
    {
      "id": "ui",                       // 计划内唯一
      "priority": 20,                   // 越大越优先
      "match": {                        // 列出的维度必须全部匹配
        "category": ["ui"],
        "keywords": ["界面", "page"],   // 命中任一关键词即可
        "path_prefix": ["ui/"],
        "subsystem": ["middle"],
        "task_type": ["task.build"]
      },
      "role": "ui-dev",                 // 第一阶段的角色
      "build": {
        "instruction": "修复上报的界面问题。",
        "prepare_command": "bash /scripts/sync-worktree.sh",
        "post_command": "bash /scripts/collect-changes.sh",
        "timeout_seconds": 1800
      },
      "capabilities": ["repo:read"],
      "chain": [                        // 后续阶段，各自拥有角色
        { "role": "code-review",
          "build": { "command": "bash /scripts/apply-changes.sh", "mode": "command" } },
        { "role": "test-bench",
          "build": { "command": "bash /scripts/run-tests.sh", "mode": "command" },
          "capabilities": ["board:v851s"] }
      ]
    },
    { "id": "fallback", "priority": 0, "match": { "any": true }, "role": "ui-dev", "chain": [] }
  ]
}
```

匹配是确定性的：**优先级降序 → 匹配维度数降序 → 声明顺序**。`match.any` 最多一条。
没有规则匹配的请求直接拒绝（`NO_RULE_MATCHED`），绝不猜测。

创建/激活时校验：角色存在且启用、任务类型存在、规则 id 唯一、每个链式阶段必须
定义 `build.command` 或 `build.instruction`。

### 自然语言计划：保存时编译一次

运维不需要手写上面的 JSON。计划页只有一个文本框，写清楚"哪类请求给谁、之后
交给谁、什么情况拒绝"即可。保存时，调度器调用一次模型，把这段
话翻译成规则文档（API 仍提供 `POST /v1/plans/compile` 做不落库的预览）：

```
POST /v1/plans/compile {project, document_text}
        │
        ▼
编译器（Anthropic 兼容 /v1/messages）
        │  只允许使用项目里已有的 role_key；不凭空编造 shell 命令
        ▼
规则文档 ──► 同一套校验 ──► 保存 document + document_text（DRAFT）
        │
        └─ 运维在界面上确认"调度机将执行的规则"后，再激活
```

要点：

- **只在保存时编译**。同一个请求永远按已存下的规则匹配，结果可复现；
  改计划要重新保存、重新激活。
- 编译产物必须通过同一套校验；编译失败（模型不可用、没有角色、规则非法）时
  **什么都不保存**。
- 链式阶段如果模型只写了角色没写 `build`，调度器用该角色的 `operation_prompt`
  作为这一步的操作说明，而不是报错。
- 编译器配置：`PLAN_COMPILER_BASE_URL`（默认取 `ANTHROPIC_BASE_URL`）、
  `PLAN_COMPILER_API_KEY`（默认取 `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY`）、
  `PLAN_COMPILER_MODEL`（默认 `deepseek-chat`）。没有凭据时编译接口返回
  `PLAN_COMPILER_UNAVAILABLE`；已编译好的计划仍可正常使用。
- 手写 JSON（`document`）的接口和 `platformctl apply` 仍然保留，两者可以混用。

激活时每个规则的第一步只写 `role` 时，执行指令仍来自请求本身；角色的
`operation_prompt` 会在**运行时**追加到给 Agent 的指令末尾：

```
修复设置页崩溃

[Role operating instructions]
只修改 ui/ 目录下的文件。先同步工作树，改完后运行仓库里的 smoke 脚本……
```

所以"角色怎么操作"不需要重复写进计划，改角色说明即对之后的任务生效。

## 请求流程

```
POST /v1/requests {project, category, instruction}
        │  匹配当前 ACTIVE 计划
        ▼
创建工作流运行 ──► 第一阶段任务（business_role = rule.role）
        │             build.workdir 默认取角色 workdir_template
        │             能力 = code.build、shell + 角色 + 规则 + 请求
        ▼
认领：实例必须被分配到任务的 business_role
        │   权重用于排序候选；角色要求的能力再次校验
        │   文件夹互斥：workdir 已被别的活动租约占用时阻止（WORKDIR_IN_USE）
        ▼
ui-dev 执行 ──► code-review 复审 ──► test-bench 测试
```

### 文件夹互斥由调度器负责

所有构建机挂载同一个 `/work`，所以两个 Agent 同时改同一个目录会互相踩踏。
构建机不自己判断谁在用哪个目录，而是每次认领都问调度器；调度器知道所有活动
租约的 `requirements.build.workdir`，按"完全相同 / 父目录 / 子目录"三种前缀关系
判断重叠。有重叠时，这次认领被拒绝，任务上记录：

- `resource_block_reason = WORKDIR_IN_USE`
- 详情：占用的文件夹、持有者任务/实例/角色，以及给 Agent/运维看的话
  `Workdir /work/demo/work/ui-dev is in use by dev-a and cannot be allocated right now`

被阻塞的任务按正常的退避策略稍后重试；持有者结束（或租约过期）后自动放行。
这是**任务级**阻塞，不影响同一实例认领其它 workdir 的任务。

每个后续阶段的能力、`allowed_paths`、默认 workdir 都取自**它自己的角色**，
而不是开发角色的继承。所有阶段命令都会拿到 `PLATFORM_ORIGIN_TASK_ID` 和
`PLATFORM_BUSINESS_ROLE`，脚本据此定位原始任务。

## 确定性阶段钩子

Agent 阶段可以在 `instruction` 旁声明 `prepare_command` 和 `post_command`，
它们通过 `/bin/sh -lc` 在与 Agent 相同的目录执行：

- `prepare_command` 在附件/上游工件落盘**之前**运行（同步工作树时可以安全清空目录）；
- `post_command` 在 Agent 结束**之后**、上传声明的产物**之前**运行；
- 非零退出会让本次尝试失败（`STAGE_PREPARE_FAILED` / `STAGE_POST_FAILED`），
  进入正常重试策略。

Agent 的工作目录是 `requirements.build.workdir`（如果设置），而每次尝试的
workspace 仍作为 `HOME`/`TMPDIR`，所以 CLI 的状态不会写进项目树。
`BUILDER_PROJECT_ROOTS` 声明允许作为 workdir 的容器路径，其他路径一律拒绝
（`BUILD_WORKDIR_INVALID`）。

## 使用方式

```bash
scripts/roles.sh up                     # PostgreSQL + 调度器 + PCS + 管理台 + 4 台通用构建机
node scripts/platformctl.mjs apply projects/demo/project.json
node scripts/platformctl.mjs submit --project demo --category ui --instruction "修复设置页崩溃"
node scripts/platformctl.mjs watch <task_id>
node scripts/platformctl.mjs status --project demo
```

`up` 完成后管理台在 `http://127.0.0.1:18080`（`UI_PORT` 可改）。首次 `up` 会在
`deploy/.env.roles` 里生成管理员账号（`PCS_ADMIN_USER`，默认 `admin`）与随机密码。
管理台通过 PCS 的 `/api/scheduler` 代理访问调度器，浏览器只持有 PCS 会话 Cookie：

- **业务角色**页：创建角色只需要**项目、显示名称、说明、操作说明**四项；操作说明
  是一个自然语言文本框，告诉这个角色的 Agent 该怎么干活。`role_key`、默认
  workdir、能力、允许路径都由调度器补默认值。列表里可以直接看到每个角色的操作
  说明，并给构建机分配角色（带权重）、显示"哪些角色还没有在线机器"的覆盖告警；
- **计划**页：整份计划就是一个自然语言文本框。保存时调度器编译一次，弹窗里把
  "调度机将执行的规则"（匹配条件 → 首个角色 → 链路）展开给运维确认；确认无误后
  激活。脚本仍可预览（`POST /v1/plans/compile`）或试算一条请求
  （`POST /v1/requests {dry_run:true}`），试算不会创建任务。

命令行与 API 仍然可用，两者修改的是同一份状态。

清单文件就是用户的计划：`roles`、`plan.rules`、`assignments`（哪台已注册实例
扮演哪个角色）。`plan.text` 可选，是保存下来供人阅读的自然语言说明；清单里
`plan.rules` 仍然是权威规则（demo 用它钉住真实命令），管理台改说明并保存时才
重新编译。`platformctl apply` 是幂等的：角色就地更新，计划版本 +1 后重新
激活，分配整体替换。

也可以直接调 API：

```
POST   /v1/business-roles              PUT /v1/business-roles/:key
PUT    /v1/instances/:id/roles         {roles:[{role_key,weight}]}
GET    /v1/roles/coverage              哪些角色有在线机器
POST   /v1/plans                       PUT /v1/plans/:id
POST   /v1/plans/compile               把自然语言计划编译成规则（不保存）
POST   /v1/plans/:id/activate          编译工作流模板
POST   /v1/requests                    匹配并启动工作流
GET    /v1/tasks?business_role=ui-dev
```

## 项目目录约定

`deploy/compose.roles.yaml` 把同一个目录挂到所有构建机的 `/work`：

```
/work/<project>/
  repo/            主仓库；复审把变更包应用到这里
  snapshots/       可选的基线快照
  work/<role>/     各角色的工作树（Agent 的 cwd）
  changes/         变更包：<origin>.patch / .tar.gz / .json
  artifacts/       测试日志与板端输出
```

`scripts/platform/` 下的通用脚本实现交接：`sync-worktree.sh`、
`collect-changes.sh`、`apply-changes.sh`、`run-tests.sh`。项目特有的逻辑放进
`projects/<name>/test.sh` 与 `projects/<name>/review.sh`。

## 限制与有意的取舍

- 自然语言计划在保存时需要一次模型调用；调度器本身没有凭据时只能用 JSON
  规则（或先在有凭据的环境里编译好再导入）。编译质量取决于模型，所以界面上
  永远展示编译结果，激活前请确认。
- 文件夹互斥覆盖所有经过调度器认领的任务，比较的是 `workdir` 路径前缀；它不
  阻止 Agent 在指令里手动访问未被声明为 workdir 的目录。要限制这一点，把
  允许路径写进角色的 `allowed_paths`。
- 变更包交接假设构建机共享 `/work`（单机部署）。跨主机时用既有的工件通道
  （`upstream_artifacts`）增加一个上传补丁的阶段；这是计划变更，不是代码变更。
- 编译出的链全部是 EXECUTE 阶段，没有隐式 APPROVE 审批门。需要人工审批的计划
  应直接编写带 APPROVE 阶段的工作流模板并用 `POST /v1/workflows` 启动。
- 管理台覆盖角色、分配与计划；工作流模板的编辑与审批门不在管理台，属于调度机侧的数据模型操作。

# RackTop MVP 验收清单

更新时间：2026-08-03

本清单逐项对应 `PROJECT_CONTEXT.md` 13.1 的 20 项 MVP 要求。`通过` 表示已有当前代码、测试或产物证据；`待外部验证` 表示当前 macOS 工作区无法独立完成的平台步骤。

| # | 要求 | 状态 | 主要证据 |
|---:|---|---|---|
| 1 | macOS 和 Windows 安装包 | 待外部验证 | macOS `.app`/`.dmg` 已构建、挂载并严格验签；Windows CI 已明确生成并上传 MSI/NSIS，且配置了安装、启动、卸载 smoke test，但尚未在 Windows runner 实际运行 |
| 2 | 添加、编辑、删除服务器 | 通过 | `ServerForm`、`save_server`、`delete_server` 与 SQLite 外键级联 |
| 3 | 导入 OpenSSH Config | 通过 | Config 解析测试及可勾选导入界面 |
| 4 | 私钥和 SSH Agent | 通过 | OpenSSH `-i`、Agent/BatchMode 与密钥配置向导 |
| 5 | 并发连接多服务器 | 通过 | `Promise.allSettled` 并发刷新、按服务器单飞锁、OpenSSH ControlMaster |
| 6 | 在线状态 | 通过 | online/warning/offline/connecting 状态与连续三次失败离线判定 |
| 7 | CPU、内存、Load | 通过 | `/proc/stat` 双采样、`/proc/meminfo`、`/proc/loadavg`；双机实测 |
| 8 | GPU 利用率和显存 | 通过 | `nvidia-smi` 解析、总览/详情/趋势；双机实测 |
| 9 | GPU 温度和功耗 | 通过 | `nvidia-smi` 解析与卡片/详情展示 |
| 10 | GPU 进程 | 通过 | compute-apps + `ps` 合并，用户/PID/命令/显存/CPU/时长详情 |
| 11 | 自定义趋势窗口、采样和历史 | 通过 | 全局/单机/前后台/进程间隔、10–360 分钟窗口、每服务器保留期 |
| 12 | 当前 SSH 用户高亮 | 通过 | 当前用户 CPU、GPU 进程及显存独立强调色和“你”标签 |
| 13 | 固定侧栏与独立详情页 | 通过 | Overview/GPU/CPU/Processes/History/Logs/Connection 路由与定位 |
| 14 | 密码强警告与密钥教程 | 通过 | 风险确认、仅会话/系统凭据存储、macOS/Windows 密钥步骤 |
| 15 | `nvidia-smi` 检测和安装协助 | 通过 | 发行版识别、双确认安装、复制命令、重检、跳过 |
| 16 | `emilkowalski/skills` | 通过 | 7 个相关 Skill 已安装并用于 UI、动效和 Apple 体验审查 |
| 17 | 深色模式 | 通过 | system/light/dark 设置和系统颜色方案 |
| 18 | 系统托盘 | 通过 | 打开、连接全部、暂停/继续、空闲 GPU、退出 |
| 19 | 手动与自动刷新 | 通过 | 手动刷新、按间隔调度、后台降频、指数退避、单飞锁 |
| 20 | 清晰连接错误 | 通过 | 指纹、认证、拒绝、不可达、超时和通用错误分类 |

## 当前验证结果

- 前端单元测试：4 项通过。
- Rust 单元测试：9 项通过。
- 生产前端构建与 macOS release 构建通过。
- `tongzh@10.201.37.233`：Ubuntu 22.04.5，2 张 RTX 4090 D，采集通过。
- `tongzh@10.201.127.132`：Ubuntu 24.04.2，3 张 A100，GPU 进程归属与空闲卡识别通过。
- 本地浏览器：GPU 总览、4×2 响应式摘要、瀑布流、排序、筛选与显存颜色语义通过。
- 原生 macOS `.app`：启动、SQLite 写入、两台服务器并发 SSH、总览/详情/空闲筛选完整链路通过；数字输入可清空后直接输入 `20`；两台服务器均持续生成历史样本。
- macOS DMG：含 `RackTop.app` 和 Applications 入口；挂载后 `codesign --verify --deep --strict` 通过。

## 尚缺的完成证据

- 必须在真实 `windows-latest`/Windows x64 环境运行 `.github/workflows/build.yml`。工作流会验证 MSI 可解包、NSIS 可安装、已安装的 RackTop 能持续启动并可卸载。macOS 上的 Windows target 检查会在 `libsqlite3-sys` 处需要 MSVC SDK，不能替代 Windows runner。

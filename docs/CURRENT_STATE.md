# RackTop 当前状态

更新时间：2026-08-03

## 已完成

- Tauri 2 + React + TypeScript + Rust + SQLite 桌面应用骨架与发布配置。
- 服务器添加、编辑、删除、搜索与 SSH Config 导入。
- OpenSSH 采集、连接复用、ProxyJump、密钥/Agent/密码认证、Host Key 指纹确认。
- GPU、CPU、内存、Swap、Load、GPU 进程和当前用户标识采集。
- 多服务器并发刷新、失败三次离线判定、实时/历史趋势与保留期清理。
- 同一服务器的自动采样使用单飞锁，避免慢 SSH 请求重叠、旧结果覆盖新结果。
- 服务器详情页：概览、GPU、CPU、进程、历史、日志、连接。
- GPU 状态墙：一台服务器一个瀑布流卡片，只显示 CPU/GPU 预览，支持排序和点击进入详情。
- 空闲 GPU 筛选：数字输入可清空编辑；默认当前快照即时返回；持续时间筛选使用历史窗口；显存低于 1% 时忽略少量系统进程，其余有计算进程的设备不会判为空闲。
- GPU 状态墙底色按显存占用分级：低于 1% 视为未使用、显示为 0% 并保持中性背景，1–49% 蓝色、50–84% 橙色、85% 以上红色；少量系统进程不影响低于 1% 的空闲判定，核心利用率数值独立着色。
- 系统托盘、桌面通知、主题、辅助功能和 NVIDIA 驱动诊断提示。

## 验证结果

- `npm run build`：通过。
- `npm run test`：4 项通过，覆盖低于 1% 显存中性语义与阈值边界。
- `cargo test --manifest-path src-tauri/Cargo.toml`：9 项通过，包含每服务器历史保留范围验证。
- Playwright：双服务器页面、GPU 状态墙、排序、空闲筛选、数字输入删除后输入 `20`、负载颜色均通过视觉与交互检查。
- 原生 macOS 应用：实际启动后通过界面添加两台测试服务器，SQLite、并发 SSH、详情页、GPU 总览与空闲筛选端到端通过。
- 真实 SSH 并发测试：
  - `tongzh@10.201.37.233`：2 张 RTX 4090 D，采集正常。
  - `tongzh@10.201.127.132`：3 张 A100，正确识别其他用户的 VLLM 进程与空闲 GPU 2。
- macOS ARM64 `.app` 与 `.dmg`：构建通过；DMG 挂载后应用严格签名校验通过，并包含 Applications 安装入口。
- 最终 DMG SHA-256：`bc36a855410b08702f3dfa7ad3ce7a644cd6f86914b49c8bc678ae56127c7fc4`。

## 发布注意事项

- 当前 macOS 包为本机 ad-hoc 签名；公开分发前需配置 Apple Developer 签名与公证。
- Windows 安装包需要在 Windows runner 上构建；工作流已明确生成并上传 MSI 与 NSIS EXE，并自动执行 MSI 解包与 NSIS 安装、启动、卸载 smoke test，但仍需一次真实 Windows runner 运行记录。

# RackTop

RackTop 是一个基于 Tauri 2、React、TypeScript、Rust 和 SQLite 的桌面 GPU 服务器监控工具。它通过本机 OpenSSH 并发采集 Linux 服务器的 GPU、CPU、内存、负载与进程信息，不要求在服务器安装 Agent。

## 功能

- 多服务器总览、GPU 瀑布流状态墙和可自定义排序
- 空闲 GPU 筛选：利用率、可用显存、持续时间、型号和服务器标签
- GPU/CPU/进程详情与本地历史趋势
- SSH Agent、密钥、密码、`~/.ssh/config`、ProxyJump 和 Host Key 核验
- SQLite 历史数据、系统托盘、离线/高温/空闲/进程退出通知
- 浅色、深色、减少动效、减少透明度和高对比度适配

## 开发

需要 Node.js 20+、Rust stable、系统 OpenSSH。

```bash
npm install
npm run dev
npm run tauri dev
```

完整检查：

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

双服务器采集探针：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --features integration-probe --bin racktop-probe -- \
  tongzh@10.201.37.233 tongzh@10.201.127.132
```

## 打包

```bash
npm run tauri build
```

macOS 应用输出到 `src-tauri/target/release/bundle/macos/RackTop.app`，DMG 输出到 `src-tauri/target/release/bundle/dmg/`。GitHub Actions 工作流会在 macOS 和 Windows 上分别生成平台安装包。

如果当前 macOS 环境无法运行 Tauri 的 Finder 美化步骤，可使用可复现的本地打包命令；它会构建并 ad-hoc 签名 `.app`，再生成带 Applications 安装入口的 DMG：

```bash
npm run bundle:macos
```

## 安全

- Host Key 未确认时不会自动接受；指纹变化会阻止连接。
- 密码不写入命令行、日志或 SQLite，只保存在会话内存或系统钥匙串。
- RackTop 不会自动执行 `sudo` 或未经确认修改远程服务器；仅在 Ubuntu/Debian 缺少 NVIDIA 驱动且用户连续两次确认后，才会尝试用免交互 `sudo -n` 执行安装。

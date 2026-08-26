<p align="center">
  <img src="docs/assets/readme/racktop-icon.png" alt="RackTop macOS Logo" width="300" />
</p>

<h2 align="center">多台服务器，一个训练工作台</h2>

<p align="center">
  📊 查看算力、🔄 同步项目、🚀 启动任务，📈 并持续掌握运行状态。
</p>

<p align="center">
RackTop 是面向个人研究者和小型团队的 GPU 服务器桌面工作台，将分散在多台 Linux 服务器的算力状态、远程终端、项目资料和训练任务集中管理。
启动前快速找到合适的 GPU，运行中持续掌握资源与进程状态，切换服务器时让项目、数据集和模型保持就绪。
它直接使用本机 OpenSSH，无需部署远程 Agent。启动前找到合适的 GPU，运行中掌握资源与进程状态，并在不同服务器之间保持项目资料就绪。
</p>

<p align="center">
  <a href="https://github.com/Tongzh-SEU/RackTop/releases/latest"><img src="https://img.shields.io/github/v/release/Tongzh-SEU/RackTop?style=flat-square&logo=github&label=release" alt="Release"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-1687b8?style=flat-square" alt="Platform">
  <a href="https://github.com/Tongzh-SEU/RackTop/releases"><img src="https://img.shields.io/github/downloads/Tongzh-SEU/RackTop/total?style=flat-square&logo=github&label=downloads" alt="Downloads"></a>
  <a href="https://github.com/Tongzh-SEU/RackTop/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Tongzh-SEU/RackTop?style=flat-square&label=license" alt="License"></a>
</p>


 

<p align="center">
  <img src="docs/assets/readme/fleet-overview.png" alt="全局算力总览" width="33%">
  <img src="docs/assets/readme/history-heatmap.png" alt="资源历史热力图" width="33%">
  <img src="docs/assets/readme/idle-compute.png" alt="空闲算力筛选" width="33%">
</p>

## 下载

当前稳定版：**v1.25.1**

| 平台 | 安装包 | 下载 |
| --- | --- | --- |
| macOS Apple Silicon | `RackTop-1.25.1-macos-arm64.dmg` | [下载 macOS 版本](https://github.com/Tongzh-SEU/RackTop/releases/download/v1.25.1/RackTop-1.25.1-macos-arm64.dmg) |
| Windows x64 | `RackTop-1.25.1-windows-x64-setup.exe` | [下载 Windows 版本](https://github.com/Tongzh-SEU/RackTop/releases/download/v1.25.1/RackTop-1.25.1-windows-x64-setup.exe) |

更多版本见 [GitHub Releases](https://github.com/Tongzh-SEU/RackTop/releases)。macOS 首次打开若提示来源限制，请在“系统设置 → 隐私与安全性”中确认打开。

## 作者的话

实验室服务器越来越多以后，项目之间的同步、任务运行和服务器状态查看会变得越来越麻烦。把这些事情交给 AI 做，往往又会浪费不少 token 和时间，所以我决定开发 RackTop，把这些重复的操作收进一个真正可操作的工具里。

当然，开发这个 App 的过程本身也花了很多 token，笑死。至少现在，下一次启动任务时不用再从头解释一遍服务器、项目和命令了。

## 主要功能

- **多服务器算力总览**：集中查看 GPU、CPU、系统内存、温度、利用率和进程状态，并按服务器与 GPU 快速定位资源。
- **空闲算力发现**：按显存、利用率、占用状态和持续空闲时间筛选可用 GPU，直接打开远程终端或进入启动任务流程。
- **远程终端**：通过 SSH 打开服务器终端，适合临时检查环境、查看文件和处理启动前问题。
- **项目资料管理**：按项目管理工作目录，并关联数据集和模型；支持跨服务器检查状态、同步副本和补齐缺失资料。
- **启动配置与任务管理**：保存项目级启动配置，在不同服务器和 GPU 上切换工作目录、GPU 卡号、Shell 命令、超参数和日志路径，再统一启动和监测任务。
- **运行状态与历史**：查看 RackTop 任务和外部进程、日志、资源监测、历史热力图，以及离线、高温、空闲和进程退出通知。
- **安全连接**：支持 SSH Agent、密钥、密码、`~/.ssh/config`、ProxyJump 和 Host Key 指纹核验，不自动接受未知主机。


## 安全与数据

- Host Key 未确认时不会自动接受；指纹变化会阻止连接。
- 密码不会写入命令行、日志或 SQLite，只保存在会话内存或系统钥匙串。
- RackTop 不会自动执行 `sudo` 或未经确认修改远程服务器。
- 服务器、项目、数据集、模型、启动配置和历史数据保存在本机应用数据目录；卸载应用通常不会自动删除这些数据，如需彻底清理请先在应用设置中导出或删除，再按操作系统清理应用数据目录。

## 开发者说明

RackTop 使用 Tauri 2、React、TypeScript、Rust 和 SQLite 构建。开发环境需要 Node.js 20+、Rust stable 和系统 OpenSSH。

```bash
npm install
npm run dev
npm run tauri dev
```

运行前端构建和 Rust 测试：

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

本地打包：

```bash
npm run tauri build
```

macOS 的应用和 DMG 会输出到 `src-tauri/target/release/bundle/`。GitHub Actions 会分别构建 macOS 和 Windows 安装包。

## 产品说明书

### 1. 添加服务器

第一次使用时，从“添加服务器”开始。填写 SSH 地址、端口和登录用户，按需要选择 SSH Agent、密钥或密码，并完成 Host Key 核验。RackTop 会通过 SSH 读取服务器资源，不需要在服务器安装额外服务。

![添加 SSH 服务器](docs/assets/readme/add-server.png)

### 2. 查看服务器与 GPU 状态

总览页按服务器展示 GPU 数量、GPU 显存、系统内存和在线状态。进入服务器后，可以查看每张 GPU 的利用率、显存、温度、当前进程和 CPU 状态；点击卡片可以继续查看细节。

![服务器概览](docs/assets/readme/overview.png)

![全局算力总览](docs/assets/readme/fleet-overview.png)

### 3. 使用远程终端

需要临时检查环境时，打开对应服务器的远程终端。终端复用已配置的 SSH 连接，适合执行检查命令、确认目录、验证 Python 环境或排查任务启动问题。

![远程终端](docs/assets/readme/terminal.png)

### 4. 发现空闲算力

在“空闲算力”中按 GPU 使用情况、可用显存和是否有进程占用筛选资源。点击启动按钮会进入启动任务，点击终端按钮只打开远程终端，不会改变任务配置。

![空闲算力筛选](docs/assets/readme/idle-compute.png)

### 5. 查看资源历史

资源历史以热力图展示近期 GPU 使用情况，时间坐标固定在左侧并随窗口自适应。它适合快速判断一台服务器什么时候繁忙、哪些 GPU 长时间空闲，以及任务运行是否出现异常波动。

![资源历史热力图](docs/assets/readme/history-heatmap.png)

### 6. 管理项目、数据集和模型

项目是长期管理的核心。为项目关联数据集和模型后，RackTop 会检查它们在目标服务器上的路径和副本状态；需要在另一台服务器运行时，可以从同步弹窗查看缺失项并执行同步或补齐。一个数据集或模型可以被多个项目关联。

![项目、数据集和模型同步](docs/assets/readme/sync-dialog.png)

### 7. 创建启动任务

启动配置按项目保存。同一套超参数可以针对不同服务器切换工作目录、GPU 卡号和运行命令；粘贴已有命令时，RackTop 会识别其中的 `cd`、`CUDA_VISIBLE_DEVICES` 和项目日志路径，并在启动前生成预览。未提供项目日志路径时，RackTop 使用自己的受管日志路径，便于在任务页统一查看日志。

![启动任务](docs/assets/readme/launch-task.png)

启动后可以在“我的进程”中查看任务状态、日志和资源占用，并安全结束任务或外部进程。

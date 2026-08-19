# RackTop: 一屏掌握所有服务器的算力状态应用设计方案

## 1. 项目概述

### 1.1 项目背景

在拥有多台 GPU 服务器的开发、科研或训练环境中，用户通常需要分别通过 SSH 登录每台服务器，再运行 `nvitop`、`nvidia-smi`、`top` 等命令查看资源占用情况。

当服务器数量增加后，这种方式存在以下问题：

- 需要频繁切换终端和服务器；
- 无法在一个界面中比较所有服务器；
- 很难快速找到空闲 GPU；
- 难以查看 GPU 和 CPU 利用率趋势；
- 历史数据无法长期保存；
- 不方便为 GPU 空闲、温度过高、训练进程退出等情况设置通知。

因此，可以开发一个支持 macOS 和 Windows 的桌面应用，让用户一键查看所有服务器的 GPU、CPU、内存和进程状态。

---

## 2. 产品定位

### 2.1 产品名称

名称：

# RackTop

英文标语：

> Live GPU & CPU monitoring for every server.

中文标语：

> 一屏掌握所有服务器的算力状态。

---

## 3. 核心目标

RackTop 的目标是让用户在 macOS 或 Windows 上：

1. 导入或添加多台 Linux GPU 服务器；
2. 通过 SSH 一键连接所有服务器；
3. 查看每台服务器的 GPU、CPU、内存和负载；
4. 查看每块 GPU 的利用率、显存、温度和功耗；
5. 查看 GPU 和 CPU 的实时趋势；
6. 查看正在使用 GPU 的进程和用户；
7. 快速识别空闲服务器和空闲 GPU；
8. 按用户自定义的保存时间和采样间隔记录历史数据；
9. 在资源空闲、过热或任务退出时发送通知；
10. 打包成可直接安装的 macOS 和 Windows 应用。

---

## 4. 推荐技术方案

## 4.1 总体技术栈

| 模块 | 推荐技术 |
|---|---|
| 桌面框架 | Tauri 2 |
| 前端框架 | React + TypeScript |
| UI 展示 | HTML + CSS |
| UI / 动画设计技能 | `emilkowalski/skills` |
| 图表组件 | Apache ECharts |
| 本地后端 | Rust |
| 服务器连接 | SSH |
| 本地数据库 | SQLite |
| 实时数据传输 | Tauri Events / Channels |
| macOS 凭据存储 | Keychain |
| Windows 凭据存储 | Credential Manager |
| 配置导入 | OpenSSH Config |
| macOS 安装包 | `.dmg` / `.app` |
| Windows 安装包 | `.msi` / `.exe` |

---

## 4.2 为什么使用 HTML 界面

HTML、CSS 和 TypeScript 非常适合实现：

- 仪表盘；
- 服务器卡片；
- GPU 使用率图表；
- CPU 趋势曲线；
- 进程表格；
- 筛选、搜索和排序；
- 响应式布局；
- 深色模式。

但是，纯浏览器页面不适合直接完成以下操作：

- 建立 SSH TCP 连接；
- 读取本地 `~/.ssh/config`；
- 使用本地 SSH 私钥；
- 调用系统 SSH；
- 安全保存登录凭据；
- 在后台持续采集服务器指标；
- 发送系统通知；
- 访问系统托盘。

因此，推荐使用 HTML 技术开发界面，再通过 Tauri 将其封装为桌面应用。

---

## 4.3 为什么选择 Tauri

Tauri 允许开发者使用 Web 技术编写界面，同时使用 Rust 实现本地功能。

推荐 Tauri 的原因：

- 支持 macOS、Windows 和 Linux；
- 可以打包为原生安装程序；
- 安装包通常比 Electron 更小；
- 运行内存占用通常更低；
- Rust 适合处理并发 SSH 连接；
- 可以访问本地文件、数据库和系统通知；
- 可以实现菜单栏、系统托盘和自动启动；
- 可以限制前端能够调用的本地能力，安全边界较清晰。

### Tauri 与 Electron 对比

| 对比项 | Tauri | Electron |
|---|---|---|
| UI 技术 | HTML / CSS / JS | HTML / CSS / JS |
| 本地后端 | Rust | Node.js |
| 浏览器内核 | 系统 WebView | 自带 Chromium |
| 安装包 | 通常较小 | 通常较大 |
| 内存占用 | 通常较低 | 通常较高 |
| 开发速度 | 需要学习部分 Rust | JavaScript 团队更快 |
| 适用场景 | 轻量长期驻留工具 | 快速开发复杂桌面产品 |

如果团队只熟悉 JavaScript，希望最快完成第一版，可以选择 Electron。  
如果希望长期维护一个轻量、稳定的桌面监控工具，推荐 Tauri。

---

## 4.4 UI、动画与交互设计技能

RackTop 的网页界面以及 Tauri WebView 中的桌面界面，在进行页面设计、组件实现、动画设计和交互体验优化时，统一优先使用 [`emilkowalski/skills`](https://github.com/emilkowalski/skills) 作为设计工程技能集。

该技能集用于辅助以下工作：

- 页面布局、视觉层级和界面细节设计；
- 组件状态、反馈和交互行为设计；
- 动画时机、缓动、持续时间和空间关系设计；
- 识别真正需要动画的交互位置，避免无意义动效；
- 审查并改进已有动画；
- 选择适合项目的 UI 组件库；
- 结合 Apple 设计原则优化 macOS 体验；
- 保证 Windows 与 macOS 上的交互语义一致。

### 技能检查与主动安装

开始任何 UI、组件、动画或交互体验任务前，开发 Agent 应先检查当前项目是否已经安装 `emilkowalski/skills`。

如果未安装，应主动在项目根目录执行：

```bash
npx skills@latest add emilkowalski/skills
```

安装失败时，应明确报告原因和缺失条件，不得假装技能已经生效。只有在无法完成安装时，才可以暂时使用项目现有设计规范继续开发，并在交付说明中记录该降级情况。

该技能属于开发阶段的 Agent Skills，不应被打包为 RackTop 用户端运行依赖。最终用户安装 RackTop 时不需要安装 Node.js、`skills` CLI 或该技能仓库。

### 按任务调用对应技能

在技能可用时，应根据任务调用合适的子技能：

- `emil-design-eng`：页面、组件、交互和整体设计工程实现；
- `pick-ui-library`：选择维护良好且适合任务的 UI 组件库；
- `find-animation-opportunities`：识别适合增加动效的位置，以及不应添加动效的位置；
- `animation-vocabulary`：准确描述需要的动画行为；
- `review-animations`：严格审查已经实现的动画；
- `improve-animations`：输出按优先级排列的动画改进方案；
- `apple-design`：参考 Apple 的界面与流畅动效原则优化 macOS 体验。

不能因为安装了技能就机械地给所有操作增加动画。监控界面的首要目标仍然是信息清晰、状态稳定、数据易读和操作可预测。

### UI 工作流程

每个主要页面或交互功能建议遵循以下流程：

1. 使用 `emil-design-eng` 明确信息层级、组件结构和交互状态；
2. 必要时使用 `pick-ui-library` 选择成熟组件，而不是重复手写基础组件；
3. 使用 `find-animation-opportunities` 判断哪些状态变化真正需要动效；
4. 实现页面、组件和动画；
5. 使用 `review-animations` 审查进入、退出、切换、展开和反馈动画；
6. 使用 `improve-animations` 生成并执行高优先级改进项；
7. 在 macOS 版本上使用 `apple-design` 做一次平台体验检查；
8. 检查减少动态效果、键盘操作、焦点状态和无障碍支持。

### RackTop 动效原则

RackTop 是高信息密度的实时监控工具，动效应遵循以下原则：

- 动画服务于状态变化和空间关系，不作为装饰；
- 实时图表更新应平滑，但不得造成数据延迟或视觉误导；
- 服务器切换和右侧详情菜单切换应保持上下文连续；
- 告警、离线和认证风险必须清晰，不依赖夸张动画吸引注意；
- 当前用户任务的强调色变化应稳定，避免持续闪烁；
- 数据高频刷新时，不应让卡片整体反复位移或缩放；
- 支持系统“减少动态效果”设置，并提供应用内关闭非必要动画的选项；
- 动画不能阻塞 SSH 连接、指标刷新、错误反馈或关键操作。

---

## 5. 系统架构

```text
┌─────────────────────────────────────────────┐
│          RackTop Desktop Application        │
│              macOS / Windows                │
│                                             │
│  React + TypeScript                         │
│  ├── 左侧固定服务器栏                        │
│  ├── 右侧总览与详情页面                      │
│  ├── GPU / CPU 状态卡片                      │
│  ├── 利用率趋势图与进程表                    │
│  ├── 告警和通知                              │
│  └── 设置页面                                │
│                     ↕                       │
│  Tauri / Rust Backend                       │
│  ├── SSH 连接池                              │
│  ├── 指标采集器                              │
│  ├── 数据解析器                              │
│  ├── SQLite 历史存储                         │
│  ├── 凭据管理                                │
│  └── 系统通知                                │
└─────────────────────┬───────────────────────┘
                      │ SSH
          ┌───────────┼───────────┐
          │           │           │
          ▼           ▼           ▼
      Server A     Server B     Server C
      nvidia-smi   nvidia-smi   nvidia-smi
      /proc        /proc        /proc
```

---

## 6. 数据采集方案

## 6.1 第一阶段：无 Agent 的 SSH 方案

第一版不需要在服务器安装专用 Agent。

桌面应用通过 SSH 连接服务器，然后执行系统已有的命令采集数据。

优点：

- 部署简单；
- 不需要管理员权限；
- 不需要长期运行额外服务；
- 适合个人、实验室和小型团队；
- 用户可以直接复用已有 SSH 配置。

缺点：

- 服务器较多时 SSH 连接管理更复杂；
- 频繁执行命令会产生一定开销；
- 应用关闭后无法继续采集；
- 不适合多人共享同一套历史数据。

---

## 6.2 GPU 指标采集

可以通过以下命令读取 GPU 状态：

```bash
nvidia-smi \
  --query-gpu=index,name,uuid,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw \
  --format=csv,noheader,nounits
```

可采集指标：

- GPU 索引；
- GPU 型号；
- GPU UUID；
- GPU 核心利用率；
- GPU 显存控制器利用率；
- 已用显存；
- 总显存；
- GPU 温度；
- GPU 功耗。

### GPU 进程信息

```bash
nvidia-smi \
  --query-compute-apps=gpu_uuid,pid,process_name,used_memory \
  --format=csv,noheader,nounits
```

可以进一步结合以下命令获取进程用户：

```bash
ps -o user=,pid=,command= -p <PID>
```

### `nvidia-smi` 缺失处理

建立 SSH 连接后，应用应先检测目标服务器是否存在 `nvidia-smi`：

```bash
command -v nvidia-smi
```

如果未检测到，应区分以下情况并给出明确提示：

- 服务器没有 NVIDIA GPU；
- 已安装 NVIDIA GPU，但驱动或 `nvidia-smi` 未安装；
- `nvidia-smi` 已安装，但不在当前用户的 `PATH` 中；
- 当前用户没有执行权限。

确认服务器存在 NVIDIA GPU，但缺少对应工具时，提示窗口应提供：

1. **帮助安装**：识别 `/etc/os-release` 中的 Linux 发行版，在用户明确确认后执行对应安装步骤；需要 `sudo` 或管理员权限时必须再次提示；
2. **显示安装命令**：生成适用于目标发行版的命令，允许用户复制后自行执行；
3. **重新检测**：用户完成安装或修复后再次检查；
4. **暂不处理**：继续监控 CPU、内存等非 GPU 指标。

例如，在受支持的 Ubuntu 环境中，可以向用户展示类似命令：

```bash
sudo apt update
sudo apt install -y ubuntu-drivers-common
sudo ubuntu-drivers install
```

驱动安装通常需要重启服务器。自动安装必须获得用户明确确认，不应在后台静默修改服务器环境。对于无法可靠识别或不受支持的发行版，应用只提供检测结果、建议命令和官方安装文档入口，不自动执行安装。

---

## 6.3 CPU 和内存指标采集

### CPU

读取：

```bash
cat /proc/stat
```

CPU 利用率需要比较连续两次采样。

计算方式：

```text
CPU Usage = 1 - idle_delta / total_delta
```

其中：

```text
idle_delta  = 当前 idle - 上一次 idle
total_delta = 当前 total - 上一次 total
```

### 系统负载

```bash
cat /proc/loadavg
```

可以获得：

- 1 分钟负载；
- 5 分钟负载；
- 15 分钟负载；
- 当前运行任务数量。

### 内存

```bash
cat /proc/meminfo
```

可以获得：

- 总内存；
- 可用内存；
- 缓存；
- Swap；
- 内存占用比例。

### 磁盘

```bash
df -P -B1
```

### 网络

可读取：

```bash
cat /proc/net/dev
```

通过两次采样差值计算上传和下载速率。

---

## 6.4 自定义采样频率

采样频率由用户自定义，可设置全局默认值，也可为不同指标或单台服务器单独覆盖。以下数值仅作为首次使用时的默认推荐值：

| 指标 | 默认推荐频率 |
|---|---:|
| GPU 利用率 | 2 秒 |
| GPU 显存 | 2 秒 |
| CPU 利用率 | 2 秒 |
| 系统内存 | 5 秒 |
| GPU 进程 | 5 秒 |
| 磁盘空间 | 30 秒 |
| 系统信息 | 5 分钟 |

设置页面应允许用户调整：

- 实时指标采样间隔；
- GPU 进程刷新间隔；
- 单台服务器的独立采样间隔；
- 仅在应用位于前台时使用的高频采样间隔；
- 应用在后台运行时使用的低频采样间隔。

应用应对过短间隔给出性能和服务器负载提示，并设置合理的最小值。不同指标不应默认全部以相同频率执行，以降低远程服务器和 SSH 连接开销。

---

## 7. 统一数据结构

Rust 后端可以将不同命令的输出转换为统一数据模型。

示例：

```json
{
  "serverId": "server-01",
  "hostname": "gpu-server-01",
  "timestamp": 1785700000,
  "status": "online",
  "system": {
    "cpuUtilization": 68.2,
    "load1": 12.4,
    "load5": 11.8,
    "load15": 10.2,
    "memoryUsedBytes": 34359738368,
    "memoryTotalBytes": 68719476736
  },
  "gpus": [
    {
      "index": 0,
      "uuid": "GPU-xxxxxxxx",
      "name": "NVIDIA H100",
      "utilization": 94,
      "memoryUtilization": 88,
      "memoryUsedMb": 61240,
      "memoryTotalMb": 81559,
      "temperatureCelsius": 71,
      "powerWatts": 618
    }
  ]
}
```

---

## 8. 实时趋势与历史数据

## 8.1 实时趋势

应用运行期间，可以在内存中保存最近一段时间的数据。实时窗口长度由用户自定义，例如 10 分钟、30 分钟、1 小时或自定义时长。

建议使用环形缓冲区：

```text
每台服务器
  ├── CPU 最近 N 分钟
  ├── 内存最近 N 分钟
  └── 每块 GPU 最近 N 分钟
```

所需数据点数量根据用户设置动态计算：

```text
数据点数量 = 实时窗口时长 ÷ 采样间隔
```

例如实时窗口为 30 分钟、采样间隔为 2 秒时，需要：

```text
30 × 60 ÷ 2 = 900 个数据点
```

每个指标只保存根据配置计算出的固定数量数据点，超出后覆盖最旧数据。用户修改窗口长度或采样间隔后，缓冲区容量应自动调整。

---

## 8.2 本地历史存储

使用 SQLite 保存历史数据。

示例表结构：

```sql
CREATE TABLE gpu_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    server_id TEXT NOT NULL,
    gpu_uuid TEXT NOT NULL,
    utilization REAL,
    memory_utilization REAL,
    memory_used_mb REAL,
    memory_total_mb REAL,
    temperature_celsius REAL,
    power_watts REAL
);

CREATE INDEX idx_gpu_samples_lookup
ON gpu_samples(server_id, gpu_uuid, timestamp);
```

CPU 表：

```sql
CREATE TABLE system_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    server_id TEXT NOT NULL,
    cpu_utilization REAL,
    load_1 REAL,
    load_5 REAL,
    load_15 REAL,
    memory_used_bytes INTEGER,
    memory_total_bytes INTEGER
);

CREATE INDEX idx_system_samples_lookup
ON system_samples(server_id, timestamp);
```

---

## 8.3 自定义历史保存与数据降采样

不建议永久保存高频原始采样点。历史保存时间、原始数据保留时间和降采样间隔均由用户自定义，应用可提供以下默认预设：

| 时间范围 | 默认数据粒度 |
|---|---|
| 最近 1 小时 | 每 2 秒 |
| 最近 24 小时 | 每 30 秒 |
| 最近 7 天 | 每 5 分钟 |
| 最近 30 天 | 每 30 分钟 |
| 更早数据 | 删除或按小时聚合 |

用户可以配置：

- 是否保存历史数据；
- 历史数据总保存时间；
- 高频原始数据保存时间；
- 各时间范围的聚合间隔；
- 超期数据自动删除或继续聚合；
- 每台服务器是否使用独立的保存策略。

聚合数据可以分别保存：

- 最小值；
- 最大值；
- 平均值；
- P95；
- 样本数量。

设置界面应预估当前配置可能占用的磁盘空间，并允许用户立即清理历史数据。

---

## 9. UI 页面设计

## 9.1 总览页面

总览页面展示：

- 在线服务器数量；
- 离线服务器数量；
- GPU 总数量；
- 空闲 GPU 数量；
- 当前平均 GPU 利用率；
- 当前平均 CPU 利用率；
- GPU 温度异常数量；
- 最近一次刷新时间。

服务器可以以卡片方式展示：

```text
┌─────────────────────────────────────┐
│ gpu-server-01              Online   │
│ CPU    ███████░░░ 72%               │
│ RAM    ██████░░░░ 61%               │
│                                     │
│ GPU 0  █████████░ 94%  61/80 GB     │
│ GPU 1  ██░░░░░░░░ 18%  12/80 GB     │
│                                     │
│ Load: 12.4  Temp: 71°C              │
└─────────────────────────────────────┘
```

GPU 和 CPU 的占用展示应区分“当前 SSH 登录用户产生的占用”和“其他用户产生的占用”。当前用户自己的进程、显存和 CPU 占用使用单独的强调色标记，其他用户使用默认颜色；同时保留文字、图标或标签，避免仅依赖颜色传递信息。

后端通过进程所属用户与当前 SSH 登录用户名进行匹配，并向前端提供 `isCurrentUser` 等标记。用户可以在设置中修改个人占用强调色。

---

## 9.2 服务器详情页

详细信息统一在独立页面中展示。用户点击服务器卡片、CPU 指标、某块 GPU 或具体进程后，应用跳转到对应详情页，以获得更大的信息空间、更清晰的页面层级和更稳定的操作体验。

详情页面整体采用以下布局：

```text
┌──────────────────────────────────────────────────────────┐
│ 顶部全局导航、搜索、采样间隔和历史范围                    │
├───────────────┬──────────────────────────────────────────┤
│ 左侧服务器栏   │ 右侧详情页面                              │
│               │ ┌──────────────────────────────────────┐ │
│ 搜索与筛选     │ │ 服务器名称、状态和关键指标             │ │
│ 服务器分组     │ ├──────────────────────────────────────┤ │
│ 在线状态       │ │ Overview | GPU | CPU | Processes     │ │
│ 服务器列表     │ │ History | Logs | Connection          │ │
│               │ ├──────────────────────────────────────┤ │
│ 当前选中项     │ │ 图表、指标卡片、进程表和详细信息       │ │
│               │ └──────────────────────────────────────┘ │
└───────────────┴──────────────────────────────────────────┘
```

### 左侧固定服务器栏

左侧栏在总览页和详情页之间保持一致，并持续显示：

- 服务器搜索和筛选；
- 在线、离线和异常状态；
- 服务器分组及标签；
- GPU 数量和简要型号；
- 当前选中的服务器；
- 用户自己的任务标记；
- `nvidia-smi` 缺失或连接异常提示。

切换左侧服务器时，右侧内容直接更新为对应服务器的详情页，不需要返回总览后重新选择。应用应保留用户之前的筛选条件、滚动位置和选中的详情菜单。

### 右侧详情菜单

右侧页面顶部提供服务器级二级菜单，建议包括：

- **Overview**：CPU、内存、负载、GPU 总览和关键告警；
- **GPU**：每块 GPU 的实时状态、趋势、显存、温度、功耗和进程；
- **CPU**：总体和每核心利用率、负载、内存及网络；
- **Processes**：GPU / CPU 进程、用户、PID、命令和运行时间；
- **History**：按自定义时间范围查看历史趋势；
- **Logs**：采集错误、连接错误和告警记录；
- **Connection**：SSH 配置、认证方式、Host Key 和连接状态。

点击服务器卡片时默认进入 **Overview**。点击某块 GPU 时直接进入 **GPU** 菜单并选中对应设备；点击 CPU 指标时进入 **CPU**；点击进程时进入 **Processes** 并定位到对应进程。

### 详情内容

详情页的信息密度可以参考 `nvitop`，但应适配图形化桌面界面。页面可以包含：

- CPU 利用率趋势和每核心使用率；
- 系统负载趋势；
- 内存利用率趋势；
- 每块 GPU 的利用率趋势；
- GPU 显存、温度和功耗趋势；
- GPU 进程列表；
- 进程 PID、用户、命令、显存占用和运行时间；
- 当前 SSH 登录用户自己的 CPU / GPU 进程高亮；
- 服务器连接信息；
- 最近错误日志。

当前用户自己的进程、显存和 CPU 占用继续使用独立强调色和文字标签。页面可以使用简短 Tooltip 解释单个指标，但完整信息必须在详情页面中展示，不使用覆盖主界面的详情弹层。

用户点击具体进程后，可以进入进程详情区域或右侧页面中的子页面。第一版以只读监控为主，不默认提供结束进程等高风险操作。

---

## 9.3 GPU 空闲视图

为科研和训练场景增加“寻找空闲 GPU”页面。

支持筛选：

- GPU 利用率低于指定值；
- 空闲持续时间超过指定时长；
- 可用显存大于指定值；
- 指定 GPU 型号；
- 指定服务器标签；
- 指定机房或项目组。

例如：

```text
空闲条件：
GPU 利用率 < 10%
可用显存 > 40 GB
持续时间 > 10 分钟
```

---

## 9.4 系统托盘

RackTop 可以常驻系统托盘。

托盘信息可以显示：

```text

RackTop
3 / 4 Servers Online
5 GPUs Idle
GPU Avg: 72%
```

托盘菜单：

- 打开仪表盘；
- 连接全部；
- 暂停采集；
- 查看空闲 GPU；
- 退出。

---

## 10. SSH 连接设计

## 10.1 支持的认证方式

建议支持：

- SSH 私钥；
- 带密码的 SSH 私钥；
- SSH Agent；
- 用户名和密码；
- ProxyJump / 跳板机；
- 自定义端口；
- 自定义 SSH Config。

---

## 10.2 明文密码登录警告

当用户选择“用户名和密码”方式时，应弹出安全警告，明确说明：

- 强烈不建议长期使用明文密码登录；
- 推荐使用 SSH 密钥或 SSH Agent；
- 密码即使保存在系统 Keychain 或 Credential Manager 中，也仍可能面临误输入、弱密码、重复使用和远程服务器策略限制等风险；
- 应用不会将密码写入普通配置文件、日志或 SQLite。

警告窗口提供两个主要操作：

1. **继续使用密码**：用户再次确认后继续，并将密码仅保存到系统安全凭据存储；也可以选择仅本次使用、不保存；
2. **使用 SSH 密钥（推荐）**：打开密钥配置向导。

密钥配置向导应提供分步教程，包括：

- 在 macOS 或 Windows 生成 Ed25519 密钥；
- 将公钥添加到服务器的 `~/.ssh/authorized_keys`；
- 测试免密登录；
- 导入已有私钥；
- 配置带密码的私钥和 SSH Agent；
- 处理 Windows OpenSSH 与 macOS OpenSSH 的常见路径。

可展示的基础命令示例：

```bash
ssh-keygen -t ed25519 -C "RackTop"
ssh-copy-id user@server
ssh user@server
```

Windows 环境没有 `ssh-copy-id` 时，向导应提供复制公钥并写入 `authorized_keys` 的替代步骤。

---

## 10.3 导入 SSH Config

macOS 默认路径：

```text
~/.ssh/config
```

Windows 常见路径：

```text
%USERPROFILE%\.ssh\config
```

配置示例：

```sshconfig
Host gpu-a
    HostName 192.168.1.101
    User researcher
    IdentityFile ~/.ssh/id_ed25519

Host gpu-b
    HostName 192.168.1.102
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519
    ProxyJump bastion
```

应用可以扫描其中的 Host，并让用户选择需要监控的服务器。

---

## 10.4 SSH 连接池

不建议每两秒重新建立一个 SSH 连接。

推荐：

1. 每台服务器保持一个长连接；
2. 在连接上周期性执行采集命令；
3. 设置命令超时；
4. 失败后使用指数退避重连；
5. 限制同时连接的服务器数量；
6. 支持手动重新连接。

示例重试时间：

```text
1 秒 → 2 秒 → 5 秒 → 10 秒 → 30 秒
```

---

## 10.5 Host Key 安全

第一次连接服务器时，应显示服务器指纹：

```text
ED25519 SHA256:xxxxxxxxxxxxxxxx
```

用户确认后保存。

后续连接时，如果 Host Key 发生变化，应阻止连接并给出明显提示，避免中间人攻击。

不能默认无条件接受所有 Host Key。

---

## 11. 凭据安全

### macOS

敏感信息保存到：

```text
macOS Keychain
```

### Windows

敏感信息保存到：

```text
Windows Credential Manager
```

SQLite 中只保存：

- 服务器名称；
- 主机地址；
- 用户名；
- SSH Config 别名；
- 私钥路径；
- 非敏感偏好设置。

不应在 SQLite 或普通 JSON 中明文保存：

- SSH 密码；
- 私钥密码；
- API Token；
- 私钥内容。

---

## 12. 告警和通知

可以提供以下规则：

### GPU 空闲通知

```text
GPU 利用率低于 10%，并持续 10 分钟
```

### GPU 显存释放通知

```text
可用显存超过 40 GB
```

### 温度告警

```text
GPU 温度超过 85°C
```

### 训练进程退出

```text
指定 PID 或进程名称消失
```

### 服务器离线

```text
连续 3 次采集失败
```

### GPU 持续满载

```text
GPU 利用率超过 95%，并持续 30 分钟
```

通知方式：

- macOS 系统通知；
- Windows 系统通知；
- 声音提醒；
- 后续可扩展邮件、Slack、企业微信或 Webhook。

---

## 13. 第一版 MVP 功能

## 13.1 必须实现

1. macOS 和 Windows 安装包；
2. 添加、编辑和删除服务器；
3. 导入 OpenSSH Config；
4. 私钥和 SSH Agent 登录；
5. 并发连接多台服务器；
6. 显示服务器在线状态；
7. 显示 CPU、内存和 Load；
8. 显示 GPU 利用率和显存；
9. 显示 GPU 温度和功耗；
10. 显示 GPU 进程；
11. 支持自定义实时趋势窗口、采样间隔和历史保存时间；
12. 对当前 SSH 登录用户自己的 GPU / CPU 占用使用独立颜色和标签高亮；
13. 点击服务器、GPU、CPU 或进程后进入独立详情页，采用左侧固定服务器栏和右侧二级菜单布局；
14. 使用密码认证时显示强烈警告，并提供继续使用密码或进入 SSH 密钥教程的选择；
15. 检测目标服务器是否存在 `nvidia-smi`，并提供协助安装、复制安装命令、重新检测或跳过 GPU 监控；
16. 使用 `emilkowalski/skills` 指导主要页面、组件、动画和交互体验设计，并在缺失时主动安装；
17. 支持深色模式；
18. 支持系统托盘；
19. 支持手动刷新和自动刷新；
20. 显示清晰的连接错误。

---

## 13.2 第一版可以暂缓

- 多用户系统；
- 云端同步；
- 团队共享；
- Prometheus 服务端；
- Grafana 集成；
- 移动端；
- Web 公开访问；
- 自动控制或杀死服务器进程；
- Kubernetes 深度集成；
- 跨设备同步 SSH 凭据。

---

## 14. 后续版本规划

## V0.1：本地 SSH 监控

- 多服务器添加；
- SSH 并发采集；
- GPU / CPU / 内存仪表盘；
- 实时趋势和自定义采样间隔；
- 自定义历史保存时间；
- GPU 进程和当前用户占用高亮；
- 参考 `nvitop` 信息密度的独立详情页，以及左侧服务器栏和右侧二级菜单；
- SSH 密码警告与密钥配置教程；
- `nvidia-smi` 缺失检测和安装引导；
- 使用 `emilkowalski/skills` 完成 UI、动画和交互体验设计与审查；
- macOS / Windows 打包。

## V0.2：历史与通知

- SQLite 历史记录；
- 数据降采样；
- GPU 空闲通知；
- 温度告警；
- 服务器离线通知；
- CSV 数据导出。

## V0.3：高级服务器管理

- 标签和分组；
- 跳板机；
- 多 SSH Profile；
- 自定义采集命令；
- 服务器搜索和筛选；
- 指标阈值配置。

## V1.0：团队版

- 服务器 Agent；
- 中央 Collector；
- Web Dashboard；
- 用户和权限；
- 团队共享；
- 告警中心；
- Prometheus 兼容；
- Grafana 数据源；
- Slack / 邮件通知。

---

## 15. 大规模场景的 Agent 架构

当服务器达到几十台或更多时，建议引入 Agent。

```text
┌──────────────┐
│ GPU Server A │──┐
│ Local Agent  │  │
└──────────────┘  │
                  │
┌──────────────┐  │    ┌──────────────────┐
│ GPU Server B │──┼───▶│ Central Collector│
│ Local Agent  │  │    │ API + Database   │
└──────────────┘  │    └────────┬─────────┘
                  │             │
┌──────────────┐  │             ▼
│ GPU Server C │──┘        RackTop App
│ Local Agent  │
└──────────────┘
```

Agent 架构的优点：

- 指标采集更稳定；
- 应用关闭后仍可持续采集；
- 多个用户可以共享数据；
- 可以保存长期历史；
- SSH 凭据不必分发给每个客户端；
- 更容易实现权限管理；
- 更适合跨网络和跨机房部署。

---

## 16. 与 nvitop 的关系

`nvitop` 非常适合查看单台服务器的实时 GPU 状态和进程。

RackTop 不需要直接依赖 `nvitop` 才能工作。第一版可以直接解析：

- `nvidia-smi`；
- `/proc/stat`；
- `/proc/loadavg`；
- `/proc/meminfo`；
- `ps`；
- `df`。

这样服务器只需要具备：

- Linux；
- SSH；
- NVIDIA 驱动；
- `nvidia-smi`。

用户的 macOS 或 Windows 电脑也不需要安装 Python 或 `nvitop`。

后续可以选择支持调用 `nvitop` 或兼容 `nvitop-exporter`，但不应将其作为基础依赖。

---

## 17. 打包和安装

使用 Tauri 后，可以生成用户可直接安装的桌面应用。

### macOS

可生成：

```text
RackTop.app
RackTop.dmg
```

发布时建议完成：

- Apple Developer 签名；
- Hardened Runtime；
- Notarization；
- Universal Binary；
- 支持 Apple Silicon；
- 支持 Intel Mac，可根据目标用户决定。

### Windows

可生成：

```text
RackTop_x64.msi
RackTop-setup.exe
```

发布时建议完成：

- Windows 代码签名；
- x64 构建；
- 根据需要增加 ARM64；
- 安装和卸载流程；
- 自动更新支持。

### 用户端依赖

正常打包后，用户不需要额外安装：

- Node.js；
- Rust；
- Python；
- `nvitop`；
- 开发环境。

用户安装 RackTop 后即可使用。

---

## 18. 推荐项目目录

```text
RackTop/
├── .agents/
│   └── skills/                 # 由 skills CLI 管理，实际目录以安装结果为准
├── src/
│   ├── components/
│   ├── pages/
│   ├── charts/
│   ├── stores/
│   ├── hooks/
│   ├── types/
│   └── services/
├── src-tauri/
│   ├── src/
│   │   ├── ssh/
│   │   ├── collectors/
│   │   ├── parsers/
│   │   ├── storage/
│   │   ├── credentials/
│   │   ├── notifications/
│   │   └── commands/
│   ├── migrations/
│   ├── icons/
│   └── tauri.conf.json
├── tests/
├── docs/
├── package.json
├── Cargo.toml
└── README.md
```

---

## 19. 推荐 Rust 模块划分

```text
ssh/
├── config.rs
├── connection.rs
├── host_key.rs
├── pool.rs
└── retry.rs

collectors/
├── gpu.rs
├── cpu.rs
├── memory.rs
├── disk.rs
├── network.rs
└── processes.rs

parsers/
├── nvidia_smi.rs
├── proc_stat.rs
├── proc_meminfo.rs
├── proc_loadavg.rs
└── ps.rs

storage/
├── database.rs
├── samples.rs
├── retention.rs
└── aggregation.rs
```

---

## 20. 开发优先级建议

推荐按照以下顺序开发：

1. 创建 Tauri + React 项目；
2. 检查项目是否已安装 `emilkowalski/skills`，缺失时主动安装，并用 `emil-design-eng` 建立初始 UI 与交互规范；
3. 完成单台服务器 SSH 连接；
4. 检测并解析 `nvidia-smi` 输出，同时完成缺失时的提示和安装引导；
5. 解析 CPU 和内存指标；
6. 完成单台服务器状态卡片和当前用户占用高亮；
7. 增加多服务器并发；
8. 增加可自定义采样间隔的实时趋势图；
9. 增加参考 `nvitop` 信息密度的独立详情页，并实现左侧服务器栏和右侧二级菜单；
10. 使用相关 Design Skills 审查页面层级、组件选择、交互状态和动画机会；
11. 增加 SSH Config 导入；
12. 增加密码认证警告、SSH 密钥教程和凭据安全存储；
13. 增加可自定义保存时间的 SQLite 历史数据；
14. 增加托盘和通知；
15. 使用 `review-animations`、`improve-animations` 和 `apple-design` 完成交付前体验审查；
16. 构建 macOS 与 Windows 安装包；
17. 完成签名和自动更新。

开发时应优先打通一条最小链路：

```text
添加服务器
    ↓
建立 SSH
    ↓
执行 nvidia-smi
    ↓
解析数据
    ↓
显示 GPU 卡片
```

完成后再逐步增加 CPU、趋势、历史和告警。

---

## 21. 最终推荐方案

对于该项目，推荐采用以下组合：

```text
应用名称：RackTop
桌面框架：Tauri 2
前端：React + TypeScript
界面：HTML + CSS
UI / 动画设计技能：emilkowalski/skills
图表：Apache ECharts
本地后端：Rust
远程连接：SSH
指标来源：nvidia-smi + Linux /proc
本地存储：SQLite
凭据存储：Keychain / Credential Manager
发布平台：macOS + Windows
```

最终产品可以打包为：

```text
RackTop.dmg
RackTop_x64.msi
RackTop-setup.exe
```

用户安装后，可以导入 SSH Config 或手动添加服务器，然后点击“连接全部”，在一个界面中查看所有服务器的 GPU、CPU、内存、温度、功耗、进程和趋势。

---

## 22. 一句话产品定义

> RackTop 是一款面向开发者、研究人员和算力团队的跨平台桌面应用，通过 SSH 一键聚合并展示多台服务器的 GPU、CPU、内存、进程和历史趋势。

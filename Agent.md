UI、动画与交互设计技能

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
- `
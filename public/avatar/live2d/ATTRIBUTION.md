# DS鲸鱼娘 · 本工作台集成说明

本目录的模型与贴图原样取自 A8Chann/dsh-pet-live2d 发布的 npm 包 dsh-pet-live2d 3.5.0，模型包版本1.1.3。包内44个表情与8组动作均保留，没有将参考拼图当作动画。

角色原作：上善无形（OC「溟月」）；女仆二次设计：ZipZipPipe；Live2D绑定、模型、动作、表情：氵六青。美术许可 CC BY-NC-SA 4.0，原许可全文和作者说明见 ds-whale-girl/LICENSE、ds-whale-girl/pet.json 和 NOTICE.md。适用于非商业使用；商业使用需取得相应作者授权。

vendor.js 来自同一npm包，是 PixiJS 8.19.0 与 untitled-pixi-live2d-engine 1.3.5 的浏览器包，保留了文件内第三方许可。A8Chann 插件代码许可见项目根目录 LICENSES/MIT-live2d-plugin-A8Chann.txt。

Live2D Cubism Core 不在源码资源中分发，首次启用模型时由本机服务从 Live2D 官方 SDK 地址下载至 data/live2d/core.js，后续使用本机缓存。Core 权利与许可归 Live2D Inc.，保持原文件许可说明。A8Chann 插件代码许可见项目根目录 LICENSES/MIT-live2d-plugin-A8Chann.txt。

本项目集成改动：独立长场辩论场景、双角色渲染、语音口型、台词和观众回应展示；模型美术保持原样。小澜 doubao 模型的单独许可未在上游找到，见根目录 THIRD-PARTY-NOTICES.md。

上游：https://github.com/A8Chann/dsh-pet-live2d
参考：https://github.com/xkk6663/dsh-live2d-mao

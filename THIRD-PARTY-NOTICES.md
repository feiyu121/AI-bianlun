# 第三方组件与美术署名

本项目从本地 `fish-workbench` 的长场辩论实现拆分，主代码使用 AGPL-3.0（根目录 `LICENSE`）。不同组件与美术资源保留各自许可。

| 内容 | 当前路径 | 许可/来源 |
| --- | --- | --- |
| 原工作台及长场代码 | `lib/`、部分渲染与接入代码 | Fish Shift Workbench contributors，2026；上游 MIT 声明保留于 `LICENSES/MIT-upstream-app.txt` |
| 抖音采集器 | `integrations/douyin/` | bubu / saermart，派生自 DouyinLiveWebFetcher；AGPL-3.0，保留 `NOTICE.md` 与 `vendor/LICENSE` |
| Playwright | `integrations/multilive/playwright-core/` | Microsoft Corporation，Apache-2.0；保留包内 LICENSE、NOTICE、第三方声明 |
| 文本归一化 opencc-js | `lib/vendor/` | The nk2028 Project，MIT；`LICENSES/MIT-opencc-js.txt` |
| 拼音转换 pinyin-pro | `lib/vendor/` | zh-lx，MIT；`LICENSES/MIT-pinyin-pro.txt` |
| Live2D 浏览器包 | `public/avatar/live2d/vendor.js` | 来源 dsh-pet-live2d 3.5.0；包含 PixiJS 8.19.0 与 untitled-pixi-live2d-engine 1.3.5，保留内嵌许可及 `LICENSES/MIT-live2d-plugin-A8Chann.txt` |
| Live2D 渲染器的上游代码 | `public/avatar/renderer-live2d.js` | 保留上游 Fish Shift Workbench / FAYER-0610 许可声明于 `LICENSES/` |
| DS 鲸鱼娘模型 | `public/avatar/live2d/ds-whale-girl/` | CC BY-NC-SA 4.0，作者见下方；保留模型内 LICENSE、pet.json 和根目录许可副本 |
| 小澜（doubao 2.0）模型 | `public/avatar/live2d/doubao/` | 从原项目复制。上游未提供该模型的单独许可与作者声明，不能据此推定模型为 MIT 或 AGPL |
| 便携 Python 与 Python 库 | `runtime/python/` | 随当前工作副本保留，未纳入版本管理；各包许可见其 `.dist-info` 与 Python 随附许可，版本声明见 `requirements.txt` |

## 鲸鱼娘美术的法定署名

- 角色原作「溟月」：**上善无形**，https://www.pixiv.net/users/62155430
- DeepSeek 女仆鲸鱼娘二次设计：**ZipZipPipe**，https://www.pixiv.net/users/18604994
- Live2D 模型、绑定、动作、表情：**氵六青**，https://space.bilibili.com/11272072
- 模型发布与插件来源：https://github.com/A8Chann/dsh-pet-live2d

模型包版本 1.1.3，来源 npm 包 dsh-pet-live2d 3.5.0。模型、贴图、动作与表情原样复用，本次仅调整外围渲染与场景集成代码，未修改美术。美术许可为 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh)：署名、非商业、相同方式共享。商业用途需获得相应版权所有人的授权。

## Live2D Core

Live2D Cubism Core 为 Live2D Inc. 专有软件，不作为源码资源分发。首次打开角色场景时，服务从 Live2D 官方 SDK 地址下载到 `data/live2d/core.js`，此目录已加入忽略规则。分发本项目时不要携带该缓存。

## 本次改动与未保留内容

新建独立长场编排服务、工作台与 OBS 场景，调整长场播放器、语音取消、投票轮转与模型并发逻辑。删除与打工、休息室、短场现编、点歌、舞蹈视频及音效相关的代码与素材，不再沿用这些已删除内容的许可清单。小澜模型保留用于当前本地验证；公开分发或商业使用前请补齐其授权或换成自有模型。

# 抖音接收组件

worker.py 及 vendor/ 按 AGPL-3.0 分发。通过 stdin/stdout JSONL 与工作台通信。

协议与签名组件来自 https://github.com/saermart/DouyinLiveWebFetcher ，2026-10-28 获取。
原作者：bubu / saermart。保留原始生成代码、完整许可证与协议源文件。
vendor/LICENSE 是完整 AGPL-3.0 文本。本目录源码包含在源码包内。

平台接口属于非官方网页协议，平台调整时可能需要更新此独立组件。
connected 仅在 WebSocket 握手完成后报告；离线及连接异常均如实返回。

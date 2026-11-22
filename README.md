# role-wake

给角色一个克制的「自己的小心思」：用户不在时，想念、分享欲、担心、好奇会随沉默慢慢上涨；超过阈值后，Worker 才会让模型判断这一刻要不要主动发一两句。

本项目借鉴了 [WrenWen](https://github.com/ssxl0126/WrenWen) 文档中关于“驱动条 / 唤醒回合 / 静默与频率闸”的思路，但没有复制其代码，也没有接入其九维系统。这里采用精简的四种心思和 Cloudflare Worker + KV + Cron。

## 当前状态

代码已经写好并通过本地单测，但**尚未部署**。本仓库不包含任何账号、模型密钥、KV ID 或 VAPID 私钥。

## 部署前准备

1. 创建一个 Cloudflare KV namespace，例如：

   ```sh
   npx wrangler kv namespace create WAKE_STATE
   npx wrangler kv namespace create WAKE_STATE --preview
   ```

2. 把返回的两个 ID 填入 `wrangler.toml` 的 `id` 和 `preview_id`。
3. 设置 Worker secrets：

   ```sh
   npx wrangler secret put WAKE_KEY
   npx wrangler secret put LLM_BASE
   npx wrangler secret put LLM_MODEL
   npx wrangler secret put LLM_KEY
   ```

   `LLM_BASE` 填 OpenAI 兼容 API 的 `/v1` 根地址，例如 `https://example.com/v1`；Worker 会请求 `${LLM_BASE}/chat/completions`。密钥只存在 Cloudflare，不进 Git。
4. 部署：

   ```sh
   npx wrangler deploy
   ```

   `wrangler.toml` 已配置每 30 分钟一次的 Cron：`*/30 * * * *`。

## 接口

所有接口都要求：

```http
Authorization: Bearer <WAKE_KEY>
```

### `POST /sync`

App 每次主聊天结束后调用，只发送摘要，不发送全文：

```json
{
  "roleId": "gu-qiyan",
  "roleName": "顾祁砚",
  "personaSummary": "角色设定摘要，最多 6000 字",
  "recentSummary": "最近聊天摘要，最多 4000 字",
  "lastChatAt": 1795348800000,
  "pushDevice": "推送已开启时的本机 device",
  "pushUrl": "https://你的 App 页面地址/"
}
```

### `GET /inbox?roleId=gu-qiyan`

App 打开时读取该角色的主动消息。读取成功后该角色收件箱会被消费，避免反复插入；客户端如果请求超时，应在确认收到响应后再重试。

### `GET /state?roleId=gu-qiyan`

返回四种心思的公开调试状态、今日已发数量和收件箱数量，不返回模型密钥或完整摘要。

## 规则

- 北京时间 00:30–08:00 不发。
- 距上次聊天不足 30 分钟不发。
- 两条主动消息至少间隔 3 小时。
- 每个角色每天最多 4 条。
- 最高心思低于 0.65 时不调用模型。
- 模型返回「不发」时不会写入收件箱，也不会算主动消息。
- 模型请求 10 秒超时；未配置模型密钥时只涨心思、不发消息。
- 每个角色一份 KV 状态；角色 ID 只来自已签名的 `/sync`，不会从公开请求创建。

## 推送

顾祁砚和惟境现有 App 已经接入 `push.zhouweiweihome.top`，但该推送服务源码不在本仓库。推送开启时，App 在 `/sync` 提交本机 `pushDevice` 和页面地址 `pushUrl`；Worker 生成主动消息后复用 `/schedule` 立即发通知，同时仍把消息写进 `/inbox`。推送失败不会影响收件箱；App 打开时按消息唯一 ID 去重。Worker 不自带 VAPID，避免与现有推送服务产生两套订阅和重复消息。

## 测试

```sh
npm test
```

测试覆盖心思涨落、聊天后回落、北京时间静默时段、三小时最小间隔、每日上限、阈值、模型“不发”分支，以及有无 device、推送失败仍写入 inbox 和唯一消息 ID。

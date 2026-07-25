# Kling 3.0 Omni 请求规范

## 本包固定规则

- 模型：Kling 3.0 Omni。
- 模式：多参考图视频。
- 输入：`prompt` + `refer_image`。
- 禁止：`first_frame`、`last_frame`、参考视频。
- 画幅：`1:1`。
- 分辨率：`1080p`。
- 声音：`native`。
- 任务时长：3–15 秒；任务内所有镜头时长之和必须等于 `settings.duration`。
- 多镜任务：`multi_shot: true`；每个镜头至少 1 秒，本包实际为 4–8 秒。
- 每个任务不超过 3 镜；每镜最多一位说话者。
- 无参考视频时，参考图和多图主体总数不超过 7。
- 完整 Prompt 建议不超过 2500 个字符；单镜描述控制在 512 字符内。
- 角色参考图必须是拟人猫人/犬人设定图；视频 Prompt 必须重复双足直立、完整动物头脸、覆毛五指手、固定服装和单条尾巴，不能只写角色名字。

## 通用请求骨架

下方只是字段结构。实际使用时，必须把对应镜头文件中的“完整 Omni Prompt”原样放入 `text`，并只加入该文件列出的参考图。

```json
{
  "contents": [
    {
      "type": "prompt",
      "text": "粘贴该任务文件中的完整 Omni Prompt"
    },
    {
      "type": "refer_image",
      "url": "https://your-cdn.example/IMG-001-lihua.png",
      "id": "lihua"
    }
  ],
  "settings": {
    "multi_shot": true,
    "audio": "native",
    "resolution": "1080p",
    "aspect_ratio": "1:1",
    "duration": 15
  },
  "options": {
    "external_task_id": "sheng-tian-ban-zi-vid-001",
    "watermark_info": {
      "enabled": false
    }
  }
}
```

## 提交前检查

1. Prompt 里的每个 `@id` 都存在于 `contents`。
2. `contents` 里没有 Prompt 未使用的多余参考图。
3. 没有 `first_frame`、`last_frame` 或参考视频字段。
4. `aspect_ratio` 是 `1:1`。
5. `duration` 与镜头秒数之和一致，且在 3–15 秒。
6. `audio` 是 `native`。
7. 台词已逐字放在 Prompt 内，并注明说话人、声线、普通话、口型同步。

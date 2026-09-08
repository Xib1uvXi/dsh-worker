const titles: Record<string, string> = {
  "runtime/waiting": "等待运行时事件",
  "subagent/started": "子 Agent 已启动",
  "runtime/running": "正在执行",
  "runtime/idle": "等待后续指令",
  "subagent/ended": "子 Agent 已结束",
  "subagent/error": "子 Agent 执行失败",
  "tool/received": "已收到工具结果",
  "assistant/replied": "Agent 已回复",
  "execution/ended": "执行已结束",
  "execution/interrupted": "控制器中断，需恢复",
  "runtime/closed": "所属执行已结束，运行时已关闭",
  "runtime/interrupted": "连接中断，需核对执行状态",
  "tool/error": "工具执行失败",
  "turn/start": "开始执行轮次",
  "turn/end": "轮次结束",
  "step/start": "模型正在处理",
  "step/end": "模型步骤结束",
  "user/message": "用户 / 上下文消息",
  "assistant/message": "Agent 回复",
  "tool/call": "调用工具",
  "tool/result": "工具结果",
  "agent/inbox/spliced": "指令队列变更",
  "compaction/start": "压缩上下文",
  "compaction/end": "上下文压缩结束",
  "llm/retry": "模型请求重试",
  "llm/retry-started": "开始重试",
};
export function trajectoryLabel(value: string) {
  const [key, ...suffix] = value.split(" · ");
  return [titles[key!] ?? key, ...suffix].join(" · ");
}

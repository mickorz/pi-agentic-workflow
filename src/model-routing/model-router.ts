/**
 * Model Router（MR-001~007）：tier 契约 + 池配置 + 决策函数 + 决策记录
 * LK-02（抽取路径）：策略借鉴 pi-bifrost routing.ts（first/cheapest 等），实现独立、契约稳定。
 * 优先级（§8）：显式物理模型 > 节点 tier > Workflow 默认 > run 默认。
 * 不改 DSL 语义：以 PiAgentAdapter 之前的解析层接入（P1 T5）。
 */

import type { ModelRoutingDecision, ModelTier } from "../contracts/wx.js";

export interface ModelPoolConfig {
  /** tier → 模型 spec 列表（有序，first 策略取首个可用） */
  pools: Partial<Record<ModelTier, string[]>>;
  defaultTier: ModelTier;
  /** 兜底模型（池全不可用时） */
  fallbackModel?: string;
}

/** 可用模型查询接口（注入：真实=ModelRuntime.getAvailable；测试=fake 列表） */
export interface ModelAvailability {
  listAvailable(): Promise<string[]>;
}

export class ModelRouter {
  private readonly decisions: ModelRoutingDecision[] = [];

  constructor(
    private readonly config: ModelPoolConfig,
    private readonly availability: ModelAvailability,
  ) {}

  /**
   * 决策（MR-003：显式模型不被覆盖；MR-004：池内降级）。
   * 返回 null = 无可用模型（调用方明确失败，不虚构）。
   */
  async decide(
    input: { runId: string; nodeId: string; model?: string; tier?: ModelTier },
    options?: { record?: boolean },
  ): Promise<ModelRoutingDecision | null> {
    const available = new Set(await this.availability.listAvailable());
    const now = new Date().toISOString();

    // 1) 显式物理模型（最高优先级，不覆盖）
    if (input.model) {
      const ok = available.size === 0 || available.has(input.model);
      const decision: ModelRoutingDecision = {
        nodeId: input.nodeId,
        runId: input.runId,
        requestedModel: input.model,
        actualModel: input.model,
        routeSource: "explicit-model",
        decidedAt: now,
      };
      if (ok) return this.maybeRecord(decision, options);
      // 显式模型不可用：明确失败语义交由上层（agent 重试/闸门），不静默换模
      return this.maybeRecord({ ...decision, actualModel: input.model, routeSource: "explicit-model" }, options);
    }

    // 2) 节点 tier → 池内首个可用（first 策略）
    const tier = input.tier ?? this.config.defaultTier;
    const pool = this.config.pools[tier] ?? [];
    for (const spec of pool) {
      if (available.size === 0 || available.has(spec)) {
        return this.maybeRecord(
          {
            nodeId: input.nodeId,
            runId: input.runId,
            requestedTier: tier,
            actualModel: spec,
            routeSource: "node-tier",
            decidedAt: now,
          },
          options,
        );
      }
    }

    // 3) 池全不可用 → fallback（MR-004 降级）
    if (this.config.fallbackModel) {
      return this.maybeRecord(
        {
          nodeId: input.nodeId,
          runId: input.runId,
          requestedTier: tier,
          actualModel: this.config.fallbackModel,
          routeSource: "fallback",
          decidedAt: now,
        },
        options,
      );
    }
    return null;
  }

  /** run 级默认模型（Dispatcher 启动时注入 PiAgentAdapter defaultModel） */
  runDefaultModel(): string | undefined {
    return this.config.pools[this.config.defaultTier]?.[0] ?? this.config.fallbackModel;
  }

  /** 决策记录（MR-006：nodeId→requestedTier→actualModel→routeSource 可追溯） */
  records(runId?: string): ModelRoutingDecision[] {
    return runId ? this.decisions.filter((d) => d.runId === runId) : [...this.decisions];
  }

  private maybeRecord(decision: ModelRoutingDecision, options?: { record?: boolean }): ModelRoutingDecision {
    if (options?.record !== false) this.decisions.push(decision);
    return decision;
  }
}

/**
 * 模型解析器："provider/modelId" 或裸 "modelId" → Pi SDK Model 对象
 *
 * 规则：
 *  - 无 spec → undefined（用会话默认模型）
 *  - "provider/modelId" → modelRuntime.getModel(provider, modelId)
 *  - 裸 "modelId" → 在可用模型中按 id 精确匹配（唯一命中才用）
 *  - 找不到 → 抛错（缺模型必须是失败态，不静默回退）
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";

export class ModelResolver {
  private runtime?: ModelRuntime;
  private readonly cache = new Map<string, Model<any>>();
  private availableIds?: Map<string, Model<any>>;

  private async ensureRuntime(): Promise<ModelRuntime> {
    if (!this.runtime) {
      this.runtime = await ModelRuntime.create();
    }
    return this.runtime;
  }

  /** 解析模型 spec；找不到抛错（供 fail-fast） */
  async resolve(spec: string): Promise<Model<any>> {
    const cached = this.cache.get(spec);
    if (cached) return cached;

    const runtime = await this.ensureRuntime();

    // 形式 1：provider/modelId
    const slash = spec.indexOf("/");
    if (slash > 0) {
      const provider = spec.slice(0, slash);
      const id = spec.slice(slash + 1);
      const model = runtime.getModel(provider, id);
      if (!model) throw new Error(`model not found: "${spec}"（provider=${provider}, id=${id}）`);
      this.cache.set(spec, model);
      return model;
    }

    // 形式 2：裸 modelId——在已配置/可用模型中按 id 匹配
    if (!this.availableIds) {
      this.availableIds = new Map();
      for (const model of await runtime.getAvailable()) {
        // 首个命中优先（getAvailable 顺序稳定）；同名不同 provider 时应写全 spec
        if (!this.availableIds.has(model.id)) this.availableIds.set(model.id, model);
      }
    }
    const found = this.availableIds.get(spec);
    if (!found) {
      throw new Error(
        `model not found: "${spec}"（裸 id 在可用模型中未命中；请用 "provider/modelId" 全称，或检查 API key 配置）`,
      );
    }
    this.cache.set(spec, found);
    return found;
  }

  /** 有可用模型凭证时返回 true（集成测试跳过判定用） */
  async hasCredentials(): Promise<boolean> {
    try {
      const runtime = await this.ensureRuntime();
      return (await runtime.getAvailable()).length > 0;
    } catch {
      return false;
    }
  }
}

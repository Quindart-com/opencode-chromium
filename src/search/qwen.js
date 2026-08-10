import { SEMANTIC_MODELS, prepareSemanticModel, semanticStatus } from "../../native-host/src/semantic-search.js";

export const QWEN_MODEL_ID = "qwen3-0.6b-retrieval";

export function qwenModel() {
  return SEMANTIC_MODELS.find((model) => model.id === QWEN_MODEL_ID) ?? null;
}

export { prepareSemanticModel, semanticStatus };

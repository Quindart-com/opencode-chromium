import { SEMANTIC_MODELS, prepareSemanticModel, semanticStatus } from "../../native-host/src/semantic-search.js";

export const SNOWFLAKE_MODEL_ID = "snowflake-arctic-embed-xs";

export function snowflakeModel() {
  return SEMANTIC_MODELS.find((model) => model.id === SNOWFLAKE_MODEL_ID) ?? null;
}

export { prepareSemanticModel, semanticStatus };

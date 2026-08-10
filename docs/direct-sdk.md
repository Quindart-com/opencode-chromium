# Direct SDK adapters

```js
import { createBrowserAgent } from "opencode-browser-plugin/sdk";
import { openAITools } from "opencode-browser-plugin/sdk";

const agent = createBrowserAgent();
const openaiTools = openAITools({ runtime: agent.runtime });
```

The SDK exports OpenAI, Anthropic, Gemini, and MCP schema adapters. Each adapter is generated from the same core registry and dispatches through the same runtime.

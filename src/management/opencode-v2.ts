/** Directory entry for OpenCode V2; keeps the stable launcher shared with V1. */
export const opencodeV2Launcher = `import { opencodeV2Plugin } from '../plugin.mjs';
export default {
  id: opencodeV2Plugin.id,
  async setup(ctx) {
    const bridge = Object.create(ctx);
    bridge.tools = {
      add(name, tool) {
        return ctx.tool.transform(editor => editor.add({
          name, description: tool.description, input: tool.inputSchema,
          async execute(input, context) {
            const result = await tool.execute(input, context);
            return { content: result.output, attachments: result.attachments };
          }
        }));
      }
    };
    return opencodeV2Plugin.setup(bridge);
  }
};
`;

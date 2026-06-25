import type {
  IDataObject,
  IExecuteFunctions,
  IHttpRequestOptions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

/**
 * n8n node for Sakana Fugu. Uses a custom `execute()` (rather than declarative `routing`) so
 * the output is shaped for downstream nodes — a clean `text` field alongside
 * `model`/`status`/`usage` and the untouched `raw` response — instead of forcing every
 * workflow to add a Set node to dig `output_text` out of the API JSON. Each input item is
 * processed independently and honours the node's "Continue On Fail" toggle. Auth (the Bearer
 * header) is injected by the `Fugu API` credential via `httpRequestWithAuthentication`, so no
 * key handling lives here and the node stays self-contained (no core-client dependency).
 */
export class Fugu implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Fugu",
    name: "fugu",
    icon: "file:fugu.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: "Call Sakana Fugu — a single endpoint that orchestrates a pool of frontier models",
    defaults: { name: "Fugu" },
    // Lets the Fugu node be attached as a tool to an n8n AI Agent (a "second opinion" tool).
    usableAsTool: true,
    inputs: ["main"],
    outputs: ["main"],
    credentials: [{ name: "fuguApi", required: true }],
    properties: [
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        options: [
          {
            name: "Respond",
            value: "respond",
            action: "Ask Fugu (Responses API)",
            description: "Single-prompt generation via the Responses API",
          },
          {
            name: "Chat",
            value: "chat",
            action: "Chat with Fugu (Chat Completions)",
            description: "Multi-turn chat via the Chat Completions API",
          },
        ],
        default: "respond",
      },
      {
        displayName: "Model",
        name: "model",
        type: "options",
        options: [
          { name: "Fugu (fast)", value: "fugu" },
          { name: "Fugu Ultra (max quality)", value: "fugu-ultra" },
        ],
        default: "fugu-ultra",
      },
      {
        displayName: "Input",
        name: "input",
        type: "string",
        typeOptions: { rows: 4 },
        default: "",
        required: true,
        displayOptions: { show: { operation: ["respond"] } },
      },
      {
        displayName: "Reasoning Effort",
        name: "effort",
        type: "options",
        options: [
          { name: "Model Default", value: "" },
          { name: "High", value: "high" },
          { name: "X-High", value: "xhigh" },
          { name: "Max", value: "max" },
        ],
        default: "",
        description:
          'Reasoning effort. "Model Default" omits it so Fugu uses its own default — matching the core client, which only sends reasoning when set.',
        displayOptions: { show: { operation: ["respond"] } },
      },
      {
        displayName: "Messages (JSON)",
        name: "messages",
        type: "json",
        default: '[\n  { "role": "user", "content": "Hello, Fugu." }\n]',
        required: true,
        description: "Array of chat messages ({ role, content }).",
        displayOptions: { show: { operation: ["chat"] } },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];

    const credentials = await this.getCredentials("fuguApi");
    const baseUrl = String(credentials.baseUrl || "https://api.sakana.ai/v1").replace(/\/+$/, "");

    for (let i = 0; i < items.length; i++) {
      try {
        const operation = this.getNodeParameter("operation", i) as string;
        const model = this.getNodeParameter("model", i) as string;

        let url: string;
        const body: IDataObject = { model };
        if (operation === "respond") {
          body.input = this.getNodeParameter("input", i) as string;
          const effort = this.getNodeParameter("effort", i, "") as string;
          // Send `reasoning` only when set, so "Model Default" lets Fugu pick (matches core).
          if (effort) body.reasoning = { effort };
          url = `${baseUrl}/responses`;
        } else {
          body.messages = parseMessages(this.getNodeParameter("messages", i), this, i);
          url = `${baseUrl}/chat/completions`;
        }

        const options: IHttpRequestOptions = { method: "POST", url, body, json: true };
        const response = (await this.helpers.httpRequestWithAuthentication.call(
          this,
          "fuguApi",
          options,
        )) as IDataObject;

        out.push({ json: shapeResponse(operation, model, response), pairedItem: { item: i } });
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({
            json: { error: error instanceof Error ? error.message : String(error) },
            pairedItem: { item: i },
          });
          continue;
        }
        // Already a NodeOperationError (e.g. bad Messages JSON) — keep its itemIndex context.
        if (error instanceof NodeOperationError) throw error;
        throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
      }
    }

    return [out];
  }
}

/** Parse the Messages field, which n8n may hand us as a JSON string or an already-parsed value. */
function parseMessages(raw: unknown, ctx: IExecuteFunctions, itemIndex: number): IDataObject[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new NodeOperationError(ctx.getNode(), "Messages must be valid JSON.", {
        itemIndex,
        description: 'Provide an array of objects like [{ "role": "user", "content": "..." }].',
      });
    }
  }
  if (!Array.isArray(value)) {
    throw new NodeOperationError(ctx.getNode(), "Messages must be a JSON array of { role, content }.", {
      itemIndex,
    });
  }
  return value as IDataObject[];
}

/** Shape either API response into a clean row: a `text` field + metadata + the raw payload. */
function shapeResponse(operation: string, model: string, response: IDataObject): IDataObject {
  const text = operation === "chat" ? chatText(response) : responsesText(response);
  return {
    text,
    model: typeof response.model === "string" ? response.model : model,
    status: response.status ?? null,
    usage: response.usage ?? null,
    raw: response,
  };
}

/** Extract assistant text from a Responses API payload (`output_text`, else walk `output[]`). */
function responsesText(response: IDataObject): string {
  if (typeof response.output_text === "string") return response.output_text;
  const output = Array.isArray(response.output) ? response.output : [];
  const parts: string[] = [];
  for (const item of output) {
    const content = (item as IDataObject)?.content;
    if (!Array.isArray(content)) continue;
    for (const chunk of content) {
      const t = (chunk as IDataObject)?.text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("");
}

/** Extract assistant text from a Chat Completions payload (`choices[0].message.content`). */
function chatText(response: IDataObject): string {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const message = (choices[0] as IDataObject | undefined)?.message as IDataObject | undefined;
  return typeof message?.content === "string" ? message.content : "";
}

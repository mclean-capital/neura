export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  /** Array-type parameters may carry an `items` schema. */
  items?: ToolParameter;
  /** Object-type parameters may nest a `properties` map + `required`. */
  properties?: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

export interface ToolCallResult {
  result?: unknown;
  error?: string;
}

export interface VisionToolArgs {
  focus?: string;
  detail?: 'brief' | 'detailed';
}

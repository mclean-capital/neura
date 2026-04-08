export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
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

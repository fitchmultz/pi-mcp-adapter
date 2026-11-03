/** Event sink shared by runtime state and status publication. */
export interface McpStatusEventBus {
  emit: (channel: string, data: unknown) => void;
}
